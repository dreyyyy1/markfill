# MarkFill security

## Today (live website)

The TypeScript desk still uses **derived desk wallets** (`src/lib/custody.ts`) so Arm can fire without a popup. A keeper or anyone with `MARKFILL_SECRET` can sign those wallets.

The on-chain program in `programs/markfill_vault` is **Phase 1–2 code**. It is not the live trust model until it is deployed (`MARKFILL_VAULT_PROGRAM`) and `scripts/sweep-custodial.ts` has returned old desk balances to owners.

## Target model (vault program)

| Actor | Can do | Cannot do |
|---|---|---|
| User | deposit, place_order, cancel, withdraw (must sign) | spend someone else’s vault |
| Keeper | submit `execute_fill`, pay fees | change destination; steal; withdraw |
| Compromised keeper key | grief (spam / fail to fill) | move vault tokens to any other account |

Price gate is checked **inside** `execute_fill` from a Pyth `PriceUpdateV2` account. The server tape is only for UX and for building the Jupiter route.

Withdraw: `vault.owner == user.key()` and destination ATA authority is the user.

After a successful sweep of every `data/desks.json` entry, delete `data/master.key`, `data/desks.json`, and `MARKFILL_SECRET`.
