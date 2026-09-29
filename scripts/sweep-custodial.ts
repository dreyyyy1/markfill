/**
 * ONE-TIME sweep of old HMAC desk wallets back to each owner.
 *
 * Local data/ is empty — real desks live on Render. Pull them:
 *   npx tsx scripts/sweep-custodial.ts --from-url https://markfill.onrender.com
 * One wallet:
 *   npx tsx scripts/sweep-custodial.ts --owner YOUR_MAIN_WALLET
 * Send for real:
 *   npx tsx scripts/sweep-custodial.ts --from-url https://markfill.onrender.com --live
 */
import dotenv from "dotenv";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PublicKey } from "@solana/web3.js";
import { STOCKS, USDC } from "../src/lib/stocks.js";
import { connection, deskKeypair, onchainBalances, sendTokens } from "../src/lib/custody.js";
import { listOwners } from "../src/lib/ledger.js";

dotenv.config({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", ".env") });

const live = process.argv.includes("--live");
const fromUrl = flagValue("--from-url");
const onlyOwner = flagValue("--owner");

function flagValue(name: string) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : "";
}

async function owners(): Promise<string[]> {
  if (onlyOwner) return [onlyOwner.trim()];
  const local = listOwners();
  try {
    const desks = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), "data", "desks.json"), "utf8"));
    local.push(...Object.keys(desks));
  } catch {
    /* none */
  }
  if (fromUrl) {
    const res = await fetch(fromUrl.replace(/\/$/, "") + "/api/desk/owners");
    const json = (await res.json()) as { owners?: { owner: string }[] };
    for (const o of json.owners || []) if (o.owner) local.push(o.owner);
  }
  return [...new Set(local)];
}

async function main() {
  const list = await owners();
  console.log(`sweep ${list.length} desk(s)  live=${live}`);
  if (!list.length) {
    console.log("No desks on this PC. Use --from-url https://markfill.onrender.com or --owner <your wallet>");
    return;
  }
  for (const owner of list) {
    const kp = deskKeypair(owner);
    const bal = await onchainBalances(owner);
    console.log(owner.slice(0, 8) + "…  desk " + kp.publicKey.toBase58() + "  SOL " + bal.sol + "  USDC " + bal.usdc);
    if (!live) continue;
    if (bal.usdc > 0.000001) {
      const r = await sendTokens({ owner, mint: USDC, to: owner, amount: bal.usdc, decimals: 6 });
      console.log("  usdc", r.signature);
    }
    for (const s of bal.stocks) {
      const stock = STOCKS.find((x) => x.ticker === s.ticker);
      if (!stock || s.shares <= 0) continue;
      const r = await sendTokens({ owner, mint: stock.mint, to: owner, amount: s.shares, decimals: stock.decimals });
      console.log("  ", s.ticker, r.signature);
    }
    const conn = connection();
    const lamports = await conn.getBalance(kp.publicKey);
    if (lamports > 5000) {
      const { SystemProgram, Transaction, sendAndConfirmTransaction } = await import("@solana/web3.js");
      const tx = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: kp.publicKey,
          toPubkey: new PublicKey(owner),
          lamports: lamports - 5000,
        }),
      );
      const sig = await sendAndConfirmTransaction(conn, tx, [kp]);
      console.log("  sol", sig);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
