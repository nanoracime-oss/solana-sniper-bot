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
let SIMULATION_MODE = true; 
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
const User = (mongoose.models && mongoose.models.User) ? mongoose.models.User : mongoose.model('User', UserSchema);

const TxSchema = new mongoose.Schema({ txHash: { type: String, unique: true } });
const UsedTx = (mongoose.models && mongoose.models.UsedTx) ? mongoose.models.UsedTx : mongoose.model('UsedTx', TxSchema);

// ==========================================
// نظام توزيع الأحمال (Multi-RPC Load Balancer)
// ==========================================
const RPC_ENDPOINTS = [
    retrieveEnvVariable('RPC_ENDPOINT', logger),
    "https://api.mainnet-beta.solana.com", // رابط عام كاحتياط
    "https://solana-mainnet.g.allthatnode.com/full/evm" // رابط إضافي
];
const RPC_WEBSOCKETS = [
    retrieveEnvVariable('RPC_WEBSOCKET', logger),
    "wss://api.mainnet-beta.solana.com"
];

let rpcIndex = 0;
let solanaConnection = new Connection(RPC_ENDPOINTS[rpcIndex], { wsEndpoint: RPC_WEBSOCKETS[rpcIndex] });

async function switchRPC() {
    rpcIndex = (rpcIndex + 1) % RPC_ENDPOINTS.length;
    logger.info(`🔄 Switching to RPC: ${RPC_ENDPOINTS[rpcIndex]}`);
    solanaConnection = new Connection(RPC_ENDPOINTS[rpcIndex], { wsEndpoint: RPC_WEBSOCKETS[rpcIndex % RPC_WEBSOCKETS.length] });
}

// ==========================================
// لوحات المفاتيح
// ==========================================
const adminKeyboard = {
    reply_markup: {
        keyboard: [
            [{ text: '👑 المحرك' }, { text: '⚙️ التحكم المتقدم (God Mode)' }],
            [{ text: '📊 الرادار المالي' }, { text: '📡 إرسال تعميم للمستثمرين' }],
            [{ text: '📸 توليد صفقة تسويقية' }]
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
      // @ts-ignore
      if (global.tgBotInstance) return;
      tgBot = new TelegramBot(token, {polling: true});
      // @ts-ignore
      global.tgBotInstance = tgBot;

      tgBot.on('polling_error', (error: any) => {
          if (error.code === 'ETELEGRAM' && error.message.includes('409')) return; 
          if (error.message.includes('429')) {
              logger.warn("⚠️ Rate Limit hit on Telegram. Cooling down...");
              return;
          }
          console.error(error.message);
      });

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
                  tgBot.sendMessage(chatId, `👑 <b>مرحباً سيدي المدير في نظام ${PROJECT_NAME}</b>`, { parse_mode: 'HTML', ...adminKeyboard });
              } else {
                  tgBot.sendMessage(chatId, `🏛 <b>مرحباً بك في نظام ${PROJECT_NAME}</b>`, { parse_mode: 'HTML', ...userKeyboard });
              }
              return;
          }

          if (chatId === adminChatId) {
              if (text === '👑 المحرك') {
                  const options = {
                      reply_markup: {
                          inline_keyboard: [
                              [{ text: isBotRunning ? '🛑 إيقاف القناص' : '▶️ تشغيل القناص', callback_data: 'toggle_sniper' }],
                              [{ text: SIMULATION_MODE ? '👻 وضع المحاكاة: مفعّل' : '🔥 وضع المحاكاة: معطّل', callback_data: 'toggle_simulation' }],
                              [{ text: `الربح (${DYNAMIC_TP * 100}%)`, callback_data: 'edit_tp' }, { text: `المخاطرة (${DYNAMIC_SL * 100}%)`, callback_data: 'edit_sl' }],
                              [{ text: `مبلغ الشراء (${DYNAMIC_BUY_AMOUNT} SOL)`, callback_data: 'edit_buy' }]
                          ]
                      }
                  };
                  tgBot.sendMessage(chatId, "⚙️ <b>التحكم في محرك التداول:</b>", { parse_mode: 'HTML', ...options });
              }
              else if (text === '📸 توليد صفقة تسويقية') {
                  const randomCoins = ["$PEPE_SOL", "$AI_DOGE", "$NINJA", "$SOL_BULL", "$QUANT_X", "$NANO_MEME", "$PUMP_IT", "$DOGE_X"];
                  const randomCoin = randomCoins[Math.floor(Math.random() * randomCoins.length)];
                  const fakeEntry = (Math.random() * 0.05 + 0.01).toFixed(4);
                  const fakeDuration = Math.floor(Math.random() * 4) + 2; 
                  const fakeProfit = (Math.random() * 2.5 + 0.6); 
                  let botUsr = "ApexQuant";
                  try { botUsr = (await tgBot.getMe()).username; } catch(e) {}

                  broadcastToChannelAndAdmin(`🎯 <b>تم رصد فرصة استثمارية وتفعيل القناص!</b>\n🪙 <b>العملة:</b> <code>${randomCoin}</code>\n💵 <b>سعر الدخول:</b> <code>${fakeEntry} SOL</code>`);
                  
                  setTimeout(() => {
                      broadcastToChannelAndAdmin(`🟢 <b>تم إغلاق الصفقة بنجاح!</b> 💸\n🪙 <b>العملة:</b> <code>${randomCoin}</code>\n📈 <b>صافي الربح:</b> <b>+${(fakeProfit * 100).toFixed(2)}%</b>\n🔗 https://t.me/${botUsr}`);
                  }, fakeDuration * 60000);
              }
          }
      });

      tgBot.on('callback_query', async (query: any) => {
          const chatId = query.message.chat.id.toString();
          if (chatId === adminChatId) {
              if (query.data === 'toggle_sniper') { isBotRunning = !isBotRunning; tgBot.sendMessage(chatId, isBotRunning ? "🟢 يعمل" : "🔴 متوقف"); }
              else if (query.data === 'toggle_simulation') { SIMULATION_MODE = !SIMULATION_MODE; tgBot.sendMessage(chatId, SIMULATION_MODE ? "👻 مفعّل" : "🔥 معطّل"); }
          }
          tgBot.answerCallbackQuery(query.id);
      });
  }

  setInterval(async () => {
      if (!SIMULATION_MODE || simulatedTokens.size === 0) return;
      for (const [mint, data] of simulatedTokens.entries()) {
          try {
              const currPrice = await retrieveTokenValueByAddress(mint);
              if (currPrice) {
                  const netChange = (currPrice - data.buyPrice) / data.buyPrice;
                  if (netChange >= DYNAMIC_TP) {
                      simulatedTokens.delete(mint);
                      broadcastToChannelAndAdmin(`🟢 <b>جني أرباح حقيقي!</b>\n🪙 <code>${mint}</code>\n📈 <b>+${(netChange * 100).toFixed(2)}%</b>`);
                  } else if (netChange <= DYNAMIC_SL) { simulatedTokens.delete(mint); }
              }
          } catch(e) {}
      }
  }, 30000);
}

function broadcastToChannelAndAdmin(text: string) {
  if (!tgBot) return;
  if (adminChatId) tgBot.sendMessage(adminChatId, text, { parse_mode: 'HTML', disable_web_page_preview: true }).catch(()=>{});
  if (PUBLIC_CHANNEL) tgBot.sendMessage(PUBLIC_CHANNEL, text, { parse_mode: 'HTML', disable_web_page_preview: true }).catch(()=>{});
}

// ==========================================
// محرك القنص المحسن
// ==========================================
let wallet: Keypair;
let quoteToken: Token = Token.WSOL;
let quoteTokenAssociatedAddress: PublicKey;
let quoteAmount: TokenAmount;
let quoteMinPoolSizeAmount: TokenAmount;
let commitment: Commitment = 'confirmed';
const MIN_POOL_SIZE = retrieveEnvVariable('MIN_POOL_SIZE', logger);

function updateQuoteAmount() {
    if(quoteToken) { quoteAmount = new TokenAmount(quoteToken, DYNAMIC_BUY_AMOUNT, false); }
}

async function init(): Promise<void> {
  const MY_PRIVATE_KEY = retrieveEnvVariable('MY_PRIVATE_KEY', logger);
  wallet = Keypair.fromSecretKey(bs58.decode(MY_PRIVATE_KEY));
  quoteMinPoolSizeAmount = new TokenAmount(quoteToken, MIN_POOL_SIZE, false);
  updateQuoteAmount();

  const tokenAccounts = await getTokenAccounts(solanaConnection, wallet.publicKey, commitment);
  const tokenAccount = tokenAccounts.find((acc: any) => acc.accountInfo.mint.toString() === quoteToken.mint.toString());
  if (tokenAccount) { quoteTokenAssociatedAddress = tokenAccount.pubkey; }
}

export async function processRaydiumPool(id: PublicKey, poolState: LiquidityStateV4) {
  if (!isBotRunning) return;
  const poolSize = new TokenAmount(quoteToken, poolState.swapQuoteInAmount, true);
  if (poolSize.lt(quoteMinPoolSizeAmount)) return;
  
  await buy(id, poolState);
}

async function buy(accountId: PublicKey, accountData: LiquidityStateV4): Promise<void> {
  try {
    if (SIMULATION_MODE) {
        const basePrice = await retrieveTokenValueByAddress(accountData.baseMint.toString());
        if(basePrice) {
            simulatedTokens.set(accountData.baseMint.toString(), { mint: accountData.baseMint.toString(), buyPrice: basePrice, entryTime: Date.now() });
            broadcastToChannelAndAdmin(`🎯 <b>قنص حقيقي (محاكاة)!</b>\n🪙 <code>${accountData.baseMint.toString()}</code>\n💵 السعر: <code>${basePrice.toFixed(8)} SOL</code>`);
        }
        return;
    }
  } catch (e: any) {
      if (e.message.includes('429')) await switchRPC();
  }
}

const runListener = async () => {
  await setupDashboard(); 
  await init();
  
  const listener = async () => {
      try {
          solanaConnection.onProgramAccountChange(
            RAYDIUM_LIQUIDITY_PROGRAM_ID_V4,
            async (updatedAccountInfo) => {
              const poolState = LIQUIDITY_STATE_LAYOUT_V4.decode(updatedAccountInfo.accountInfo.data);
              processRaydiumPool(updatedAccountInfo.accountId, poolState);
            },
            commitment,
            [ { dataSize: LIQUIDITY_STATE_LAYOUT_V4.span }, { memcmp: { offset: LIQUIDITY_STATE_LAYOUT_V4.offsetOf('quoteMint'), bytes: quoteToken.mint.toBase58() } } ],
          );
      } catch (e: any) {
          if (e.message.includes('429')) {
              logger.warn("🛑 WebSocket Rate Limit. Switching RPC...");
              await switchRPC();
              setTimeout(listener, 5000);
          }
      }
  };
  listener();
};

// @ts-ignore
if (!global.__SYSTEM_STARTED__) {
    // @ts-ignore
    global.__SYSTEM_STARTED__ = true;
    runListener();
}
