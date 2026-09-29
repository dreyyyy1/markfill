/**
 * ONE-TIME: send all SOL/USDC/xStocks from old HMAC desk wallets back to each owner.
 * Run BEFORE deleting data/master.key, data/desks.json, or MARKFILL_SECRET.
 *
 *   npx tsx scripts/sweep-custodial.ts --dry-run
 *   npx tsx scripts/sweep-custodial.ts --live
 */
import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PublicKey } from "@solana/web3.js";
import { STOCKS, USDC } from "../src/lib/stocks.js";
import {
  connection,
  deskKeypair,
  onchainBalances,
  sendTokens,
} from "../src/lib/custody.js";
import { listOwners } from "../src/lib/ledger.js";

dotenv.config({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", ".env") });

const live = process.argv.includes("--live");

async function main() {
  const owners = listOwners();
  console.log(`sweep ${owners.length} desk(s)  live=${live}`);
  for (const owner of owners) {
    const kp = deskKeypair(owner);
    const bal = await onchainBalances(owner);
    console.log(owner, "desk", kp.publicKey.toBase58(), "sol", bal.sol, "usdc", bal.usdc, "stocks", bal.stocks.length);
    if (!live) continue;
    if (bal.usdc > 0.000001) {
      const r = await sendTokens({ owner, mint: USDC, to: owner, amount: bal.usdc, decimals: 6 });
      console.log("  usdc", r.signature);
    }
    for (const s of bal.stocks) {
      const stock = STOCKS.find((x) => x.ticker === s.ticker);
      if (!stock || s.shares <= 0) continue;
      const r = await sendTokens({
        owner,
        mint: stock.mint,
        to: owner,
        amount: s.shares,
        decimals: stock.decimals,
      });
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
