// Claude Execute — Terminal dashboard
// Zero-dependency local web server. Serves the dashboard UI and the bot's data files.
//
//   node dashboard/server.cjs
//   open http://localhost:3737

const http = require("http");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const PORT = process.env.DASHBOARD_PORT || 3737;

// Minimal .env loader — no dependency on dotenv
(() => {
  const envPath = path.join(ROOT, ".env");
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, "utf8").split("\n");
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    // strip optional trailing comment (only if separated by whitespace)
    const hashIdx = val.search(/\s+#/);
    if (hashIdx !== -1) val = val.slice(0, hashIdx).trim();
    // strip surrounding quotes
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
})();

const send = (res, status, body, headers = {}) => {
  res.writeHead(status, {
    "Cache-Control": "no-store",
    ...headers,
  });
  res.end(body);
};

const serveFile = (res, filePath, contentType) => {
  fs.readFile(filePath, (err, data) => {
    if (err) return send(res, 500, err.message);
    send(res, 200, data, { "Content-Type": contentType });
  });
};

const server = http.createServer((req, res) => {
  const url = req.url.split("?")[0];

  if (url === "/" || url === "/index.html") {
    return serveFile(res, path.join(__dirname, "index.html"), "text/html; charset=utf-8");
  }

  if (url === "/api/log") {
    const p = path.join(ROOT, "safety-check-log.json");
    if (!fs.existsSync(p)) {
      return send(res, 200, '{"trades":[]}', { "Content-Type": "application/json" });
    }
    return serveFile(res, p, "application/json");
  }

  if (url === "/api/csv") {
    const p = path.join(ROOT, "trades.csv");
    if (!fs.existsSync(p)) return send(res, 200, "", { "Content-Type": "text/plain" });
    return serveFile(res, p, "text/plain");
  }

  if (url === "/api/rules") {
    const p = path.join(ROOT, "rules.json");
    if (!fs.existsSync(p)) return send(res, 200, "{}", { "Content-Type": "application/json" });
    return serveFile(res, p, "application/json");
  }

  if (url === "/api/env") {
    // Surface only safe-to-display config (no secrets)
    const env = {
      symbol: process.env.SYMBOL || "BTCUSDT",
      timeframe: process.env.TIMEFRAME || "4H",
      portfolio: Number(process.env.PORTFOLIO_VALUE_USD) || null,
      maxTradeUSD: Number(process.env.MAX_TRADE_SIZE_USD) || null,
      maxTradesPerDay: Number(process.env.MAX_TRADES_PER_DAY) || null,
      paperTrading: (process.env.PAPER_TRADING || "true") === "true",
    };
    return send(res, 200, JSON.stringify(env), { "Content-Type": "application/json" });
  }

  send(res, 404, "Not found");
});

server.listen(PORT, () => {
  const banner = [
    "",
    "  ╔══════════════════════════════════════════╗",
    "  ║  CLAUDE EXECUTE  ::  TERMINAL DASHBOARD  ║",
    "  ╚══════════════════════════════════════════╝",
    "",
    `  ▸ http://localhost:${PORT}`,
    "",
    "  Press Ctrl+C to stop.",
    "",
  ].join("\n");
  console.log(banner);
});
