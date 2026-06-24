/**
 * Claude + TradingView MCP — Trading Signal Bot
 *
 * Cloud mode: runs on Railway on a schedule. Pulls candle data direct from
 * Binance (free, no auth), calculates all indicators, runs safety check,
 * and sends a Telegram alert if every entry condition is met.
 *
 * This bot NEVER places real orders — it only signals. You decide and
 * execute manually on the exchange.
 *
 * Local mode: run manually — node bot.js
 * Cloud mode: deploy to Railway, set env vars, Railway triggers on cron schedule
 */

import "dotenv/config";
import { readFileSync, writeFileSync, existsSync, appendFileSync } from "fs";
import { execSync } from "child_process";

// ─── Onboarding ───────────────────────────────────────────────────────────────

function checkOnboarding() {
  // Required credentials may come from a local .env file OR from platform-injected
  // environment variables (Railway, etc.) — check process.env directly, not file existence.
  const required = ["TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID"];
  const missing = required.filter((k) => !process.env[k]);

  if (missing.length === 0) {
    // Always print the CSV location so users know where to find their signal log
    const csvPath = new URL("trades.csv", import.meta.url).pathname;
    console.log(`\n📄 Signal log: ${csvPath}`);
    console.log(
      `   Open in Google Sheets or Excel any time — or tell Claude to move it:\n` +
        `   "Move my trades.csv to ~/Desktop" or "Move it to my Documents folder"\n`,
    );
    return;
  }

  if (!existsSync(".env")) {
    console.log(
      "\n⚠️  No .env file found — opening it for you to fill in...\n",
    );
    writeFileSync(
      ".env",
      [
        "# Telegram alerts — sends a signal notification, never places real orders",
        "TELEGRAM_BOT_TOKEN=",
        "TELEGRAM_CHAT_ID=",
        "",
        "# Trading config",
        "PORTFOLIO_VALUE_USD=1000",
        "MAX_TRADE_SIZE_USD=100",
        "MAX_TRADES_PER_DAY=3",
        "SYMBOL=BTCUSDT",
        "TIMEFRAME=4H",
      ].join("\n") + "\n",
    );
    try {
      execSync("open .env");
    } catch {}
    console.log(
      "Fill in your Telegram credentials in .env then re-run: node bot.js\n",
    );
    process.exit(0);
  }

  console.log(`\n⚠️  Missing credentials: ${missing.join(", ")}`);
  console.log("Opening .env for you now...\n");
  try {
    execSync("open .env");
  } catch {}
  console.log("Add the missing values then re-run: node bot.js\n");
  process.exit(0);
}

// ─── Config ────────────────────────────────────────────────────────────────

const CONFIG = {
  symbol: process.env.SYMBOL || "BTCUSDT",
  timeframe: process.env.TIMEFRAME || "4H",
  portfolioValue: parseFloat(process.env.PORTFOLIO_VALUE_USD || "1000"),
  maxTradeSizeUSD: parseFloat(process.env.MAX_TRADE_SIZE_USD || "100"),
  maxTradesPerDay: parseInt(process.env.MAX_TRADES_PER_DAY || "3"),
  telegram: {
    botToken: process.env.TELEGRAM_BOT_TOKEN,
    chatId: process.env.TELEGRAM_CHAT_ID,
  },
};

const LOG_FILE = "safety-check-log.json";

// ─── Logging ────────────────────────────────────────────────────────────────

function loadLog() {
  if (!existsSync(LOG_FILE)) return { trades: [] };
  return JSON.parse(readFileSync(LOG_FILE, "utf8"));
}

function saveLog(log) {
  writeFileSync(LOG_FILE, JSON.stringify(log, null, 2));
}

function countTodaysTrades(log) {
  const today = new Date().toISOString().slice(0, 10);
  return log.trades.filter(
    (t) => t.timestamp.startsWith(today) && t.alertSent,
  ).length;
}

// ─── Market Data (Binance public API — free, no auth) ───────────────────────

async function fetchCandles(symbol, interval, limit = 100) {
  // Map our timeframe format to Binance interval format
  const intervalMap = {
    "1m": "1m",
    "3m": "3m",
    "5m": "5m",
    "15m": "15m",
    "30m": "30m",
    "1H": "1h",
    "4H": "4h",
    "1D": "1d",
    "1W": "1w",
  };
  const binanceInterval = intervalMap[interval] || "1m";

  const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${binanceInterval}&limit=${limit}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Binance API error: ${res.status}`);
  const data = await res.json();

  return data.map((k) => ({
    time: k[0],
    open: parseFloat(k[1]),
    high: parseFloat(k[2]),
    low: parseFloat(k[3]),
    close: parseFloat(k[4]),
    volume: parseFloat(k[5]),
  }));
}

// ─── Indicator Calculations ──────────────────────────────────────────────────

function calcEMA(closes, period) {
  const multiplier = 2 / (period + 1);
  let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < closes.length; i++) {
    ema = closes[i] * multiplier + ema * (1 - multiplier);
  }
  return ema;
}

function calcRSI(closes, period = 14) {
  if (closes.length < period + 1) return null;
  let gains = 0,
    losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gains += diff;
    else losses -= diff;
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

// ─── Safety Check ───────────────────────────────────────────────────────────

function runSafetyCheck(price, ema20, ema50, rsi14, rules) {
  const results = [];

  const check = (label, required, actual, pass) => {
    results.push({ label, required, actual, pass });
    const icon = pass ? "✅" : "🚫";
    console.log(`  ${icon} ${label}`);
    console.log(`     Required: ${required} | Actual: ${actual}`);
  };

  console.log("\n── Safety Check ─────────────────────────────────────────\n");

  // Determine trend bias from EMA(20)/EMA(50)
  const bullishBias = ema20 > ema50;
  const bearishBias = ema20 < ema50;

  if (bullishBias) {
    console.log("  Bias: BULLISH — checking long entry conditions\n");

    // 1. EMA(20) above EMA(50)
    check(
      "EMA(20) above EMA(50) (uptrend confirmed)",
      `> ${ema50.toFixed(2)}`,
      ema20.toFixed(2),
      ema20 > ema50,
    );

    // 2. RSI(14) pullback
    check(
      "RSI(14) below 40 (pullback in uptrend, snap-back likely)",
      "< 40",
      rsi14.toFixed(2),
      rsi14 < 40,
    );
  } else if (bearishBias) {
    console.log("  Bias: BEARISH — checking short entry conditions\n");

    check(
      "EMA(20) below EMA(50) (downtrend confirmed)",
      `< ${ema50.toFixed(2)}`,
      ema20.toFixed(2),
      ema20 < ema50,
    );

    check(
      "RSI(14) above 60 (pullback in downtrend, snap-back likely)",
      "> 60",
      rsi14.toFixed(2),
      rsi14 > 60,
    );
  } else {
    console.log("  Bias: NEUTRAL — no clear direction. No trade.\n");
    results.push({
      label: "Market bias",
      required: "Bullish or bearish",
      actual: "Neutral",
      pass: false,
    });
  }

  const allPass = results.every((r) => r.pass);
  return { results, allPass };
}

// ─── Trade Limits ────────────────────────────────────────────────────────────

function checkTradeLimits(log) {
  const todayCount = countTodaysTrades(log);

  console.log("\n── Trade Limits ─────────────────────────────────────────\n");

  if (todayCount >= CONFIG.maxTradesPerDay) {
    console.log(
      `🚫 Max trades per day reached: ${todayCount}/${CONFIG.maxTradesPerDay}`,
    );
    return false;
  }

  console.log(
    `✅ Trades today: ${todayCount}/${CONFIG.maxTradesPerDay} — within limit`,
  );

  const tradeSize = Math.min(
    CONFIG.portfolioValue * 0.01,
    CONFIG.maxTradeSizeUSD,
  );

  if (tradeSize > CONFIG.maxTradeSizeUSD) {
    console.log(
      `🚫 Trade size $${tradeSize.toFixed(2)} exceeds max $${CONFIG.maxTradeSizeUSD}`,
    );
    return false;
  }

  console.log(
    `✅ Trade size: $${tradeSize.toFixed(2)} — within max $${CONFIG.maxTradeSizeUSD}`,
  );

  return true;
}

// ─── Telegram Alerts ─────────────────────────────────────────────────────────
// Signal-only: this bot never places real orders. It notifies you so you can
// review and execute manually on the exchange.

async function sendTelegramAlert(message) {
  if (!CONFIG.telegram.botToken || !CONFIG.telegram.chatId) {
    console.log("⚠️  Telegram not configured — skipping alert (set TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID)");
    return;
  }

  const url = `https://api.telegram.org/bot${CONFIG.telegram.botToken}/sendMessage`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: CONFIG.telegram.chatId,
      text: message,
      parse_mode: "Markdown",
    }),
  });

  const data = await res.json();
  if (!res.ok || !data.ok) {
    throw new Error(`Telegram alert failed: ${data.description || JSON.stringify(data)}`);
  }
}

// ─── Tax CSV Logging ─────────────────────────────────────────────────────────

const CSV_FILE = "trades.csv";

// Always ensure trades.csv exists with headers — open it in Excel/Sheets any time
function initCsv() {
  if (!existsSync(CSV_FILE)) {
    const funnyNote = `,,,,,,,,,,,"NOTE","Hey, if you're at this stage of the video, you must be enjoying it... perhaps you could hit subscribe now? :)"`;
    writeFileSync(CSV_FILE, CSV_HEADERS + "\n" + funnyNote + "\n");
    console.log(
      `📄 Created ${CSV_FILE} — open in Google Sheets or Excel to track trades.`,
    );
  }
}
const CSV_HEADERS = [
  "Date",
  "Time (UTC)",
  "Exchange",
  "Symbol",
  "Side",
  "Quantity",
  "Price",
  "Total USD",
  "Fee (est.)",
  "Net Amount",
  "Order ID",
  "Mode",
  "Notes",
].join(",");

function writeTradeCsv(logEntry) {
  const now = new Date(logEntry.timestamp);
  const date = now.toISOString().slice(0, 10);
  const time = now.toISOString().slice(11, 19);

  let side = "";
  let quantity = "";
  let totalUSD = "";
  let fee = "";
  let netAmount = "";
  let orderId = "";
  let mode = "";
  let notes = "";

  if (!logEntry.allPass) {
    const failed = logEntry.conditions
      .filter((c) => !c.pass)
      .map((c) => c.label)
      .join("; ");
    mode = "BLOCKED";
    orderId = "BLOCKED";
    notes = `Failed: ${failed}`;
  } else {
    side = "BUY";
    quantity = (logEntry.tradeSize / logEntry.price).toFixed(6);
    totalUSD = logEntry.tradeSize.toFixed(2);
    orderId = logEntry.alertSent ? "ALERT_SENT" : "ALERT_FAILED";
    mode = "SIGNAL";
    notes = logEntry.error
      ? `Telegram alert failed: ${logEntry.error}`
      : "All conditions met — alert sent, no order placed";
  }

  const row = [
    date,
    time,
    "Binance",
    logEntry.symbol,
    side,
    quantity,
    logEntry.price.toFixed(2),
    totalUSD,
    fee,
    netAmount,
    orderId,
    mode,
    `"${notes}"`,
  ].join(",");

  if (!existsSync(CSV_FILE)) {
    writeFileSync(CSV_FILE, CSV_HEADERS + "\n");
  }

  appendFileSync(CSV_FILE, row + "\n");
  console.log(`Tax record saved → ${CSV_FILE}`);
}

// Tax summary command: node bot.js --tax-summary
function generateTaxSummary() {
  if (!existsSync(CSV_FILE)) {
    console.log("No trades.csv found — no trades have been recorded yet.");
    return;
  }

  const lines = readFileSync(CSV_FILE, "utf8").trim().split("\n");
  const rows = lines.slice(1).map((l) => l.split(","));

  const signals = rows.filter((r) => r[11] === "SIGNAL");
  const blocked = rows.filter((r) => r[11] === "BLOCKED");

  console.log("\n── Signal Summary ───────────────────────────────────────\n");
  console.log(`  Total decisions logged : ${rows.length}`);
  console.log(`  Signals sent (Telegram): ${signals.length}`);
  console.log(`  Blocked by safety check: ${blocked.length}`);
  console.log(`\n  Full record: ${CSV_FILE}`);
  console.log("─────────────────────────────────────────────────────────\n");
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function processSymbol(symbol, rules, log) {
  console.log(`\n═══ ${symbol} ═══════════════════════════════════════════\n`);

  // Fetch candle data
  console.log("── Fetching market data from Binance ───────────────────\n");
  const candles = await fetchCandles(symbol, CONFIG.timeframe, 500);
  const closes = candles.map((c) => c.close);
  const price = closes[closes.length - 1];
  console.log(`  Current price: $${price.toFixed(2)}`);

  // Calculate indicators
  const ema20 = calcEMA(closes, 20);
  const ema50 = calcEMA(closes, 50);
  const rsi14 = calcRSI(closes, 14);

  console.log(`  EMA(20): $${ema20.toFixed(2)}`);
  console.log(`  EMA(50): $${ema50.toFixed(2)}`);
  console.log(`  RSI(14): ${rsi14 ? rsi14.toFixed(2) : "N/A"}`);

  if (!rsi14) {
    console.log("\n⚠️  Not enough data to calculate indicators. Skipping.");
    return;
  }

  // Run safety check
  const { results, allPass } = runSafetyCheck(price, ema20, ema50, rsi14, rules);

  // Calculate position size
  const tradeSize = Math.min(
    CONFIG.portfolioValue * 0.01,
    CONFIG.maxTradeSizeUSD,
  );

  // Decision
  console.log("\n── Decision ─────────────────────────────────────────────\n");

  const logEntry = {
    timestamp: new Date().toISOString(),
    symbol,
    timeframe: CONFIG.timeframe,
    price,
    indicators: { ema20, ema50, rsi14 },
    conditions: results,
    allPass,
    tradeSize,
    alertSent: false,
    limits: {
      maxTradeSizeUSD: CONFIG.maxTradeSizeUSD,
      maxTradesPerDay: CONFIG.maxTradesPerDay,
      tradesToday: countTodaysTrades(log),
    },
  };

  if (!allPass) {
    const failed = results.filter((r) => !r.pass).map((r) => r.label);
    console.log(`🚫 NO SIGNAL`);
    console.log(`   Failed conditions:`);
    failed.forEach((f) => console.log(`   - ${f}`));
  } else {
    console.log(`✅ ALL CONDITIONS MET — sending Telegram alert`);
    const message =
      `🔔 *Signal: BUY ${symbol}*\n` +
      `Price: $${price.toFixed(2)}\n` +
      `EMA(20): $${ema20.toFixed(2)} | EMA(50): $${ema50.toFixed(2)}\n` +
      `RSI(14): ${rsi14.toFixed(2)}\n` +
      `Suggested size: ~$${tradeSize.toFixed(2)}\n\n` +
      `_This is a signal only — no order was placed. Review and execute manually._`;

    try {
      await sendTelegramAlert(message);
      logEntry.alertSent = true;
      console.log(`✅ ALERT SENT to Telegram`);
    } catch (err) {
      console.log(`❌ ALERT FAILED — ${err.message}`);
      logEntry.error = err.message;
    }
  }

  // Save decision log
  log.trades.push(logEntry);
  saveLog(log);

  // Write tax CSV row for every run (signal or blocked)
  writeTradeCsv(logEntry);
}

async function run() {
  checkOnboarding();
  initCsv();
  console.log("═══════════════════════════════════════════════════════════");
  console.log("  Claude Trading Signal Bot");
  console.log(`  ${new Date().toISOString()}`);
  console.log(`  Mode: 🔔 SIGNAL ONLY — no orders are ever placed`);
  console.log("═══════════════════════════════════════════════════════════");

  // Load strategy
  const rules = JSON.parse(readFileSync("rules.json", "utf8"));
  const watchlist = rules.watchlist && rules.watchlist.length > 0
    ? rules.watchlist
    : [CONFIG.symbol];
  console.log(`\nStrategy: ${rules.strategy.name}`);
  console.log(`Watchlist: ${watchlist.join(", ")} | Timeframe: ${CONFIG.timeframe}`);

  for (const symbol of watchlist) {
    const log = loadLog();
    const withinLimits = checkTradeLimits(log);
    if (!withinLimits) {
      console.log(`\nBot stopping — daily signal limit reached. Skipping remaining symbols.`);
      break;
    }
    await processSymbol(symbol, rules, log);
  }

  console.log("\n═══════════════════════════════════════════════════════════\n");
}

if (process.argv.includes("--tax-summary")) {
  generateTaxSummary();
} else {
  run().catch((err) => {
    console.error("Bot error:", err);
    process.exit(1);
  });
}
