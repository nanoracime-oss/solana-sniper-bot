import {
  BigNumberish,
  Liquidity,
  LIQUIDITY_STATE_LAYOUT_V4,
  LiquidityPoolKeys,
  LiquidityStateV4,
  MARKET_STATE_LAYOUT_V3,
  MarketStateV3,
  Token,
  TokenAmount,
} from '@raydium-io/raydium-sdk';
import {
  AccountLayout,
  createAssociatedTokenAccountIdempotentInstruction,
  createCloseAccountInstruction,
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import {
  Keypair,
  Connection,
  PublicKey,
  ComputeBudgetProgram,
  KeyedAccountInfo,
  TransactionMessage,
  VersionedTransaction,
  Commitment,
} from '@solana/web3.js';
import { retry, getTokenAccounts, RAYDIUM_LIQUIDITY_PROGRAM_ID_V4, OPENBOOK_PROGRAM_ID, createPoolKeys, retrieveEnvVariable, retrieveTokenValueByAddress } from './core/tokens';
import { getMinimalMarketV3, MinimalMarketLayoutV3, getRugCheck } from './core/tokens';
import { MintLayout } from './core/mint';
import bs58 from 'bs58';
import * as fs from 'fs';
import * as path from 'path'; 
import { logger } from './core/logger';

// @ts-ignore
const TelegramBot = require('node-telegram-bot-api');
// @ts-ignore
const mongoose = require('mongoose');

// ==========================================
// الإعدادات الديناميكية (Dynamic Settings)
// ==========================================
let isBotRunning = false; 
let DYNAMIC_TP = Number(retrieveEnvVariable('TAKE_PROFIT', logger));
let DYNAMIC_SL = Number(retrieveEnvVariable('STOP_LOSS', logger));
let DYNAMIC_BUY_AMOUNT = retrieveEnvVariable('BUY_AMOUNT', logger);

// ==========================================
// نظام إدارة الحالة (State Management)
// ==========================================
let tgBot: any;
const adminChatId = process.env.TELEGRAM_CHAT_ID;
const PUBLIC_CHANNEL = process.env.PUBLIC_CHANNEL_ID || ""; // أضف معرف قناتك لاحقاً هنا
const userStates: Record<string, string> = {}; 

// ==========================================
// هندسة قاعدة البيانات (MongoDB Schemas)
// ==========================================
const UserSchema = new mongoose.Schema({
    chatId: { type: String, unique: true },
    walletAddress: String,
    balance: { type: Number, default: 0 },
    activeInvestment: { type: Number, default: 0 },
    referredBy: String,
    referralEarnings: { type: Number, default: 0 },
    createdAt: { type: Date, default: Date.now }
});
const User = mongoose.model('User', UserSchema);

// ==========================================
// المحرك التفاعلي (Telegram SaaS Engine)
// ==========================================
async function setupDashboard() {
  const mongoUri = process.env.MONGODB_URI;
  if (mongoUri) {
      try {
          await mongoose.connect(mongoUri);
          logger.info("✅ Connected to MongoDB!");
      } catch(e) {
          logger.error("MongoDB Connection Error:", e);
      }
  }

  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (token) {
      tgBot = new TelegramBot(token, {polling: true});

      // --- واجهة المدير (Admin Dashboard) ---
      const sendAdminMenu = (chatId: string) => {
          const options = {
              reply_markup: {
                  inline_keyboard: [
                      [{ text: isBotRunning ? '🛑 إيقاف القناص' : '▶️ تشغيل القناص', callback_data: 'toggle_sniper' }],
                      [{ text: `تعديل الربح (${DYNAMIC_TP}%)`, callback_data: 'edit_tp' }, { text: `تعديل المخاطرة (${DYNAMIC_SL}%)`, callback_data: 'edit_sl' }],
                      [{ text: `مبلغ الشراء (${DYNAMIC_BUY_AMOUNT} SOL)`, callback_data: 'edit_buy' }],
                      [{ text: '📡 إرسال رسالة للمستثمرين', callback_data: 'broadcast_msg' }],
                      [{ text: '👥 إدارة العملاء', callback_data: 'admin_users' }, { text: '💰 الرادار المالي', callback_data: 'admin_radar' }]
                  ]
              }
          };
          tgBot.sendMessage(chatId, "👑 <b>غرفة العمليات المركزية</b>\nتحكم في نظامك بالكامل من هنا:", {parse_mode: 'HTML', ...options});
      };

      // --- واجهة المستثمر (Investor Dashboard) ---
      const sendUserMenu = async (chatId: string, refCode?: string) => {
          let user = await User.findOne({ chatId });
          if (!user) {
              user = new User({ chatId, referredBy: refCode || "none" });
              await user.save();
              if(adminChatId) tgBot.sendMessage(adminChatId, `👥 مستثمر جديد انضم للمنصة!`);
          }

          const options = {
              reply_markup: {
                  inline_keyboard: [
                      [{ text: '🚀 استثمر الآن (ربح 50% / 24س)', callback_data: 'user_invest' }],
                      [{ text: '💰 رصيدي', callback_data: 'user_balance' }, { text: '💸 سحب الأرباح', callback_data: 'user_withdraw' }],
                      [{ text: '🔗 رابط الإحالة (شارك واربح 5%)', callback_data: 'user_referral' }]
                  ]
              }
          };
          tgBot.sendMessage(chatId, `👋 <b>أهلاً بك في منصة القنص الذكي!</b>\n\nصندوق استثماري يعمل بالذكاء الاصطناعي لاقتناص عملات السولانا وتحقيق أرباح يومية.\n\nاختر من القائمة أدناه:`, {parse_mode: 'HTML', ...options});
      };

      // استلام الأوامر النصية
      tgBot.onText(/\/start(.*)/, (msg: any, match: any) => {
          const chatId = msg.chat.id.toString();
          const refCode = match[1] ? match[1].trim() : undefined;

          if (chatId === adminChatId) {
              sendAdminMenu(chatId);
          } else {
              sendUserMenu(chatId, refCode);
          }
      });

      // التقاط الرسائل النصية للإعدادات الديناميكية والردود
      tgBot.on('message', async (msg: any) => {
          const chatId = msg.chat.id.toString();
          const text = msg.text;
          if (!text || text.startsWith('/')) return;

          const state = userStates[chatId];
          if (!state) return;

          if (chatId === adminChatId) {
              if (state === 'WAITING_FOR_TP') {
                  DYNAMIC_TP = Number(text);
                  tgBot.sendMessage(chatId, `✅ تم تحديث نسبة الربح إلى: ${DYNAMIC_TP}%`);
              } else if (state === 'WAITING_FOR_SL') {
                  DYNAMIC_SL = Number(text);
                  tgBot.sendMessage(chatId, `✅ تم تحديث نسبة وقف الخسارة إلى: ${DYNAMIC_SL}%`);
              } else if (state === 'WAITING_FOR_BUY_AMT') {
                  DYNAMIC_BUY_AMOUNT = text;
                  updateQuoteAmount(); // دالة لتحديث كمية الشراء في المحرك
                  tgBot.sendMessage(chatId, `✅ تم تحديث مبلغ الشراء إلى: ${DYNAMIC_BUY_AMOUNT} SOL`);
              } else if (state === 'WAITING_FOR_BROADCAST') {
                  const users = await User.find({});
                  let count = 0;
                  for(let u of users) {
                      if(u.chatId !== adminChatId) {
                          tgBot.sendMessage(u.chatId, `📢 <b>إعلان من الإدارة:</b>\n${text}`, {parse_mode: 'HTML'}).catch(()=>{});
                          count++;
                      }
                  }
                  tgBot.sendMessage(chatId, `✅ تم إرسال الرسالة إلى ${count} مستثمر.`);
              }
              delete userStates[chatId];
              setTimeout(() => sendAdminMenu(chatId), 1000);
          } else {
              if (state === 'WAITING_FOR_TX_HASH') {
                  tgBot.sendMessage(chatId, `⏳ جاري التحقق من المعاملة في شبكة سولانا...\n<code>${text}</code>\n\n<i>(النظام في وضع التجربة حالياً، سيتم تأكيد الإيداع التلقائي في التحديث القادم)</i>`, {parse_mode: 'HTML'});
                  delete userStates[chatId];
              }
          }
      });

      // التفاعل مع الأزرار (Callback Queries)
      tgBot.on('callback_query', async (query: any) => {
          const chatId = query.message.chat.id.toString();
          const data = query.data;

          // --- أزرار الإدارة ---
          if (chatId === adminChatId) {
              if (data === 'toggle_sniper') {
                  isBotRunning = !isBotRunning;
                  tgBot.sendMessage(chatId, isBotRunning ? "🟢 <b>تم تشغيل القناص!</b>" : "🔴 <b>تم إيقاف القناص!</b>", {parse_mode: 'HTML'});
                  sendAdminMenu(chatId);
              }
              else if (data === 'edit_tp') {
                  userStates[chatId] = 'WAITING_FOR_TP';
                  tgBot.sendMessage(chatId, "أرسل نسبة الربح الجديدة (مثال: 100):");
              }
              else if (data === 'edit_sl') {
                  userStates[chatId] = 'WAITING_FOR_SL';
                  tgBot.sendMessage(chatId, "أرسل نسبة وقف الخسارة (مثال: -30):");
              }
              else if (data === 'edit_buy') {
                  userStates[chatId] = 'WAITING_FOR_BUY_AMT';
                  tgBot.sendMessage(chatId, "أرسل مبلغ الشراء الجديد بالسولانا (مثال: 0.1):");
              }
              else if (data === 'broadcast_msg') {
                  userStates[chatId] = 'WAITING_FOR_BROADCAST';
                  tgBot.sendMessage(chatId, "أرسل الرسالة التي تريد تعميمها لجميع المستثمرين:");
              }
              else if (data === 'admin_radar') {
                  try {
                      const balance = await solanaConnection.getBalance(wallet.publicKey);
                      const totalUsers = await User.countDocuments();
                      tgBot.sendMessage(chatId, `📊 <b>الرادار المالي:</b>\n\nرصيد السيرفر الرئيسي: <code>${(balance / 1e9).toFixed(5)} SOL</code>\nعدد العملاء المسجلين: ${totalUsers}`, {parse_mode: 'HTML'});
                  } catch(e) {}
              }
          } 
          // --- أزرار المستثمرين ---
          else {
              let user = await User.findOne({ chatId });
              if (data === 'user_invest') {
                  const depositAddress = wallet.publicKey.toString(); // عنوان محفظتك
                  tgBot.sendMessage(chatId, `🚀 <b>خطة 24 ساعة (ربح مستهدف 50%)</b>\n\nللبدء، قم بإرسال السولانا (SOL) إلى محفظة المنصة الآمنة:\n\n<code>${depositAddress}</code>\n\nالحد الأدنى للاستثمار: 0.1 SOL\n\n⚠️ <b>بعد الإرسال:</b> اضغط على الزر أدناه لتأكيد الإيداع.`, {
                      parse_mode: 'HTML',
                      reply_markup: { inline_keyboard: [[{ text: '✅ تأكيد الإيداع (إرسال Hash)', callback_data: 'confirm_deposit' }]] }
                  });
              }
              else if (data === 'confirm_deposit') {
                  userStates[chatId] = 'WAITING_FOR_TX_HASH';
                  tgBot.sendMessage(chatId, "يرجى إرسال شفرة المعاملة (TX Hash) للتحقق منها فوراً من شبكة البلوكشين:");
              }
              else if (data === 'user_balance') {
                  tgBot.sendMessage(chatId, `💰 <b>محفظتك الاستثمارية:</b>\n\nالرصيد المتاح للسحب: <code>${user?.balance || 0} SOL</code>\nالاستثمار النشط: <code>${user?.activeInvestment || 0} SOL</code>\nأرباح الإحالة: <code>${user?.referralEarnings || 0} SOL</code>`, {parse_mode: 'HTML'});
              }
              else if (data === 'user_referral') {
                  const botUsername = (await tgBot.getMe()).username;
                  const refLink = `https://t.me/${botUsername}?start=${chatId}`;
                  tgBot.sendMessage(chatId, `🔗 <b>نظام الإحالة الفيروسي:</b>\n\nشارك هذا الرابط مع أصدقائك واحصل على <b>5% عمولة</b> من أي إيداع يقومون به، تضاف لرصيدك فوراً!\n\nرابطك الخاص:\n<code>${refLink}</code>`, {parse_mode: 'HTML'});
              }
          }
          tgBot.answerCallbackQuery(query.id);
      });
  }
}

// دالة إرسال الإشعارات للقناة العامة (الشفافية) والمدير
function broadcastToChannelAndAdmin(text: string) {
  if (!tgBot) return;
  if (adminChatId) tgBot.sendMessage(adminChatId, text, { parse_mode: 'HTML', disable_web_page_preview: true }).catch(()=>{});
  if (PUBLIC_CHANNEL) tgBot.sendMessage(PUBLIC_CHANNEL, text, { parse_mode: 'HTML', disable_web_page_preview: true }).catch(()=>{});
}
// ==========================================

const network = 'mainnet-beta';
const RPC_ENDPOINT = retrieveEnvVariable('RPC_ENDPOINT', logger);
const RPC_WEBSOCKET = retrieveEnvVariable('RPC_WEBSOCKET', logger);

const solanaConnection = new Connection(RPC_ENDPOINT, {
  wsEndpoint: RPC_WEBSOCKET,
});

export type MinimalTokenAccountData = {
  mint: PublicKey;
  address: PublicKey;
  buyValue?: number;
  poolKeys?: LiquidityPoolKeys;
  market?: MinimalMarketLayoutV3;
};

let existingLiquidityPools: Set<string> = new Set<string>();
let existingOpenBookMarkets: Set<string> = new Set<string>();
let existingTokenAccounts: Map<string, MinimalTokenAccountData> = new Map<string, MinimalTokenAccountData>();

let wallet: Keypair;
let quoteToken: Token;
let quoteTokenAssociatedAddress: PublicKey;
let quoteAmount: TokenAmount;
let quoteMinPoolSizeAmount: TokenAmount;
let quoteMaxPoolSizeAmount: TokenAmount;
let commitment: Commitment = retrieveEnvVariable('COMMITMENT_LEVEL', logger) as Commitment;
const ENABLE_BUY = retrieveEnvVariable('ENABLE_BUY', logger) === 'true';
const MINT_IS_RENOUNCED = retrieveEnvVariable('MINT_IS_RENOUNCED', logger) === 'true';
const USE_SNIPEDLIST = retrieveEnvVariable('USE_SNIPEDLIST', logger) === 'true';
const SNIPE_LIST_REFRESH_INTERVAL = Number(retrieveEnvVariable('SNIPE_LIST_REFRESH_INTERVAL', logger));
const AUTO_SELL = retrieveEnvVariable('AUTO_SELL', logger) === 'true';
const MAX_SELL_RETRIES = Number(retrieveEnvVariable('MAX_SELL_RETRIES', logger));
const MIN_POOL_SIZE = retrieveEnvVariable('MIN_POOL_SIZE', logger);
const MAX_POOL_SIZE = retrieveEnvVariable('MAX_POOL_SIZE', logger);

let snipeList: string[] = [];

// تحديث قيمة الشراء من التليجرام
function updateQuoteAmount() {
    if(quoteToken) {
        quoteAmount = new TokenAmount(quoteToken, DYNAMIC_BUY_AMOUNT, false);
    }
}

async function init(): Promise<void> {
  const MY_PRIVATE_KEY = retrieveEnvVariable('MY_PRIVATE_KEY', logger);
  wallet = Keypair.fromSecretKey(bs58.decode(MY_PRIVATE_KEY));

  const TOKEN_SYMB = retrieveEnvVariable('TOKEN_SYMB', logger);
  switch (TOKEN_SYMB) {
    case 'WSOL': {
      quoteToken = Token.WSOL;
      quoteMinPoolSizeAmount = new TokenAmount(quoteToken, MIN_POOL_SIZE, false);
      quoteMaxPoolSizeAmount = new TokenAmount(quoteToken, MAX_POOL_SIZE, false);
      break;
    }
    case 'USDC': {
      quoteToken = new Token(TOKEN_PROGRAM_ID, new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'), 6, 'USDC', 'USDC');
      break;
    }
  }
  updateQuoteAmount();

  const tokenAccounts = await getTokenAccounts(solanaConnection, wallet.publicKey, commitment);
  for (const ta of tokenAccounts) {
    existingTokenAccounts.set(ta.accountInfo.mint.toString(), <MinimalTokenAccountData>{
      mint: ta.accountInfo.mint,
      address: ta.pubkey,
    });
  }

  const tokenAccount = tokenAccounts.find((acc) => acc.accountInfo.mint.toString() === quoteToken.mint.toString());
  if (tokenAccount) {
      quoteTokenAssociatedAddress = tokenAccount.pubkey;
  }

  loadSnipedList();
}

function saveTokenAccount(mint: PublicKey, accountData: MinimalMarketLayoutV3) {
  const ata = getAssociatedTokenAddressSync(mint, wallet.publicKey);
  const tokenAccount = <MinimalTokenAccountData>{
    address: ata,
    mint: mint,
    market: <MinimalMarketLayoutV3>{ bids: accountData.bids, asks: accountData.asks, eventQueue: accountData.eventQueue },
  };
  existingTokenAccounts.set(mint.toString(), tokenAccount);
  return tokenAccount;
}

export async function processRaydiumPool(id: PublicKey, poolState: LiquidityStateV4) {
  if (!isBotRunning) return;

  if (!shouldBuy(poolState.baseMint.toString())) return;

  if (!quoteMinPoolSizeAmount.isZero()) {
    const poolSize = new TokenAmount(quoteToken, poolState.swapQuoteInAmount, true);
    if (poolSize.lt(quoteMinPoolSizeAmount)) return;
  }

  if (MINT_IS_RENOUNCED) {
    const mintOption = await checkMintable(poolState.baseMint);
    if (mintOption !== true) return;
  }

  if (ENABLE_BUY && quoteTokenAssociatedAddress) {
    await buy(id, poolState);
  }
}

export async function checkMintable(vault: PublicKey): Promise<boolean | undefined> {
  try {
    let { data } = (await solanaConnection.getAccountInfo(vault)) || {};
    if (!data) return;
    const deserialize = MintLayout.decode(data);
    return deserialize.mintAuthorityOption === 0;
  } catch (e) {}
}

export async function processOpenBookMarket(updatedAccountInfo: KeyedAccountInfo) {
  if (!isBotRunning) return;
  let accountData: MarketStateV3 | undefined;
  try {
    accountData = MARKET_STATE_LAYOUT_V3.decode(updatedAccountInfo.accountInfo.data);
    if (existingTokenAccounts.has(accountData.baseMint.toString())) return;
    saveTokenAccount(accountData.baseMint, accountData);
  } catch (e) {}
}

async function buy(accountId: PublicKey, accountData: LiquidityStateV4): Promise<void> {
  try {
    let tokenAccount = existingTokenAccounts.get(accountData.baseMint.toString());
    if (!tokenAccount) {
      const market = await getMinimalMarketV3(solanaConnection, accountData.marketId, commitment);
      tokenAccount = saveTokenAccount(accountData.baseMint, market);
    }
    tokenAccount.poolKeys = createPoolKeys(accountId, accountData, tokenAccount.market!);
    const { innerTransaction } = Liquidity.makeSwapFixedInInstruction(
      {
        poolKeys: tokenAccount.poolKeys,
        userKeys: { tokenAccountIn: quoteTokenAssociatedAddress, tokenAccountOut: tokenAccount.address, owner: wallet.publicKey },
        amountIn: quoteAmount.raw,
        minAmountOut: 0,
      },
      tokenAccount.poolKeys.version,
    );

    const latestBlockhash = await solanaConnection.getLatestBlockhash({ commitment: commitment });
    const messageV0 = new TransactionMessage({
      payerKey: wallet.publicKey,
      recentBlockhash: latestBlockhash.blockhash,
      instructions: [
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 421197 }),
        ComputeBudgetProgram.setComputeUnitLimit({ units: 101337 }),
        createAssociatedTokenAccountIdempotentInstruction(wallet.publicKey, tokenAccount.address, wallet.publicKey, accountData.baseMint),
        ...innerTransaction.instructions,
      ],
    }).compileToV0Message();
    const transaction = new VersionedTransaction(messageV0);
    transaction.sign([wallet, ...innerTransaction.signers]);
    const rawTransaction = transaction.serialize();
    const signature = await retry(() => solanaConnection.sendRawTransaction(rawTransaction, { skipPreflight: true }), { retryIntervalMs: 10, retries: 50 });
    
    const confirmation = await solanaConnection.confirmTransaction({ signature, lastValidBlockHeight: latestBlockhash.lastValidBlockHeight, blockhash: latestBlockhash.blockhash }, commitment);
    
    const basePromise = solanaConnection.getTokenAccountBalance(accountData.baseVault, commitment);
    const quotePromise = solanaConnection.getTokenAccountBalance(accountData.quoteVault, commitment);
    await Promise.all([basePromise, quotePromise]);
    const baseValue = await basePromise;
    const quoteValue = await quotePromise;

    if (baseValue?.value?.uiAmount && quoteValue?.value?.uiAmount)
      tokenAccount.buyValue = quoteValue?.value?.uiAmount / baseValue?.value?.uiAmount;
    
    if (!confirmation.value.err) {
      broadcastToChannelAndAdmin(`🎯 <b>تم قنص عملة جديدة آلياً!</b>\nالعملة: <code>${accountData.baseMint}</code>\nالسعر: ${tokenAccount.buyValue} SOL\nالرابط: https://dexscreener.com/solana/${accountData.baseMint}`);
    } 
  } catch (e) {}
}

async function sell(accountId: PublicKey, mint: PublicKey, amount: BigNumberish, value: number): Promise<boolean> {
  let retries = 0;
  do {
    try {
      const tokenAccount = existingTokenAccounts.get(mint.toString());
      if (!tokenAccount || !tokenAccount.poolKeys || amount === 0 || tokenAccount.buyValue === undefined) return true;

      const netChange = (value - tokenAccount.buyValue) / tokenAccount.buyValue;
      if (netChange > DYNAMIC_SL && netChange < DYNAMIC_TP) return false;

      const { innerTransaction } = Liquidity.makeSwapFixedInInstruction(
        {
          poolKeys: tokenAccount.poolKeys!,
          userKeys: { tokenAccountOut: quoteTokenAssociatedAddress, tokenAccountIn: tokenAccount.address, owner: wallet.publicKey },
          amountIn: amount,
          minAmountOut: 0,
        },
        tokenAccount.poolKeys!.version,
      );

      const latestBlockhash = await solanaConnection.getLatestBlockhash({ commitment: commitment });
      const messageV0 = new TransactionMessage({
        payerKey: wallet.publicKey,
        recentBlockhash: latestBlockhash.blockhash,
        instructions: [
          ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 400000 }),
          ComputeBudgetProgram.setComputeUnitLimit({ units: 200000 }),
          ...innerTransaction.instructions,
          createCloseAccountInstruction(tokenAccount.address, wallet.publicKey, wallet.publicKey),
        ],
      }).compileToV0Message();
      
      const transaction = new VersionedTransaction(messageV0);
      transaction.sign([wallet, ...innerTransaction.signers]);
      const signature = await solanaConnection.sendRawTransaction(transaction.serialize(), { preflightCommitment: commitment });
      const confirmation = await solanaConnection.confirmTransaction({ signature, lastValidBlockHeight: latestBlockhash.lastValidBlockHeight, blockhash: latestBlockhash.blockhash }, commitment);
      
      if (confirmation.value.err) continue;

      const emoji = netChange > 0 ? "🟢🤑" : "🔴";
      broadcastToChannelAndAdmin(`${emoji} <b>تم بيع العملة بنجاح!</b>\nالعملة: <code>${mint}</code>\nصافي الربح: <b>${(netChange * 100).toFixed(2)}%</b>`);

      return true;
    } catch (e: any) {
      retries++;
    }
  } while (retries < MAX_SELL_RETRIES);
  return true;
}

function loadSnipedList() {
  if (!USE_SNIPEDLIST) return;
  const data = fs.readFileSync(path.join(__dirname, 'snipedlist.txt'), 'utf-8');
  snipeList = data.split('\n').map((a) => a.trim()).filter((a) => a);
}

function shouldBuy(key: string): boolean {
  return USE_SNIPEDLIST ? snipeList.includes(key) : true;
}

const runListener = async () => {
  await setupDashboard(); 
  await init();
  const runTimestamp = Math.floor(new Date().getTime() / 1000);
  
  solanaConnection.onProgramAccountChange(
    RAYDIUM_LIQUIDITY_PROGRAM_ID_V4,
    async (updatedAccountInfo) => {
      const key = updatedAccountInfo.accountId.toString();
      const poolState = LIQUIDITY_STATE_LAYOUT_V4.decode(updatedAccountInfo.accountInfo.data);
      const poolOpenTime = parseInt(poolState.poolOpenTime.toString());
      const existing = existingLiquidityPools.has(key);

      if (poolOpenTime > runTimestamp && !existing) {
        existingLiquidityPools.add(key);
        processRaydiumPool(updatedAccountInfo.accountId, poolState);
      }
    },
    commitment,
    [
      { dataSize: LIQUIDITY_STATE_LAYOUT_V4.span },
      { memcmp: { offset: LIQUIDITY_STATE_LAYOUT_V4.offsetOf('quoteMint'), bytes: quoteToken.mint.toBase58() } },
      { memcmp: { offset: LIQUIDITY_STATE_LAYOUT_V4.offsetOf('marketProgramId'), bytes: OPENBOOK_PROGRAM_ID.toBase58() } },
      { memcmp: { offset: LIQUIDITY_STATE_LAYOUT_V4.offsetOf('status'), bytes: bs58.encode([6, 0, 0, 0, 0, 0, 0, 0]) } },
    ],
  );

  solanaConnection.onProgramAccountChange(
    OPENBOOK_PROGRAM_ID,
    async (updatedAccountInfo) => {
      const key = updatedAccountInfo.accountId.toString();
      const existing = existingOpenBookMarkets.has(key);
      if (!existing) {
        existingOpenBookMarkets.add(key);
        processOpenBookMarket(updatedAccountInfo);
      }
    },
    commitment,
    [
      { dataSize: MARKET_STATE_LAYOUT_V3.span },
      { memcmp: { offset: MARKET_STATE_LAYOUT_V3.offsetOf('quoteMint'), bytes: quoteToken.mint.toBase58() } },
    ],
  );

  if (AUTO_SELL) {
    solanaConnection.onProgramAccountChange(
      TOKEN_PROGRAM_ID,
      async (updatedAccountInfo) => {
        if (!quoteTokenAssociatedAddress) return;
        const accountData = AccountLayout.decode(updatedAccountInfo.accountInfo!.data);
        if (updatedAccountInfo.accountId.equals(quoteTokenAssociatedAddress)) return;
        
        let completed = false;
        while (!completed) {
          setTimeout(() => {}, 1000);
          const currValue = await retrieveTokenValueByAddress(accountData.mint.toBase58());
          if (currValue) {
            completed = await sell(updatedAccountInfo.accountId, accountData.mint, accountData.amount, currValue);
          } 
        }
      },
      commitment,
      [
        { dataSize: 165 },
        { memcmp: { offset: 32, bytes: wallet.publicKey.toBase58() } },
      ],
    );
  }

  if (USE_SNIPEDLIST) {
    setInterval(loadSnipedList, SNIPE_LIST_REFRESH_INTERVAL);
  }
};

runListener();
