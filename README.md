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



## Why Solana

24/7 settlement + Jupiter + Meteora. A brokerage cannot do this. MarkFill should not exist on an L2 with bank hours.

## Stocklana

Main track: owning/using tokenized stocks better than a brokerage after hours.  
Pyth bounty: feeds decide whether a trade is allowed.  
Meteora: LP only when the token is honest vs cash.
