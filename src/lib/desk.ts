import { ComputeBudgetProgram, PublicKey, Transaction, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { buildTape } from "./tape.js";
import { quoteTrade } from "./jupiter.js";
import { receiptFromTape } from "./receipts.js";
import {
  applyFill,
  creditDeposit,
  debitWithdraw,
  disarm,
  getUser,
  listArms,
  listOwners,
  seenSig,
  setArm,
  userArms,
  type ArmOrder,
} from "./ledger.js";
import {
  connection,
  deskInfo,
  deskKeypair,
  exportDeskSecret,
  isLive,
  keeperKeypair,
  onchainBalances,
  scanUsdcDeposits,
  sendTokens,
} from "./custody.js";
import { STOCKS, USDC, stockByTicker } from "./stocks.js";
import { oid, vaultMode } from "./auth.js";
import {
  JUPITER_V6,
  executeFillIx,
  initializeVaultIx,
  listOpenOrders,
  placeOrderIx,
  txToB64,
  vaultPda,
  vaultStockAta,
  vaultUsdcAta,
  withdrawIx,
  type OpenOrder,
} from "./vault.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddress,
} from "@solana/spl-token";

const JUP = "https://lite-api.jup.ag/swap/v1";

export async function publicDesk(owner?: string) {
  if (!vaultMode()) return deskInfo(owner);
  if (!owner) {
    return {
      live: true,
      perUser: true,
      vault: true,
      note: "Connect your wallet. Your vault is a PDA only you can withdraw from.",
    };
  }
  const user = new PublicKey(oid(owner));
  const { vault, ata } = await vaultUsdcAta(user);
  return {
    live: true,
    perUser: true,
    vault: true,
    address: ata.toBase58(),
    vaultPda: vault.toBase58(),
    note: "This ATA is owned by your vault PDA. You sign deposit, arm, and withdraw. The keeper cannot steal.",
  };
}

export async function ingestDeposits(owner?: string) {
  const owners = owner ? [owner] : listOwners();
  const credited = [];
  for (const o of owners) {
    const hits = await scanUsdcDeposits(o);
    for (const h of hits) {
      if (seenSig(h.sig)) continue;
      const u = creditDeposit(h.owner, h.amount, h.sig);
      credited.push({ owner: h.owner, amount: h.amount, sig: h.sig, usdc: u.usdc });
    }
  }
  return credited;
}

async function hotSwap(opts: { ticker: string; usd: number; bandBps: number; side: "buy" | "sell"; owner: string }) {
  const priced = await quoteTrade(opts);
  if (!priced.allowed) {
    const err = new Error(priced.reason) as Error & { code?: string };
    err.code = "GATED";
    throw err;
  }
  const kp = deskKeypair(opts.owner);
  const res = await fetch(`${JUP}/swap`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      quoteResponse: priced.quote,
      userPublicKey: kp.publicKey.toBase58(),
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      dynamicSlippage: { minBps: 50, maxBps: 300 },
      prioritizationFeeLamports: "auto",
    }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`jupiter swap ${res.status}: ${await res.text()}`);
  const body: any = await res.json();
  const tx = VersionedTransaction.deserialize(Buffer.from(body.swapTransaction, "base64"));
  tx.sign([kp]);
  const signature = await connection().sendRawTransaction(tx.serialize(), { skipPreflight: false });
  const usdSettled =
    opts.side === "sell" ? Number(priced.quote.outAmount) / 1e6 : priced.usd;
  const fill = {
    t: Date.now(),
    side: opts.side,
    ticker: priced.tape.ticker,
    usd: usdSettled,
    shares: priced.shares,
    premiumBps: priced.tape.premiumBps,
    session: priced.tape.session,
    tx: signature,
    note: `${opts.side} ${priced.tape.xSymbol} from your MarkFill wallet`,
  };
  const user = applyFill(opts.owner, fill);
  receiptFromTape(priced.tape, opts.side, priced.usd, priced.shares, signature);
  return { ...priced, signature, live: true, user, fill };
}

export async function arm(order: Omit<ArmOrder, "createdAt" | "armed"> & { armed?: boolean }) {
  const owner = String(order.owner || "").trim();
  if (!owner) throw new Error("connect a wallet so we know which desk account to use");
  const stock = stockByTicker(order.ticker);
  if (!stock) throw new Error("unknown ticker");
  const usd = Number(order.usd);
  if (!(usd > 0)) throw new Error("size must be greater than 0");
  const bandBps = Number(order.bandBps || 50);
  const side = order.side === "sell" ? "sell" : "buy";
  if (vaultMode()) {
    return armVault({ owner, stock, usd, bandBps, side });
  }
  const u = getUser(owner);
  if (side === "buy" && u.usdc + 1e-9 < usd) {
    throw new Error(`desk balance is $${u.usdc.toFixed(2)} USDC — deposit first`);
  }
  if (side === "sell") {
    const h = u.holdings[stock.ticker];
    if (!h || h.shares <= 0) throw new Error("no shares of this name on the desk to sell");
  }
  return setArm({
    owner,
    ticker: stock.ticker,
    usd,
    bandBps,
    side,
    armed: order.armed !== false,
    createdAt: Date.now(),
  });
}

const ARM_TTL_SEC = 7 * 24 * 60 * 60;

async function tokenUi(ata: PublicKey) {
  try {
    const acc = await connection().getTokenAccountBalance(ata);
    return Number(acc.value.uiAmount || 0);
  } catch {
    return 0;
  }
}

/** User-signed place_order. Does not write the legacy arm ledger. */
async function armVault(opts: {
  owner: string;
  stock: NonNullable<ReturnType<typeof stockByTicker>>;
  usd: number;
  bandBps: number;
  side: "buy" | "sell";
}) {
  if (!opts.stock.pythEquity) throw new Error("no pyth equity feed for this ticker");
  const feed = Buffer.from(opts.stock.pythEquity.replace(/^0x/, ""), "hex");
  if (feed.length !== 32) throw new Error("bad pyth feed id");
  const user = new PublicKey(oid(opts.owner));
  const conn = connection();
  const [vault] = vaultPda(user);
  const info = await conn.getAccountInfo(vault);
  const ixs = [];
  let orderId = 0n;
  if (!info) {
    ixs.push(initializeVaultIx(user));
  } else {
    if (info.data.length < 49) throw new Error("vault account is the wrong size");
    orderId = info.data.readBigUInt64LE(8 + 32 + 1);
  }
  const mint = new PublicKey(opts.stock.mint);
  const { ata: usdcAta } = await vaultUsdcAta(user);
  const { ata: stockAta } = await vaultStockAta(user, mint);
  if (opts.side === "buy") {
    const usdc = await tokenUi(usdcAta);
    if (usdc + 1e-9 < opts.usd) throw new Error(`vault balance is $${usdc.toFixed(2)} USDC — deposit first`);
  } else {
    const shares = await tokenUi(stockAta);
    if (shares <= 0) throw new Error("no shares of this name in the vault to sell");
  }
  ixs.push(
    createAssociatedTokenAccountIdempotentInstruction(user, usdcAta, vault, new PublicKey(USDC), TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID),
    createAssociatedTokenAccountIdempotentInstruction(user, stockAta, vault, mint, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID),
    await placeOrderIx({
      user,
      stockMint: mint,
      usdAmount: BigInt(Math.round(opts.usd * 1_000_000)),
      bandBps: opts.bandBps,
      side: opts.side === "sell" ? 1 : 0,
      expiryTs: Math.floor(Date.now() / 1000) + ARM_TTL_SEC,
      pythFeedId: feed,
      orderId,
    }),
  );
  const tx = new Transaction().add(...ixs);
  tx.feePayer = user;
  tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
  return {
    needsUserSignature: true,
    transaction: txToB64(tx),
    orderId: orderId.toString(),
    vault: vault.toBase58(),
  };
}

async function jupiterRoute(quote: any, user: PublicKey, destination: PublicKey) {
  const res = await fetch(`${JUP}/swap-instructions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      quoteResponse: quote,
      userPublicKey: user.toBase58(),
      destinationTokenAccount: destination.toBase58(),
      wrapAndUnwrapSol: false,
      dynamicComputeUnitLimit: true,
    }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`jupiter swap-instructions ${res.status}: ${await res.text()}`);
  const body: any = await res.json();
  const swap = body.swapInstruction;
  if (!swap?.data || swap.programId !== JUPITER_V6.toBase58()) {
    throw new Error("jupiter route is not the v6 aggregator");
  }
  return {
    data: Buffer.from(swap.data, "base64"),
    accounts: (swap.accounts || []).map((a: any) => ({
      pubkey: new PublicKey(a.pubkey),
      isSigner: Boolean(a.isSigner),
      isWritable: Boolean(a.isWritable),
    })),
    luts: (body.addressLookupTableAddresses || []) as string[],
  };
}

function pythAccount(map: Record<string, PublicKey>, feedHex: string) {
  const want = feedHex.replace(/^0x/, "").toLowerCase();
  for (const [key, value] of Object.entries(map)) {
    if (key.replace(/^0x/, "").toLowerCase() === want) return value;
  }
  throw new Error("pyth update missing for " + want);
}

async function submitVaultFill(opts: {
  order: OpenOrder;
  vaultUsdc: PublicKey;
  vaultStock: PublicKey;
  route: Awaited<ReturnType<typeof jupiterRoute>>;
  minOut: bigint;
}) {
  const keeper = keeperKeypair();
  const conn = connection();
  const feedHex = opts.order.pythFeedId.toString("hex");
  const headers: Record<string, string> = {};
  const pythKey = process.env.PYTH_API_KEY?.trim();
  if (pythKey) headers.Authorization = `Bearer ${pythKey}`;
  const hermes = await fetch(
    `https://hermes.pyth.network/v2/updates/price/latest?ids[]=${feedHex}&encoding=base64`,
    { headers, signal: AbortSignal.timeout(12_000) },
  );
  if (!hermes.ok) throw new Error(`hermes ${hermes.status}`);
  const update: any = await hermes.json();
  const vaas: string[] = update?.binary?.data || [];
  if (!vaas.length) throw new Error("hermes returned no price update");

  const { PythSolanaReceiver } = await import("@pythnetwork/pyth-solana-receiver");
  const { Wallet } = await import("@coral-xyz/anchor");
  const receiver = new PythSolanaReceiver({ connection: conn, wallet: new Wallet(keeper) });
  // Partial guardian verification. A fully verified VAA plus the Jupiter route
  // does not fit in one transaction. The receiver still writes PriceUpdateV2.
  const posted = await receiver.buildPostPriceUpdateAtomicInstructions(vaas);
  const pythPrice = pythAccount(posted.priceFeedIdToPriceUpdateAccount, feedHex);
  const fillIx = executeFillIx({
    keeper: keeper.publicKey,
    owner: opts.order.owner,
    orderId: opts.order.orderId,
    stockMint: opts.order.stockMint,
    vaultUsdc: opts.vaultUsdc,
    vaultStock: opts.vaultStock,
    pythPrice,
    jupiterData: opts.route.data,
    jupiterAccounts: opts.route.accounts,
    minOut: opts.minOut,
  });
  const post = posted.postInstructions || [];
  const close = posted.closeInstructions || [];
  const ixs = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }),
    ...post.map((row: { instruction: any }) => row.instruction),
    fillIx,
    ...close.map((row: { instruction: any }) => row.instruction),
  ];
  const signers = [...post, ...close].flatMap((row: { signers?: any[] }) => row.signers || []);
  const luts = [];
  for (const addr of opts.route.luts) {
    const table = await conn.getAddressLookupTable(new PublicKey(addr));
    if (table.value) luts.push(table.value);
  }
  const { blockhash } = await conn.getLatestBlockhash();
  const message = new TransactionMessage({
    payerKey: keeper.publicKey,
    recentBlockhash: blockhash,
    instructions: ixs,
  }).compileToV0Message(luts);
  const tx = new VersionedTransaction(message);
  tx.sign([keeper, ...signers]);
  return conn.sendRawTransaction(tx.serialize(), { skipPreflight: false });
}

async function fillVaultOrder(order: OpenOrder) {
  const stock = STOCKS.find((s) => s.mint === order.stockMint.toBase58());
  if (!stock) throw new Error("no stock for mint " + order.stockMint.toBase58());
  const side = order.side === 0 ? "buy" : "sell";
  const tape = await buildTape(stock.ticker, order.bandBps);
  const ready = side === "buy" ? tape.actions.buyFair || tape.actions.buyCheap : tape.actions.sellRich;
  if (!ready) return null;
  let usd = Number(order.usdAmount) / 1e6;
  const { ata: vaultUsdc } = await vaultUsdcAta(order.owner);
  const { ata: vaultStock } = await vaultStockAta(order.owner, order.stockMint);
  if (side === "sell") {
    if (!tape.onchain?.price) throw new Error("no on-chain print to size a sell");
    const shares = await tokenUi(vaultStock);
    usd = Math.min(usd, shares * tape.onchain.price);
    if (usd < 1) throw new Error("sell size too small");
  }
  const priced = await quoteTrade({
    ticker: stock.ticker,
    usd,
    bandBps: order.bandBps,
    side,
    slippageBps: Math.max(1, order.bandBps),
  });
  if (!priced.allowed) throw new Error(priced.reason);
  const minRaw = priced.quote.otherAmountThreshold ?? priced.quote.outAmount;
  if (minRaw == null || BigInt(minRaw) <= 0n) throw new Error("jupiter quote has no min out");
  const [vault] = vaultPda(order.owner);
  const route = await jupiterRoute(priced.quote, vault, side === "buy" ? vaultStock : vaultUsdc);
  const signature = await submitVaultFill({
    order,
    vaultUsdc,
    vaultStock,
    route,
    minOut: BigInt(minRaw),
  });
  return { owner: order.owner.toBase58(), ticker: stock.ticker, signature, live: true as const };
}

async function processVaultArms() {
  const out = [];
  let orders: OpenOrder[];
  try {
    orders = await listOpenOrders(connection());
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.warn("vault arms", message);
    return [{ owner: "", ticker: "", error: message }];
  }
  const now = BigInt(Math.floor(Date.now() / 1000));
  for (const order of orders) {
    if (order.expiryTs <= now) continue;
    try {
      const filled = await fillVaultOrder(order);
      if (filled) out.push(filled);
    } catch (e) {
      const stock = STOCKS.find((s) => s.mint === order.stockMint.toBase58());
      out.push({
        owner: order.owner.toBase58(),
        ticker: stock?.ticker || order.stockMint.toBase58(),
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
  return out;
}

export async function processArms() {
  if (vaultMode()) return processVaultArms();
  const out = [];
  for (const a of listArms()) {
    try {
      const tape = await buildTape(a.ticker, a.bandBps);
      const ready =
        a.side === "buy" ? tape.actions.buyFair || tape.actions.buyCheap : tape.actions.sellRich;
      if (!ready) continue;
      let usd = a.usd;
      if (a.side === "sell" && tape.onchain?.price) {
        const h = getUser(a.owner).holdings[a.ticker];
        const maxUsd = (h?.shares || 0) * tape.onchain.price;
        usd = Math.min(usd, maxUsd);
        if (usd < 1) throw new Error("sell size too small");
      }
      const filled = await hotSwap({
        owner: a.owner,
        ticker: a.ticker,
        usd,
        bandBps: a.bandBps,
        side: a.side,
      });
      disarm(a.owner, a.ticker);
      out.push({ owner: a.owner, ticker: a.ticker, signature: filled.signature, live: filled.live });
    } catch (e) {
      out.push({ owner: a.owner, ticker: a.ticker, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return out;
}

export async function withdraw(opts: { owner: string; kind: "usdc" | "token"; ticker?: string; amount: number }) {
  const owner = oid(opts.owner);
  if (!owner) throw new Error("connect wallet");
  const amount = Number(opts.amount);
  if (!(amount > 0)) throw new Error("amount must be > 0");
  if (vaultMode()) {
    const user = new PublicKey(owner);
    const mint = opts.kind === "usdc" ? new PublicKey(USDC) : new PublicKey(stockByTicker(String(opts.ticker || ""))!.mint);
    const decimals = opts.kind === "usdc" ? 6 : stockByTicker(String(opts.ticker || ""))!.decimals;
    const ownerAta = await getAssociatedTokenAddress(mint, user, false, TOKEN_PROGRAM_ID);
    const ix = await withdrawIx(user, mint, ownerAta, BigInt(Math.round(amount * 10 ** decimals)));
    const tx = new Transaction().add(ix);
    tx.feePayer = user;
    tx.recentBlockhash = (await connection().getLatestBlockhash()).blockhash;
    return { needsUserSignature: true, transaction: txToB64(tx) };
  }
  const u = getUser(owner);
  if (opts.kind === "usdc") {
    if (u.usdc + 1e-9 < amount) throw new Error("not enough USDC on the desk");
    const sent = await sendTokens({ owner, mint: USDC, to: owner, amount, decimals: 6 });
    const next = debitWithdraw(owner, "usdc", amount, undefined, sent.signature);
    return { ...sent, user: next };
  }
  const stock = stockByTicker(String(opts.ticker || ""));
  if (!stock) throw new Error("pick a ticker to withdraw");
  const h = u.holdings[stock.ticker];
  if (!h || h.shares + 1e-12 < amount) throw new Error("not enough shares on the desk");
  const sent = await sendTokens({ owner, mint: stock.mint, to: owner, amount, decimals: stock.decimals });
  const next = debitWithdraw(owner, "token", amount, stock.ticker, sent.signature);
  return { ...sent, user: next };
}

export async function snapshot(owner: string) {
  const u = getUser(owner);
  const chain = vaultMode()
    ? await (async () => {
        const user = new PublicKey(oid(owner));
        const { vault, ata } = await vaultUsdcAta(user);
        const conn = connection();
        let usdc = 0;
        try {
          const acc = await conn.getTokenAccountBalance(ata);
          usdc = Number(acc.value.uiAmount || 0);
        } catch {
          usdc = 0;
        }
        return { sol: 0, usdc, stocks: [] as { ticker: string; xSymbol: string; shares: number }[], vault: vault.toBase58() };
      })()
    : await onchainBalances(owner);
  return {
    address: vaultMode() ? (chain as { vault?: string }).vault : u.deskAddress,
    live: isLive(),
    balances: chain,
    user: {
      owner: u.owner,
      deskAddress: u.deskAddress,
      usdc: u.usdc,
      holdings: u.holdings,
      fills: u.fills,
      deposits: u.deposits,
      withdrawals: u.withdrawals,
    },
    arms: userArms(owner),
  };
}

export async function exportKey(owner: string) {
  if (vaultMode()) {
    const user = new PublicKey(oid(owner));
    const { vault, ata } = await vaultUsdcAta(user);
    return { address: ata.toBase58(), vaultPda: vault.toBase58(), secret: null, note: "no private key — vault is a PDA" };
  }
  deskKeypair(owner);
  const u = getUser(owner);
  return { address: u.deskAddress, secret: null, note: "export of private keys is disabled; use withdraw" };
}

let busy = false;
export async function deskTick() {
  if (busy) return;
  busy = true;
  try {
    await ingestDeposits();
    await processArms();
  } catch (e) {
    console.warn("desk tick", e instanceof Error ? e.message : e);
  } finally {
    busy = false;
  }
}
