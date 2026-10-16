# Funding Guide — what you need on each chain

Each chain runs an **independent** wsXMR deployment backed by a different
collateral asset. wsXMR is paired against that collateral in the chain's V3
pool — so "which chain do I use" is really "which collateral backing do I
want".

| Chain | Pair | Collateral | What it is | Gas token |
|-------|------|-----------|------------|-----------|
| BNB Chain | wsXMR ⇄ QQQB | QQQB | Tokenized Invesco QQQ (Nasdaq-100 ETF) — bStocks | BNB |
| Base | wsXMR ⇄ cbBTC | cbBTC | Coinbase Wrapped BTC (1:1 BTC) | ETH |
| Robinhood Chain | wsXMR ⇄ SPY | SPY | Robinhood stock token tracking SPDR S&P 500 | ETH |

## What each action requires

### Mint (XMR → wsXMR)
- **XMR** — sent to the LP's shared deposit address after you initiate.
- **Native gas token** — pays tx gas *and* the vault's **griefing deposit**
  (a small `msg.value` bond the vault operator sets; refunded on success or
  honest cancel; slashed only if you abandon the mint mid-flight).
  Suggested LP setting: ~0.001 BNB on BNB Chain.

### Burn (wsXMR → XMR)
- **wsXMR** on that chain (from minting or buying on the pool).
- **Native gas token** for the request tx.
- The LP sends your XMR and posts collateral as a burn reward.

### Buy wsXMR on the DEX
- Any token the router can path through. The wsXMR pool pairs with the
  collateral asset, so routes look like `USDT → QQQB → wsXMR` (PancakeSwap
  on BNB), `USDC → cbBTC → wsXMR` (Uniswap on Base). You do **not** need to
  hold the collateral token yourself.

### Provide LP liquidity
- **The collateral token itself** (QQQB / cbBTC / SPY). The hub wraps it
  into stata shares automatically on deposit — no separate step.
- Native gas token.

## Acquiring each asset

### BNB Chain
- **BNB (gas)**: withdraw BEP-20 from Binance or any CEX; or swap on
  PancakeSwap.
- **QQQB**: PancakeSwap (QQQB/WBNB ~$1.3M liq, QQQB/USDT ~$360k+),
  plus secondary venues. Liquidity is adequate for LP-scale deposits.

### Base
- **ETH (gas)**: withdraw to Base from Coinbase, or bridge via
  bridge.base.org.
- **cbBTC**: Uniswap/Aerodrome cbBTC/USDC (deep liquidity), or wrap BTC
  natively in the Coinbase app.

### Robinhood Chain
- **ETH (gas)**: bridge via the canonical Arbitrum Orbit bridge, Across,
  Relay, or LI.FI — see Robinhood Chain docs. This is the hardest funding
  step on this chain.
- **SPY**: Robinhood stock token — buy in the Robinhood app (supported
  jurisdictions), or on-chain via SPY/USDG and SPY/WETH pools or RFQ
  aggregators (0x RFQ, 1inch Fusion, LiFi); third-party swap frontends
  such as Gifted Stock and Rift route these.
- **Jurisdiction**: Robinhood stock tokens are *not* offered to US persons.

## In-app helpers

- The **chain picker** cards show the pair, collateral, and gas token before
  you commit.
- Each tab (Mint / Burn / Vaults) has a **funding checklist** that reads your
  wallet and ticks off what you have vs. what's missing — with one-click
  acquire links.
- Mint and burn flows **preflight** your native/wsXMR balance and show an
  explanatory modal with funding links instead of a raw wallet revert.
