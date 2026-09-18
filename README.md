# MarkFill

Stocklana submission: a 24/7 xStock desk that **refuses to buy or LP** when the on-chain token is off the NYSE tape.

Tokenized stocks trade on Solana while the cash market is closed. Spreads blow out. People buy AAPL 3% rich on a Sunday. LPs get picked off. MarkFill is the gate.

## What it does

1. **Triple tape** — NYSE (Pyth equity hours + cash print) vs xStock DEX vs Ondo, when that feed exists
2. **Board** — every name ranked cheapest vs cash. After-hours book.
3. **Buy cheap / fair** — Jupiter buy only if the token is inside the band or discounted to NYSE
4. **Sell rich** — Jupiter sell only if the token is rich vs NYSE
5. **Arm wait** — leave the tab open; when the name comes back cheap or fair, the buy sends
6. **Overnight snap** — if NYSE is closed and the DEX is cheap, shows $ per $100 if it prints cash at the open
7. **Session LP** — tight Meteora bins while NYSE is open, wider overnight, none when off-tape
8. **Receipts** — each fill stores NYSE, on-chain, bps, and session at send time

Pyth is the session clock and the equity symbology. If `PYTH_API_KEY` is set, Hermes also prices `Equity.US.*` and `Crypto.*x/USD`. Without a key, NYSE comes from Yahoo and on-chain from Jupiter — the gate still works.

## Run locally

```powershell
cd C:\Users\DELL\MarkFill
npm.cmd install
npx.cmd tsx src/server.ts
```

Desk: [http://127.0.0.1:4810](http://127.0.0.1:4810)

Connect a Solana wallet. Start with AAPL, 50 bps, $10.

## Put it online (so other people can use it)

Wallets only work on **localhost** or **HTTPS**. So you need a public `https://` URL, not just your home IP.

### Fast (PC stays on)

With the desk already running on 4810:

```powershell
npx.cmd --yes localtunnel --port 4810
```

or Cloudflare:

```powershell
npx.cmd --yes cloudflared tunnel --url http://127.0.0.1:4810
```

Share the `https://…` URL it prints. Close the tunnel or shut the PC and the site dies.

### Stays up 24/7 (laptop off)

You cannot do this from this PC. A cloud host runs `npx tsx src/server.ts` and gives you `https://…`.

**Easiest: Render**

1. Create a free GitHub repo and push this `MarkFill` folder (do not commit `.env`).
2. Go to [render.com](https://render.com) → New → Web Service → connect that repo.
3. Runtime: Node. Build: `npm install`. Start: `npx tsx src/server.ts`.
4. Add env `HOST=0.0.0.0`. Render sets `PORT`.
5. Use a **paid** instance (Starter). The free one sleeps and wallets break.

You get a URL like `https://markfill.onrender.com`. That is what users and Stocklana open. Your laptop can be off.

Railway and Fly.io work the same way. A $5/month VPS (Hetzner / DigitalOcean) is the most reliable if you prefer a normal server.

## Why Solana

24/7 settlement + Jupiter + Meteora. A brokerage cannot do this. MarkFill should not exist on an L2 with bank hours.

## Stocklana

Main track: owning/using tokenized stocks better than a brokerage after hours.  
Pyth bounty: feeds decide whether a trade is allowed.  
Meteora: LP only when the token is honest vs cash.
