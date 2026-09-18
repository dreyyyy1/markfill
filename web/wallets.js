/** Wallet Standard + injected Solana wallets (Phantom, Jupiter, Solflare, MetaMask, …). */

const STANDARD_CONNECT = "standard:connect";
const STANDARD_DISCONNECT = "standard:disconnect";
const SOLANA_SENDE = "solana:signAndSendTransaction";
const SOLANA_SIGN = "solana:signTransaction";
const MAINNET = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const RPC = "https://api.mainnet-beta.solana.com";

function pubkeyOf(value) {
  if (!value) return null;
  if (typeof value === "string") return value;
  if (typeof value.toBase58 === "function") return value.toBase58();
  if (value.address) return String(value.address);
  if (value.publicKey) return pubkeyOf(value.publicKey);
  return String(value);
}

function isEvm(addr) {
  return /^0x[0-9a-fA-F]{40}$/.test(String(addr || ""));
}

function looksSolana(wallet) {
  const chains = wallet.chains || [];
  if (chains.some((c) => String(c).startsWith("solana:"))) return true;
  const feats = wallet.features || {};
  return Boolean(feats[SOLANA_SENDE] || feats[SOLANA_SIGN]);
}

function pickSolanaAccount(wallet) {
  const accounts = wallet.accounts || [];
  const byChain = accounts.find((a) =>
    (a.chains || []).some((c) => String(c).startsWith("solana:")),
  );
  if (byChain && !isEvm(pubkeyOf(byChain))) return byChain;
  const notEth = accounts.find((a) => !isEvm(pubkeyOf(a)));
  return notEth || null;
}

function chainFor(wallet, account) {
  const chains = [...(account?.chains || []), ...(wallet?.chains || [])].map(String);
  if (chains.includes(MAINNET)) return MAINNET;
  const sol = chains.find((c) => c.startsWith("solana:") && !c.includes("devnet") && !c.includes("testnet"));
  return sol || MAINNET;
}

export function discoverWallets() {
  const rows = [];
  const seen = new Set();

  try {
    const get = window.__walletStandardGet;
    const list = typeof get === "function" ? get() : [];
    for (const w of list) {
      if (!looksSolana(w)) continue;
      const name = w.name || "Wallet";
      const key = name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push({ id: "std:" + name, name, kind: "standard", installed: true, wallet: w });
    }
  } catch {
    /* registry not ready */
  }

  const injected = [
    { id: "jupiter", name: "Jupiter", pick: () => window.jupiter || window.Jupiter || window.jup || (window.solana?.isJupiter && window.solana) },
    { id: "phantom", name: "Phantom", pick: () => window.phantom?.solana || (window.solana?.isPhantom && window.solana) },
    { id: "solflare", name: "Solflare", pick: () => window.solflare || window.Solflare },
    { id: "backpack", name: "Backpack", pick: () => window.backpack },
    { id: "metamask", name: "MetaMask (Solana)", pick: () => window.ethereum?.isMetaMask && window.solana?.isMetaMask ? window.solana : null },
    { id: "glow", name: "Glow", pick: () => window.glow },
    { id: "exodus", name: "Exodus", pick: () => window.exodus?.solana },
    { id: "okx", name: "OKX", pick: () => window.okxwallet?.solana },
    { id: "coinbase", name: "Coinbase", pick: () => window.coinbaseSolana },
    { id: "injected", name: "Injected Solana", pick: () => window.solana },
  ];

  for (const row of injected) {
    let provider = null;
    try {
      provider = row.pick();
    } catch {
      provider = null;
    }
    if (!provider || typeof provider.connect !== "function") continue;
    const key = row.name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({ id: row.id, name: row.name, kind: "injected", installed: true, provider });
  }

  const always = [
    { id: "jupiter-mobile", name: "Jupiter Mobile", kind: "mobile", installed: false },
    { id: "phantom-link", name: "Phantom (install / mobile)", kind: "link", installed: false, href: "https://phantom.app/ul/browse/" },
    { id: "solflare-link", name: "Solflare (install / mobile)", kind: "link", installed: false, href: "https://solflare.com/ul/v1/browse/" },
  ];
  for (const a of always) {
    if (rows.some((r) => r.id === a.id)) continue;
    rows.push(a);
  }
  return rows;
}

export async function connectWallet(row) {
  const here = window.location.href;
  if (row.kind === "mobile") return { mode: "jupiter-mobile", url: here };
  if (row.kind === "link") {
    window.open((row.href || "") + encodeURIComponent(here), "_blank");
    throw new Error("open the wallet, then connect again");
  }
  if (row.kind === "standard") {
    const w = row.wallet;
    const connect = w.features[STANDARD_CONNECT];
    try {
      await connect.connect({ chains: [MAINNET, "solana:mainnet"] });
    } catch {
      await connect.connect();
    }
    const account = pickSolanaAccount(w);
    if (!account) {
      throw new Error("MetaMask (or this wallet) has no Solana account. Open MetaMask → add Solana network / Solana account, then connect again. An Ethereum 0x address cannot sign Solana trades.");
    }
    return {
      mode: "standard",
      wallet: w,
      account,
      publicKey: pubkeyOf(account),
      name: w.name,
      chain: chainFor(w, account),
    };
  }
  const p = row.provider;
  const res = await p.connect();
  const publicKey = pubkeyOf(res?.publicKey) || pubkeyOf(p.publicKey);
  if (!publicKey) throw new Error("wallet connected but no public key");
  if (isEvm(publicKey)) {
    throw new Error("that account is Ethereum, not Solana. In MetaMask pick a Solana account.");
  }
  return { mode: "injected", provider: p, publicKey, name: row.name };
}

export async function disconnectWallet(session) {
  try {
    if (session?.mode === "standard") {
      const d = session.wallet?.features?.[STANDARD_DISCONNECT];
      if (d) await d.disconnect();
    } else if (session?.provider?.disconnect) {
      await session.provider.disconnect();
    }
  } catch {
    /* ignore */
  }
}

async function sendRaw(bytes) {
  const { Connection } = await import("https://esm.sh/@solana/web3.js@1.98.4");
  const conn = new Connection(RPC, "confirmed");
  return conn.sendRawTransaction(bytes, { skipPreflight: false, maxRetries: 3 });
}

function asBytes(tx) {
  try {
    return tx.serialize();
  } catch {
    return tx.serialize({ requireAllSignatures: false, verifySignatures: false });
  }
}

async function sigFrom(out) {
  const row = Array.isArray(out) ? out[0] : out;
  const sig = row?.signature ?? row;
  if (!sig) return null;
  if (typeof sig === "string") return sig;
  const bs58 = (await import("https://esm.sh/bs58@6.0.0")).default;
  return bs58.encode(sig);
}

export async function signAndSend(session, tx) {
  if (!session) throw new Error("connect a wallet first");
  const bytes = asBytes(tx);

  if (session.mode === "standard") {
    const send = session.wallet.features[SOLANA_SENDE];
    const chain = session.chain || MAINNET;
    const payload = { account: session.account, transaction: bytes, chain };
    if (send) {
      try {
        const out = await send.signAndSendTransaction(payload);
        const sig = await sigFrom(out);
        if (sig) return sig;
      } catch (e1) {
        try {
          const out = await send.signAndSendTransaction({ ...payload, chain: MAINNET });
          const sig = await sigFrom(out);
          if (sig) return sig;
        } catch (e2) {
          const sign = session.wallet.features[SOLANA_SIGN];
          if (!sign) throw e2 instanceof Error ? e2 : e1;
          const signed = await sign.signTransaction({ account: session.account, transaction: bytes, chain });
          const blob = Array.isArray(signed) ? signed[0]?.signedTransaction : signed?.signedTransaction || signed;
          const raw = blob instanceof Uint8Array ? blob : asBytes(blob);
          return sendRaw(raw);
        }
      }
    }
    const sign = session.wallet.features[SOLANA_SIGN];
    if (!sign) throw new Error("this wallet cannot sign Solana transactions");
    const signed = await sign.signTransaction({ account: session.account, transaction: bytes, chain });
    const blob = Array.isArray(signed) ? signed[0]?.signedTransaction : signed?.signedTransaction || signed;
    const raw = blob instanceof Uint8Array ? blob : asBytes(blob);
    return sendRaw(raw);
  }

  const p = session.provider;
  if (typeof p.signAndSendTransaction === "function") {
    try {
      const res = await p.signAndSendTransaction(tx);
      const sig = await sigFrom(res);
      if (sig) return sig;
    } catch {
      /* fall through */
    }
  }
  if (typeof p.signTransaction === "function") {
    const signed = await p.signTransaction(tx);
    return sendRaw(asBytes(signed));
  }
  throw new Error("wallet connected but cannot sign. Use MetaMask’s Solana account, Jupiter, Phantom, or Solflare.");
}

export function bootStandard(onChange) {
  return import("https://esm.sh/@wallet-standard/app@1.1.0")
    .then((mod) => {
      const api = mod.getWallets();
      window.__walletStandardGet = api.get.bind(api);
      api.on("register", () => onChange());
      api.on("unregister", () => onChange());
      onChange();
    })
    .catch(() => onChange());
}
