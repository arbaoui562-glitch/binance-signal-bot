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
import crypto from "crypto";

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
  // Read-only Binance account access for portfolio context — these vars use the
  // BITGET_ prefix for historical reasons but hold Binance credentials (see CLAUDE.md)
  binance: {
    apiKey: process.env.BITGET_API_KEY,
    secretKey: process.env.BITGET_SECRET_KEY,
    baseUrl: process.env.BITGET_BASE_URL || "https://api.binance.com",
  },
};

// Maps a trading symbol to its base asset + a human-readable name for news search
const ASSET_NAMES = {
  BTC: "Bitcoin",
  ETH: "Ethereum",
  SOL: "Solana",
  BNB: "BNB",
  XRP: "XRP",
  ADA: "Cardano",
  DOGE: "Dogecoin",
};

function getBaseAsset(symbol) {
  const quoteCurrencies = ["USDT", "USDC", "EUR", "USD", "BUSD", "BTC"];
  for (const quote of quoteCurrencies) {
    if (symbol.endsWith(quote) && symbol.length > quote.length) {
      return symbol.slice(0, -quote.length);
    }
  }
  return symbol;
}

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

// ─── Quantitative Analysis ───────────────────────────────────────────────────
// All figures below are statistical calculations on historical candle data —
// not predictions, guarantees, or personalized advice. They describe what has
// happened and what current volatility implies; they don't tell you what to do.

// Average True Range — measures recent volatility per candle
function calcATR(candles, period = 14) {
  if (candles.length < period + 1) return null;
  const trueRanges = [];
  for (let i = 1; i < candles.length; i++) {
    const { high, low } = candles[i];
    const prevClose = candles[i - 1].close;
    trueRanges.push(Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose)));
  }
  const recent = trueRanges.slice(-period);
  return recent.reduce((a, b) => a + b, 0) / recent.length;
}

// Nearest support/resistance from recent swing lows/highs (excludes the
// current candle so the level isn't trivially equal to the live price)
function findSupportResistance(candles, lookback = 50) {
  const window = candles.slice(-(lookback + 1), -1);
  if (window.length === 0) return { support: null, resistance: null };
  const support = Math.min(...window.map((c) => c.low));
  const resistance = Math.max(...window.map((c) => c.high));
  return { support, resistance };
}

// Statistical price range implied by volatility (random-walk scaling: ATR * sqrt(bars))
function projectVolatilityRange(price, atr, bars) {
  if (!atr) return null;
  const spread = atr * Math.sqrt(bars);
  return { low: price - spread, high: price + spread };
}

// Trend strength — how far apart the two EMAs are, as a % of price
function trendStrength(ema20, ema50) {
  const gapPct = (Math.abs(ema20 - ema50) / ema50) * 100;
  let label;
  if (gapPct < 0.5) label = "Faible";
  else if (gapPct < 2) label = "Modérée";
  else label = "Forte";
  return { gapPct, label };
}

// Historical backtest: among past candles where the SAME entry condition
// held, what fraction of the time did price move in the expected direction
// `lookForwardBars` later? This describes the strategy's past behavior on
// this asset's own history — it is not a forecast of what will happen next.
function backtestWinRate(candles, direction, lookForwardBars = 6) {
  const closes = candles.map((c) => c.close);
  const minIndex = 50; // need enough candles for EMA(50) to be meaningful
  const maxIndex = closes.length - lookForwardBars - 1;
  let matches = 0;
  let wins = 0;

  for (let i = minIndex; i < maxIndex; i++) {
    const windowCloses = closes.slice(0, i + 1);
    const ema20_i = calcEMA(windowCloses, 20);
    const ema50_i = calcEMA(windowCloses, 50);
    const rsi14_i = calcRSI(windowCloses, 14);
    if (rsi14_i === null) continue;

    const conditionMet =
      direction === "long"
        ? ema20_i > ema50_i && rsi14_i < 40
        : ema20_i < ema50_i && rsi14_i > 60;

    if (!conditionMet) continue;
    matches++;

    const entryPrice = closes[i];
    const futurePrice = closes[i + lookForwardBars];
    const wentUp = futurePrice > entryPrice;
    if ((direction === "long" && wentUp) || (direction === "short" && !wentUp)) {
      wins++;
    }
  }

  return { matches, wins, winRate: matches > 0 ? (wins / matches) * 100 : null };
}

// Translates the calculations above into a plain-language paragraph.
// This restates what the numbers show — it does not add a recommendation.
function buildPlainSummary({ direction, strength, price, support, resistance, range7d, backtest }) {
  const trendWord = direction === "long" ? "haussière" : "baissière";
  const signalLabel = direction === "long" ? "POSITIF (haussier)" : "NÉGATIF (baissier)";
  const signalPart = `Signal jugé ${signalLabel}.`;
  const trendPart = `La tendance actuelle est ${trendWord}, et elle est jugée ${strength.label.toLowerCase()} (écart entre les deux moyennes mobiles : ${strength.gapPct.toFixed(2)}%).`;

  let positionPart = "";
  if (support !== null && resistance !== null && resistance > support) {
    const posPct = ((price - support) / (resistance - support)) * 100;
    if (posPct < 33) {
      positionPart = `Le prix est actuellement proche du support ($${support.toFixed(2)}) — historiquement une zone où le prix a déjà rebondi.`;
    } else if (posPct > 67) {
      positionPart = `Le prix est actuellement proche de la résistance ($${resistance.toFixed(2)}) — historiquement une zone où le prix a déjà buté.`;
    } else {
      positionPart = `Le prix se trouve entre le support ($${support.toFixed(2)}) et la résistance ($${resistance.toFixed(2)}), sans être proche de l'un ou l'autre.`;
    }
  }

  const rangePart = range7d
    ? `Sur les 7 prochains jours, la volatilité récente de l'actif suggère statistiquement une fourchette de prix entre $${range7d.low.toFixed(2)} et $${range7d.high.toFixed(2)} — pas une limite garantie, juste l'amplitude habituelle des mouvements récents.`
    : "";

  let backtestPart = "Il n'y a pas assez d'occurrences passées de cette même situation pour en tirer une statistique fiable.";
  if (backtest.matches > 0) {
    if (backtest.winRate >= 55) {
      backtestPart = `Par le passé, quand cette même situation s'est produite sur cet actif (${backtest.matches} fois), le prix a évolué dans le sens attendu ${backtest.winRate.toFixed(0)}% du temps — un léger biais historique en faveur de ce scénario, sans certitude pour autant.`;
    } else if (backtest.winRate <= 45) {
      backtestPart = `Par le passé, quand cette même situation s'est produite sur cet actif (${backtest.matches} fois), le prix a évolué dans le sens attendu seulement ${backtest.winRate.toFixed(0)}% du temps — l'historique ne soutient pas vraiment ce scénario, à interpréter avec prudence.`;
    } else {
      backtestPart = `Par le passé, quand cette même situation s'est produite sur cet actif (${backtest.matches} fois), le résultat a été proche du hasard (${backtest.winRate.toFixed(0)}%) — l'historique ne montre pas d'avantage clair dans un sens ou l'autre.`;
    }
  }

  return [signalPart, trendPart, positionPart, rangePart, backtestPart].filter(Boolean).join(" ");
}

// ─── Outcome Tracking ────────────────────────────────────────────────────────
// Checks past alerts against what actually happened, so the bot's own track
// record (not just the historical backtest) can be reported.

const EVAL_HORIZON_MS = 24 * 60 * 60 * 1000; // matches the 24h volatility/backtest window

async function getCurrentPrice(symbol) {
  const res = await fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${symbol}`);
  if (!res.ok) return null;
  const data = await res.json();
  return parseFloat(data.price);
}

// Finds alerts sent 24h+ ago that haven't been graded yet, fetches the
// current price for each, and records whether the price moved the way the
// signal implied. Mutates and saves the log in place.
async function evaluateMaturedSignals(log) {
  const now = Date.now();
  const matured = log.trades.filter(
    (t) => t.alertSent && !t.evaluated && now - new Date(t.timestamp).getTime() >= EVAL_HORIZON_MS,
  );

  if (matured.length === 0) return;

  console.log(`\n── Grading ${matured.length} matured alert(s) ──────────────────────\n`);

  const priceCache = {};
  for (const entry of matured) {
    if (!(entry.symbol in priceCache)) {
      priceCache[entry.symbol] = await getCurrentPrice(entry.symbol);
    }
    const currentPrice = priceCache[entry.symbol];
    if (currentPrice === null) continue;

    const wentUp = currentPrice > entry.price;
    const outcome =
      (entry.direction === "long" && wentUp) || (entry.direction === "short" && !wentUp)
        ? "win"
        : "loss";

    entry.evaluated = true;
    entry.evalPrice = currentPrice;
    entry.evalTimestamp = new Date(now).toISOString();
    entry.outcome = outcome;

    console.log(
      `  ${entry.symbol} signal from ${entry.timestamp} → ${outcome.toUpperCase()} ` +
        `(entry $${entry.price.toFixed(2)} → now $${currentPrice.toFixed(2)})`,
    );
  }

  saveLog(log);
}

// Builds the bot's own historical track record for a symbol — distinct from
// backtestWinRate, which uses candle history rather than this bot's actual alerts.
function getTrackRecord(log, symbol, limit = 5) {
  const evaluated = log.trades
    .filter((t) => t.symbol === symbol && t.evaluated)
    .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
    .slice(0, limit);

  if (evaluated.length === 0) {
    return "Pas encore d'alerte évaluée pour cet actif (il faut 24h après une alerte pour la noter).";
  }

  const wins = evaluated.filter((t) => t.outcome === "win").length;
  return (
    `${wins}/${evaluated.length} de tes ${evaluated.length} dernières alertes sur ${symbol} ` +
    `ont été suivies d'un mouvement dans le sens attendu, 24h plus tard.`
  );
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

// ─── Portfolio Context (read-only) ──────────────────────────────────────────
// Reads current balances so alerts can mention what you already hold.
// This NEVER places orders or modifies the account in any way.

function signBinanceQuery(queryString) {
  return crypto
    .createHmac("sha256", CONFIG.binance.secretKey)
    .update(queryString)
    .digest("hex");
}

async function getAccountBalances() {
  if (!CONFIG.binance.apiKey || !CONFIG.binance.secretKey) {
    console.log("⚠️  Binance API credentials not set — skipping portfolio context");
    return null;
  }

  const params = new URLSearchParams({
    timestamp: Date.now().toString(),
    recvWindow: "5000",
  });
  params.append("signature", signBinanceQuery(params.toString()));

  const res = await fetch(`${CONFIG.binance.baseUrl}/api/v3/account?${params.toString()}`, {
    headers: { "X-MBX-APIKEY": CONFIG.binance.apiKey },
  });

  const data = await res.json();
  if (!res.ok) {
    console.log(`⚠️  Could not read Binance account balances: ${data.msg || res.status}`);
    return null;
  }

  return data.balances
    .map((b) => ({ asset: b.asset, free: parseFloat(b.free), locked: parseFloat(b.locked) }))
    .filter((b) => b.free + b.locked > 0);
}

function findBalance(balances, asset) {
  if (!balances) return null;
  const match = balances.find((b) => b.asset === asset);
  return match ? match.free + match.locked : 0;
}

// ─── News Headlines (Google News RSS — free, no API key) ───────────────────

async function fetchNewsHeadlines(query, limit = 15) {
  try {
    const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=fr&gl=FR&ceid=FR:fr`;
    const res = await fetch(url);
    if (!res.ok) return [];
    const xml = await res.text();
    const titles = [...xml.matchAll(/<title>(.*?)<\/title>/g)]
      .map((m) => m[1])
      // First <title> is always the feed/channel title (e.g. "Solana crypto - Google Actualités") — drop it
      .slice(1)
      // RSS uses a non-breaking space inside "Google Actualités" — normalize before comparing
      .filter((t) => {
        const normalized = t.replace(/ /g, " ");
        return normalized !== "Google News" && normalized !== "Google Actualités";
      });
    return titles.slice(0, limit);
  } catch (err) {
    console.log(`⚠️  Could not fetch news: ${err.message}`);
    return [];
  }
}

// Keyword-based thematic analysis of headline content — free, no LLM call.
// Counts mentions per theme across the fetched headlines and reports which
// theme(s) dominate, instead of just listing raw titles.
const NEWS_THEMES = {
  hausse: ["hausse", "record", "rebond", "explose", "grimpe", "bondit", "rallye", "reprise", "haussier", "monte", "gagne", "accélère"],
  baisse: ["baisse", "chute", "recul", "crash", "plonge", "dégringole", "pression", "perd", "baissier", "liquidée", "liquidation", "décroche", "panique", "déroute"],
  regulation: ["régulation", "sec ", "loi", "interdiction", "réglementation", "autorité", "amende", "poursuite"],
  adoption: ["adoption", "partenariat", "intègre", "accepte", "banque", "validateur", "stablecoin", "paiement", "lance", "s'associe"],
  risque: ["risque", "alerte", "inquiétude", "prudence", "volatilité", "instabilité"],
};

const NEWS_THEME_LABELS = {
  hausse: "hausse",
  baisse: "baisse",
  regulation: "régulation",
  adoption: "adoption / partenariats",
  risque: "risque / prudence",
};

function summarizeNewsThemes(asset, headlines) {
  if (headlines.length === 0) {
    return `Aucune actualité récente trouvée pour ${asset}.`;
  }

  const counts = Object.fromEntries(Object.keys(NEWS_THEMES).map((t) => [t, 0]));
  for (const headline of headlines) {
    const lower = headline.toLowerCase();
    for (const [theme, keywords] of Object.entries(NEWS_THEMES)) {
      if (keywords.some((k) => lower.includes(k))) counts[theme]++;
    }
  }

  const ranked = Object.entries(counts)
    .filter(([, count]) => count > 0)
    .sort((a, b) => b[1] - a[1]);

  if (ranked.length === 0) {
    return `${headlines.length} titres récents trouvés pour ${asset}, sans thème dominant clair détecté automatiquement parmi hausse/baisse/régulation/adoption/risque.`;
  }

  const top = ranked
    .slice(0, 2)
    .map(([theme, count]) => `${NEWS_THEME_LABELS[theme]} (${count} mention${count > 1 ? "s" : ""})`)
    .join(", ");

  return `Sur les ${headlines.length} derniers titres trouvés pour ${asset}, le(s) thème(s) dominant(s) sont : ${top}. (Détection automatique par mots-clés, pas une analyse de sentiment poussée.)`;
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
    direction: allPass ? (ema20 > ema50 ? "long" : "short") : null,
    tradeSize,
    alertSent: false,
    // Outcome tracking — filled in later by evaluateMaturedSignals() once
    // enough time has passed to check whether the price moved as expected
    evaluated: false,
    outcome: null,
    evalPrice: null,
    evalTimestamp: null,
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
    console.log(`✅ ALL CONDITIONS MET — gathering context for alert`);

    const baseAsset = getBaseAsset(symbol);
    const quoteAsset = symbol.slice(baseAsset.length);
    const direction = ema20 > ema50 ? "long" : "short";

    // Portfolio context — read-only, never places or modifies anything
    const balances = await getAccountBalances();
    const heldAmount = findBalance(balances, baseAsset);
    const quoteAvailable = findBalance(balances, quoteAsset);

    let portfolioLines = "Portfolio: not available (Binance API not configured)";
    if (balances) {
      const heldValue = heldAmount !== null ? (heldAmount * price).toFixed(2) : "0.00";
      portfolioLines =
        `Currently held: ${heldAmount?.toFixed(6) ?? 0} ${baseAsset} (~${heldValue} ${quoteAsset})\n` +
        `Available to buy: ${quoteAvailable?.toFixed(2) ?? 0} ${quoteAsset}`;
    }

    // News context — thematic synthesis, not a list of raw headlines
    const newsQuery = ASSET_NAMES[baseAsset] || baseAsset;
    const headlines = await fetchNewsHeadlines(`${newsQuery} crypto`);
    const newsLines = summarizeNewsThemes(newsQuery, headlines);

    // Quantitative analysis — all derived from historical candle data, see
    // calcATR/findSupportResistance/projectVolatilityRange/backtestWinRate
    const atr = calcATR(candles, 14);
    const { support, resistance } = findSupportResistance(candles, 50);
    const range24h = projectVolatilityRange(price, atr, 6); // 6 bars * 4H = 24h
    const range7d = projectVolatilityRange(price, atr, 42); // 42 bars * 4H = 7d
    const strength = trendStrength(ema20, ema50);
    const backtest = backtestWinRate(candles, direction, 6);

    const quantLines =
      `Support: $${support?.toFixed(2) ?? "N/A"} | Resistance: $${resistance?.toFixed(2) ?? "N/A"}\n` +
      `Fourchette probable 24h (volatilité): $${range24h?.low.toFixed(2) ?? "N/A"} – $${range24h?.high.toFixed(2) ?? "N/A"}\n` +
      `Fourchette probable 7j (volatilité): $${range7d?.low.toFixed(2) ?? "N/A"} – $${range7d?.high.toFixed(2) ?? "N/A"}\n` +
      `Force de tendance: ${strength.label} (écart EMA ${strength.gapPct.toFixed(2)}%)\n` +
      `Historique (même condition, ${candles.length} dernières bougies): ` +
      (backtest.matches > 0
        ? `${backtest.wins}/${backtest.matches} cas (${backtest.winRate.toFixed(0)}%) ont vu le prix évoluer dans le sens attendu ${6} bougies plus tard`
        : "pas assez d'occurrences passées pour calculer un taux fiable");

    const plainSummary = buildPlainSummary({
      direction,
      strength,
      price,
      support,
      resistance,
      range7d,
      backtest,
    });

    // Bot's own track record — distinct from backtestWinRate (which uses
    // candle history). This reflects what actually happened after THIS bot's
    // own past alerts on this symbol.
    const trackRecord = getTrackRecord(log, symbol);

    const message =
      `🔔 *Signal: ${symbol}* — entry conditions met\n\n` +
      `*Technical*\n` +
      `Price: $${price.toFixed(2)}\n` +
      `EMA(20): $${ema20.toFixed(2)} | EMA(50): $${ema50.toFixed(2)}\n` +
      `RSI(14): ${rsi14.toFixed(2)}\n` +
      `Suggested size: ~$${tradeSize.toFixed(2)}\n\n` +
      `*Analyse quantitative*\n${quantLines}\n\n` +
      `*Your portfolio*\n${portfolioLines}\n\n` +
      `*Actualités — ${newsQuery}*\n${newsLines}\n\n` +
      `*En résumé*\n${plainSummary}\n\n` +
      `*Bilan des alertes précédentes*\n${trackRecord}\n\n` +
      `⚠️ _Ceci n'est pas un conseil financier. Ces chiffres sont des calculs statistiques sur des données passées (volatilité, historique), pas une prédiction garantie. La décision d'achat ou de vente t'appartient entièrement. No order was placed._`;

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

  // Grade any past alerts that are now 24h+ old, before sending new ones
  await evaluateMaturedSignals(loadLog());

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
