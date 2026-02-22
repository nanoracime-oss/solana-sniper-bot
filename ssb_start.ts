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
// إعدادات المنصة والإدارة (SaaS Dashboard)
// ==========================================
let isBotRunning = false; // البوت يبدأ متوقفاً لحماية الرصيد
let tgBot: any;
const adminChatId = process.env.TELEGRAM_CHAT_ID;

// تجهيز قاعدة البيانات للمستثمرين
const InvestorSchema = new mongoose.Schema({
    chatId: String,
    walletAddress: String,
    investedAmount: Number,
    status: String,
    createdAt: { type: Date, default: Date.now }
});
const Investor = mongoose.model('Investor', InvestorSchema);

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

      const sendAdminMenu = (chatId: string) => {
          const options = {
              reply_markup: {
                  inline_keyboard: [
                      [{ text: '▶️ تشغيل القناص', callback_data: 'start_sniper' }, { text: '⏸️ إيقاف القناص', callback_data: 'stop_sniper' }],
                      [{ text: '💰 رصيد المحفظة', callback_data: 'check_balance' }, { text: '📊 إحصائيات النظام', callback_data: 'system_stats' }]
                  ]
              }
          };
          tgBot.sendMessage(chatId, "👑 <b>لوحة تحكم المدير</b>\nتحكم في إمبراطوريتك من هنا:", {parse_mode: 'HTML', ...options});
      };

      tgBot.onText(/\/start/, (msg: any) => {
          const chatId = msg.chat.id.toString();
          if (chatId === adminChatId) {
              sendAdminMenu(chatId);
          } else {
              tgBot.sendMessage(chatId, "👋 أهلاً بك في منصة الاستثمار الذكي.\nالمنصة حالياً في الوضع التجريبي (Beta). سيتم فتح باب الاستثمار قريباً جداً! 🚀");
          }
      });

      tgBot.on('callback_query', async (query: any) => {
          const chatId = query.message.chat.id.toString();
          if (chatId !== adminChatId) return;

          if (query.data === 'start_sniper') {
              isBotRunning = true;
              tgBot.sendMessage(chatId, "🟢 <b>تم تشغيل القناص!</b>\nالبوت الآن يراقب شبكة سولانا بحثاً عن صفقات.", {parse_mode: 'HTML'});
          }
          else if (query.data === 'stop_sniper') {
              isBotRunning = false;
              tgBot.sendMessage(chatId, "🔴 <b>تم إيقاف القناص!</b>\nالبوت في وضع الاستراحة ولن يقوم بأي عملية شراء.", {parse_mode: 'HTML'});
          }
          else if (query.data === 'check_balance') {
              try {
                  const balance = await solanaConnection.getBalance(wallet.publicKey);
                  tgBot.sendMessage(chatId, `💰 <b>رصيد الخزنة الرئيسية:</b>\n<code>${(balance / 1e9).toFixed(5)} SOL</code>`, {parse_mode: 'HTML'});
              } catch(e) {
                  tgBot.sendMessage(chatId, "❌ حدث خطأ في جلب الرصيد.");
              }
          }
          else if (query.data === 'system_stats') {
               const dbState = mongoose.connection.readyState === 1 ? '✅ متصلة' : '❌ غير متصلة';
               const botState = isBotRunning ? '🟢 يعمل بقوة' : '🔴 متوقف (وضع السبات)';
               tgBot.sendMessage(chatId, `📊 <b>تقرير النظام الفوري:</b>\n\nحالة المحرك: ${botState}\nقاعدة البيانات: ${dbState}\nنسبة الربح: ${TAKE_PROFIT}%\nنسبة الخسارة: ${STOP_LOSS}%`, {parse_mode: 'HTML'});
          }
          tgBot.answerCallbackQuery(query.id);
      });
  }
}

function sendTelegramMessage(text: string) {
  if (tgBot && adminChatId) {
      tgBot.sendMessage(adminChatId, text, { parse_mode: 'HTML', disable_web_page_preview: true }).catch((e:any) => console.log(e));
  }
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
const TAKE_PROFIT = Number(retrieveEnvVariable('TAKE_PROFIT', logger));
const STOP_LOSS = Number(retrieveEnvVariable('STOP_LOSS', logger));
const MINT_IS_RENOUNCED = retrieveEnvVariable('MINT_IS_RENOUNCED', logger) === 'true';
const USE_SNIPEDLIST = retrieveEnvVariable('USE_SNIPEDLIST', logger) === 'true';
const SNIPE_LIST_REFRESH_INTERVAL = Number(retrieveEnvVariable('SNIPE_LIST_REFRESH_INTERVAL', logger));
const AUTO_SELL = retrieveEnvVariable('AUTO_SELL', logger) === 'true';
const MAX_SELL_RETRIES = Number(retrieveEnvVariable('MAX_SELL_RETRIES', logger));
const MIN_POOL_SIZE = retrieveEnvVariable('MIN_POOL_SIZE', logger);
const MAX_POOL_SIZE = retrieveEnvVariable('MAX_POOL_SIZE', logger);

let snipeList: string[] = [];

async function init(): Promise<void> {

  logger.info(`

                                    EARLY ACCESS - USE AT YOUR OWN RISK


             _____/\\\\\\\\\\\_________/\\\\\__________/\\\\\\\\\_______/\\\\\\\\\_____        
              ___/\\\/////////\\\_____/\\\///\\\______/\\\\\\\\\\\\\___/\\\///////\\\___       
               __\//\\\______\///____/\\\/__\///\\\___/\\\/////////\\\_\/\\\_____\/\\\___      
                ___\////\\\__________/\\\______\//\\\_\/\\\_______\/\\\_\/\\\\\\\\\\\/____     
                 ______\////\\\______\/\\\_______\/\\\_\/\\\\\\\\\\\\\\\_\/\\\//////\\\____    
                  _________\////\\\___\//\\\______/\\\__\/\\\/////////\\\_\/\\\____\//\\\___   
                   __/\\\______\//\\\___\///\\\__/\\\____\/\\\_______\/\\\_\/\\\_____\//\\\__  
                    _\///\\\\\\\\\\\/______\///\\\\\/_____\/\\\_______\/\\\_\/\\\______\//\\\_ 
                     ___\///////////__________\/////_______\///________\///__\///________\///__
                                   

                                            SoaR v.2.0 (SaaS Edition)

                              -------- RUNNING | CTRL+C TO STOP IT --------
  `);

  const MY_PRIVATE_KEY = retrieveEnvVariable('MY_PRIVATE_KEY', logger);
  wallet = Keypair.fromSecretKey(bs58.decode(MY_PRIVATE_KEY));

  logger.info(`CONNECTED @ ${RPC_ENDPOINT}`);
  logger.info('----------------------------------------------------------');
  logger.info(`Wallet Address: ${wallet.publicKey}`);

  sendTelegramMessage(`🚀 <b>تم إقلاع سيرفر القنص بنجاح!</b>\nأرسل /start لفتح لوحة التحكم والتفاعل مع الأزرار.`);

  const TOKEN_SYMB = retrieveEnvVariable('TOKEN_SYMB', logger);
  const BUY_AMOUNT = retrieveEnvVariable('BUY_AMOUNT', logger);
  switch (TOKEN_SYMB) {
    case 'WSOL': {
      quoteToken = Token.WSOL;
      quoteAmount = new TokenAmount(Token.WSOL, BUY_AMOUNT, false);
      quoteMinPoolSizeAmount = new TokenAmount(quoteToken, MIN_POOL_SIZE, false);
      quoteMaxPoolSizeAmount = new TokenAmount(quoteToken, MAX_POOL_SIZE, false);
      break;
    }
    case 'USDC': {
      quoteToken = new Token(
        TOKEN_PROGRAM_ID,
        new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'),
        6,
        'USDC',
        'USDC',
      );
      quoteAmount = new TokenAmount(quoteToken, BUY_AMOUNT, false);
      break;
    }
    default: {
      throw new Error(`Unsupported "${TOKEN_SYMB}"! ONLY USDC or WSOL`);
    }
  }

  const tokenAccounts = await getTokenAccounts(solanaConnection, wallet.publicKey, commitment);

  for (const ta of tokenAccounts) {
    existingTokenAccounts.set(ta.accountInfo.mint.toString(), <MinimalTokenAccountData>{
      mint: ta.accountInfo.mint,
      address: ta.pubkey,
    });
  }

  const tokenAccount = tokenAccounts.find((acc) => acc.accountInfo.mint.toString() === quoteToken.mint.toString())!;

  if (!tokenAccount) {
    logger.error(`---> Put SOL in your wallet and swap SOL to WSOL <---`);
    // لم نعد نوقف السيرفر هنا بل نتركه يعمل ليستقبل أوامر تيليجرام
  } else {
      quoteTokenAssociatedAddress = tokenAccount.pubkey;
  }

  loadSnipedList();
}

function saveTokenAccount(mint: PublicKey, accountData: MinimalMarketLayoutV3) {
  const ata = getAssociatedTokenAddressSync(mint, wallet.publicKey);
  const tokenAccount = <MinimalTokenAccountData>{
    address: ata,
    mint: mint,
    market: <MinimalMarketLayoutV3>{
      bids: accountData.bids,
      asks: accountData.asks,
      eventQueue: accountData.eventQueue,
    },
  };
  existingTokenAccounts.set(mint.toString(), tokenAccount);
  return tokenAccount;
}

export async function processRaydiumPool(id: PublicKey, poolState: LiquidityStateV4) {

  // حماية الاستثمار: لا تفعل شيء إذا كان القناص متوقف من تيليجرام
  if (!isBotRunning) return;

  let rugRiskDanger = false;
  let rugRisk = 'Unknown';

  if (!shouldBuy(poolState.baseMint.toString())) {
    return;
  }

  if (!quoteMinPoolSizeAmount.isZero()) {
    const poolSize = new TokenAmount(quoteToken, poolState.swapQuoteInAmount, true);
    
    if (poolSize.lt(quoteMinPoolSizeAmount) || rugRiskDanger) {
      return;
    }
    logger.info(`--------------!!!!! POOL SNIPED | (${poolSize.toFixed()} ${quoteToken.symbol}) !!!!!-------------- `);
  }

  if (MINT_IS_RENOUNCED) {
    const mintOption = await checkMintable(poolState.baseMint);
    if (mintOption !== true) {
      return;
    }
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
  } catch (e) {
  }
}

export async function processOpenBookMarket(updatedAccountInfo: KeyedAccountInfo) {
  if (!isBotRunning) return;
  let accountData: MarketStateV3 | undefined;
  try {
    accountData = MARKET_STATE_LAYOUT_V3.decode(updatedAccountInfo.accountInfo.data);
    if (existingTokenAccounts.has(accountData.baseMint.toString())) {
      return;
    }
    saveTokenAccount(accountData.baseMint, accountData);
  } catch (e) {
  }
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
        userKeys: {
          tokenAccountIn: quoteTokenAssociatedAddress,
          tokenAccountOut: tokenAccount.address,
          owner: wallet.publicKey,
        },
        amountIn: quoteAmount.raw,
        minAmountOut: 0,
      },
      tokenAccount.poolKeys.version,
    );

    const latestBlockhash = await solanaConnection.getLatestBlockhash({
      commitment: commitment,
    });
    const messageV0 = new TransactionMessage({
      payerKey: wallet.publicKey,
      recentBlockhash: latestBlockhash.blockhash,
      instructions: [
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 421197 }),
        ComputeBudgetProgram.setComputeUnitLimit({ units: 101337 }),
        createAssociatedTokenAccountIdempotentInstruction(
          wallet.publicKey,
          tokenAccount.address,
          wallet.publicKey,
          accountData.baseMint,
        ),
        ...innerTransaction.instructions,
      ],
    }).compileToV0Message();
    const transaction = new VersionedTransaction(messageV0);
    transaction.sign([wallet, ...innerTransaction.signers]);
    const rawTransaction = transaction.serialize();
    const signature = await retry(
    () =>
      solanaConnection.sendRawTransaction(rawTransaction, {
        skipPreflight: true,
      }),
    { retryIntervalMs: 10, retries: 50 },
  );
    const confirmation = await solanaConnection.confirmTransaction(
      {
        signature,
        lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
        blockhash: latestBlockhash.blockhash,
      },
      commitment,
    );
    const basePromise = solanaConnection.getTokenAccountBalance(accountData.baseVault, commitment);
    const quotePromise = solanaConnection.getTokenAccountBalance(accountData.quoteVault, commitment);

    await Promise.all([basePromise, quotePromise]);

    const baseValue = await basePromise;
    const quoteValue = await quotePromise;

    if (baseValue?.value?.uiAmount && quoteValue?.value?.uiAmount)
      tokenAccount.buyValue = quoteValue?.value?.uiAmount / baseValue?.value?.uiAmount;
    
    if (!confirmation.value.err) {
      sendTelegramMessage(`🟢 <b>تم قنص عملة جديدة!</b>\nالعملة: <code>${accountData.baseMint}</code>\nالسعر: ${tokenAccount.buyValue} SOL\nالرابط: https://dexscreener.com/solana/${accountData.baseMint}`);
    } 
  } catch (e) {
  }
}

async function sell(accountId: PublicKey, mint: PublicKey, amount: BigNumberish, value: number): Promise<boolean> {
  let retries = 0;

  do {
    try {
      const tokenAccount = existingTokenAccounts.get(mint.toString());
      if (!tokenAccount || !tokenAccount.poolKeys || amount === 0 || tokenAccount.buyValue === undefined) {
        return true;
      }

      const netChange = (value - tokenAccount.buyValue) / tokenAccount.buyValue;
      if (netChange > STOP_LOSS && netChange < TAKE_PROFIT) return false;

      const { innerTransaction } = Liquidity.makeSwapFixedInInstruction(
        {
          poolKeys: tokenAccount.poolKeys!,
          userKeys: {
            tokenAccountOut: quoteTokenAssociatedAddress,
            tokenAccountIn: tokenAccount.address,
            owner: wallet.publicKey,
          },
          amountIn: amount,
          minAmountOut: 0,
        },
        tokenAccount.poolKeys!.version,
      );

      const latestBlockhash = await solanaConnection.getLatestBlockhash({
        commitment: commitment,
      });
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
      const signature = await solanaConnection.sendRawTransaction(transaction.serialize(), {
        preflightCommitment: commitment,
      });
      const confirmation = await solanaConnection.confirmTransaction(
        {
          signature,
          lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
          blockhash: latestBlockhash.blockhash,
        },
        commitment,
      );
      if (confirmation.value.err) {
        continue;
      }

      const emoji = netChange > 0 ? "🤑" : "🔴";
      sendTelegramMessage(`${emoji} <b>تم بيع العملة!</b>\nالعملة: <code>${mint}</code>\nالنسبة المئوية: ${netChange * 100}%`);

      return true;
    } catch (e: any) {
      retries++;
    }
  } while (retries < MAX_SELL_RETRIES);
  return true;
}

function loadSnipedList() {
  if (!USE_SNIPEDLIST) {
    return;
  }
  const count = snipeList.length;
  const data = fs.readFileSync(path.join(__dirname, 'snipedlist.txt'), 'utf-8');
  snipeList = data.split('\n').map((a) => a.trim()).filter((a) => a);
}

function shouldBuy(key: string): boolean {
  return USE_SNIPEDLIST ? snipeList.includes(key) : true;
}

const runListener = async () => {
  await setupDashboard(); // تشغيل لوحة التحكم فوراً
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
        if (updatedAccountInfo.accountId.equals(quoteTokenAssociatedAddress)) {
          return;
        }
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
