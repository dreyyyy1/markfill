# MarkFill

Stocklana submission: a 24/7 xStock desk that **refuses to buy or LP** when the on-chain token is off the NYSE tape.

Tokenized stocks trade on Solana while the cash market is closed. Spreads blow out. People buy AAPL 3% rich on a Sunday. LPs get picked off. MarkFill is the gate.

## What it does

1. **Triple tape** — NYSE (Pyth equity hours + cash print) vs xStock DEX vs Ondo, when that feed exists
2. **Board** — every name ranked cheapest vs cash. After-hours book.
3. **Buy cheap / fair** — Jupiter buy only if the token is inside the band or discounted to NYSE
4. **Sell rich** — Jupiter sell only if the token is rich vs NYSE
5. **Arm wait** — Arm your buy position with your size when you can not wait on screen for the price to be right,when the name comes back cheap or fair, the buy sends from your desk wallet on Markfill.
6. **Overnight snap** — if NYSE is closed and the DEX is cheap, shows $ per $100 if it prints cash at the open
7. **Session LP** — tight Meteora bins while NYSE is open, wider overnight, none when off-tape
8. **Receipts** — each fill stores NYSE, on-chain, bps, and session at send time
9. **Account** - Once you connect your main wallet, a designated non-custodial wallet is assigned to you as your desk wallet, this is what makes sure you do not have to come and sign any transaction when your order that you arm already wants to fill. Fund the account (usdc and little sol for transanction fee) from your connected wallet , set your amount and stock to buy, and arm. whenever the price is right and fair , it buys automatically for you and you can come back to withdraw back to the connected wallet.
10. **Log** - This is what displays the output of all your actions. 
    
Pyth is the session clock and the equity symbology. If `PYTH_API_KEY` is set, Hermes also prices `Equity.US.*` and `Crypto.*x/USD`. Without a key, NYSE comes from Yahoo and on-chain from Jupiter — the gate still works.



## Why Solana

24/7 settlement + Jupiter + Meteora. A brokerage cannot do this. MarkFill should not exist on an L2 with bank hours.

## Stocklana

Main track: owning/using tokenized stocks better than a brokerage after hours.  
Pyth bounty: feeds decide whether a trade is allowed.  
Meteora: LP only when the token is honest vs cash.
