# MarkFill

> **Trust model today:** the live website is still custodial (HMAC desk wallets) so Arm can fire.  
> **Shipped in repo:** PDA vault program + TS client (`src/lib/vault.ts`) + signed APIs + sweep script. Not live until `anchor deploy`, `MARKFILL_VAULT_PROGRAM` is set, and `npx tsx scripts/sweep-custodial.ts --live` has returned old desk funds. See SECURITY.md.


Stocklana submission: a 24/7 xStock desk that **refuses to buy or LP** when the on-chain token is off the NYSE tape.

Tokenized stocks trade on Solana while the cash market is closed. Spreads blow out.
NYSE closes at 4 PM.

Solana doesn't.

At 2:00 AM on Sunday, an xStock can trade 3% above the last
real-market reference price — and a normal DEX will still execute it.

MarkFill doesn't.

MarkFill compares the on-chain price against the NYSE reference
and makes the execution decision automatically.

FAIR → FILL
RICH → REJECT
CHEAP → FILL

                         MARKFILL
                            │
            ┌───────────────┼────────────────┐
            │               │                │
          NYSE          xStock DEX          Ondo
            │               │                │
            ▼               ▼                ▼
          Pyth          Jupiter          Reference
            │               │                │
            └───────────────┼────────────────┘
                            ▼
                     FAIRNESS ENGINE
                            │
                   ┌────────┴────────┐
                   │                 │
                 FAIR              UNFAIR
                   │                 │
                   ▼                 ▼
                EXECUTE             REJECT
                   │
                   ▼
               Solana
               
               
               | Normal xStock DEX                             | MarkFill                                   |
| --------------------------------------------- | ------------------------------------------ |
| Trades whenever liquidity exists              | Trades only inside a defined fairness band |
| DEX price is the execution reference          | NYSE reference + on-chain execution price  |
| User must watch the market                    | User can arm an order and walk away        |
| After-hours spread is the user's problem      | Protocol blocks excessive divergence       |
| LP can be exposed to stale/off-market pricing | LP width follows market session            |
| Execution decision is off-chain               | Designed for on-chain enforcement          |


## What it does

1. **Triple tape** — NYSE (Pyth equity hours + cash print) vs xStock DEX vs Ondo, when that feed exists
2. **Board** — every name ranked cheapest vs cash. After-hours book.
3. **Buy cheap / fair** — Jupiter buy only if the token is inside the band or discounted to NYSE
4. **Sell rich** — Jupiter sell only if the token is rich vs NYSE
5. **Arm wait** — Arm your buy position with your size when you can not wait on screen for the price to be right,when the name comes back cheap or fair, the buy sends from your desk wallet on Markfill.
6. **Overnight snap** — if NYSE is closed and the DEX is cheap, shows $ per $100 if it prints cash at the open
7. **Session LP** — tight Meteora bins while NYSE is open, wider overnight, none when off-tape
8. **Receipts** — each fill stores NYSE, on-chain, bps, and session at send time MARKFILL RECEIPT
Asset:             AAPLx
Side:              BUY
NYSE reference:    $250.00
On-chain quote:    $250.62
Deviation:         +24.8 bps
Allowed band:      100 bps
Session:           NYSE CLOSED
Result:            FILLED

Solana TX:(https://orbmarkets.io/tx/4cnCtAc52CZyQdnyju4K5enaRuM4Rq4SaFg6NDr73nkmbzGgKyf4NMwM5yN6udfQyAzw1Tp3o2NisengvkzSQPub)
10. **Account** - Once you connect your main wallet, a designated non-custodial wallet is assigned to you as your desk wallet, this is what makes sure you do not have to come and sign any transaction when your order that you arm already wants to fill. Fund the account (usdc and little sol for transanction fee) from your connected wallet , set your amount and stock to buy, and arm. whenever the price is right and fair , it buys automatically for you and you can come back to withdraw back to the connected wallet. Current prototype custody: The live desk currently uses server-derived custodial execution wallets so armed orders can execute without requiring a wallet signature at fill time. The repository also includes the Anchor PDA vault architecture for the planned non-custodial version. The vault becomes the production trust boundary once deployed and migrated.
11. **Log** - This is what displays the output of all your actions. 
    
Pyth is the session clock and the equity symbology. If `PYTH_API_KEY` is set, Hermes also prices `Equity.US.*` and `Crypto.*x/USD`. Without a key, NYSE comes from Yahoo and on-chain from Jupiter — the gate still works.



## Why Solana

24/7 settlement + Jupiter + Meteora. A brokerage cannot do this. 
| Technology | Role                                 |
| ---------- | ------------------------------------ |
| Solana     | 24/7 settlement                      |
| Pyth       | NYSE/reference price + session clock |
| Jupiter    | execution                            |
| Meteora    | adaptive LP                          |
| Anchor     | on-chain vault/fairness enforcement  |
| xStocks    | tokenized equities                   |


## Stocklana

Main track: owning/using tokenized stocks better than a brokerage after hours.  
Pyth bounty: feeds decide whether a trade is allowed.  
Meteora: LP only when the token is honest vs cash.
For the unfinished fully non-custodial set-up, at the moment setting program, on-chain storage(fee) is the only constraint which will be implemented as soon as a means (fee) is available.
