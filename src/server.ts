import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { listStocks, scanBoard } from "./lib/tape.js";
import { buildTape } from "./lib/tape.js";
import { buildSwap, quoteTrade } from "./lib/jupiter.js";
import { lpPlan } from "./lib/meteora.js";
import { listReceipts, stampTx } from "./lib/receipts.js";
import { arm, deskTick, exportKey, ingestDeposits, publicDesk, snapshot, withdraw } from "./lib/desk.js";
import { disarm } from "./lib/ledger.js";

dotenv.config({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", ".env") });

const WEB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "web");
const PORT = Number(process.env.PORT || process.env.MARKFILL_PORT || 4810);
const HOST = process.env.HOST || "0.0.0.0";

function json(res: http.ServerResponse, code: number, body: unknown) {
  res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

function readBody(req: http.IncomingMessage) {
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c as Buffer));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host}`);
  try {
    if (url.pathname === "/api/stocks") {
      json(res, 200, listStocks());
      return;
    }
    if (url.pathname === "/api/tape") {
      const ticker = url.searchParams.get("ticker") || "AAPL";
      const band = Number(url.searchParams.get("band") || 50);
      json(res, 200, await buildTape(ticker, band));
      return;
    }
    if (url.pathname === "/api/board") {
      const band = Number(url.searchParams.get("band") || 50);
      json(res, 200, await scanBoard(band));
      return;
    }
    if (url.pathname === "/api/quote" && req.method === "POST") {
      const body = JSON.parse((await readBody(req)) || "{}");
      json(
        res,
        200,
        await quoteTrade({
          ticker: body.ticker,
          usd: Number(body.usd || 10),
          bandBps: Number(body.bandBps || 50),
          side: body.side === "sell" ? "sell" : "buy",
          slippageBps: Number(body.slippageBps || 50),
        }),
      );
      return;
    }
    if (url.pathname === "/api/swap" && req.method === "POST") {
      const body = JSON.parse((await readBody(req)) || "{}");
      try {
        json(
          res,
          200,
          await buildSwap({
            ticker: body.ticker,
            usd: Number(body.usd || 10),
            bandBps: Number(body.bandBps || 50),
            userPublicKey: String(body.userPublicKey || ""),
            side: body.side === "sell" ? "sell" : "buy",
            slippageBps: Number(body.slippageBps || 50),
          }),
        );
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        const code = (e as { code?: string }).code === "GATED" ? 409 : 500;
        json(res, code, { error: msg, gated: code === 409 });
      }
      return;
    }
    if (url.pathname === "/api/receipts") {
      json(res, 200, listReceipts());
      return;
    }
    if (url.pathname === "/api/receipts/tx" && req.method === "POST") {
      const body = JSON.parse((await readBody(req)) || "{}");
      json(res, 200, await stampTx(String(body.id || ""), String(body.tx || "")));
      return;
    }
    if (url.pathname === "/api/desk" && req.method === "GET") {
      const owner = String(url.searchParams.get("owner") || "").trim();
      json(res, 200, await publicDesk(owner || undefined));
      return;
    }
    if (url.pathname === "/api/desk/me" && req.method === "GET") {
      const owner = String(url.searchParams.get("owner") || "").trim();
      if (!owner) throw new Error("owner required");
      json(res, 200, snapshot(owner));
      return;
    }
    if (url.pathname === "/api/desk/scan" && req.method === "POST") {
      const body = JSON.parse((await readBody(req)) || "{}");
      json(res, 200, await ingestDeposits(body.owner ? String(body.owner) : undefined));
      return;
    }
    if (url.pathname === "/api/desk/export" && req.method === "POST") {
      const body = JSON.parse((await readBody(req)) || "{}");
      json(res, 200, exportKey(String(body.owner || ""), String(body.message || ""), String(body.signature || "")));
      return;
    }
    if (url.pathname === "/api/desk/arm" && req.method === "POST") {
      const body = JSON.parse((await readBody(req)) || "{}");
      json(
        res,
        200,
        await arm({
          owner: String(body.owner || ""),
          ticker: String(body.ticker || ""),
          usd: Number(body.usd || 0),
          bandBps: Number(body.bandBps || 50),
          side: body.side === "sell" ? "sell" : "buy",
        }),
      );
      return;
    }
    if (url.pathname === "/api/desk/disarm" && req.method === "POST") {
      const body = JSON.parse((await readBody(req)) || "{}");
      disarm(String(body.owner || ""), body.ticker ? String(body.ticker) : undefined);
      json(res, 200, { ok: true });
      return;
    }
    if (url.pathname === "/api/desk/withdraw" && req.method === "POST") {
      const body = JSON.parse((await readBody(req)) || "{}");
      json(
        res,
        200,
        await withdraw({
          owner: String(body.owner || ""),
          kind: body.kind === "token" ? "token" : "usdc",
          ticker: body.ticker,
          amount: Number(body.amount || 0),
        }),
      );
      return;
    }
    if (url.pathname === "/api/lp") {
      const ticker = url.searchParams.get("ticker") || "AAPL";
      const band = Number(url.searchParams.get("band") || 50);
      json(res, 200, await lpPlan(ticker, band));
      return;
    }

    let file = path.join(WEB, url.pathname === "/" ? "index.html" : url.pathname);
    if (!file.startsWith(WEB)) {
      json(res, 403, { error: "no" });
      return;
    }
    if (!fs.existsSync(file)) file = path.join(WEB, "index.html");
    const ext = path.extname(file);
    const type =
      ext === ".html" ? "text/html; charset=utf-8"
      : ext === ".js" ? "text/javascript"
      : ext === ".png" ? "image/png"
      : ext === ".jpg" || ext === ".jpeg" ? "image/jpeg"
      : ext === ".ico" ? "image/x-icon"
      : ext === ".svg" ? "image/svg+xml"
      : ext === ".webp" ? "image/webp"
      : "text/plain";
    res.writeHead(200, { "content-type": type });
    fs.createReadStream(file).pipe(res);
  } catch (e) {
    json(res, 500, { error: e instanceof Error ? e.message : String(e) });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`MarkFill desk  http://${HOST}:${PORT}`);
  void deskTick();
  setInterval(() => void deskTick(), 8000);
});
