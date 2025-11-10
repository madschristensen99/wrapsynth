# wXMR Synthwrap Model – Standalone v1.0  
*An immutable Monero ↔ Solana bridge that mints 1:1 wrapped-XMR, collateralised by USX and yield-bearing native tokens, with **110 %** backing and rewards for Monero node block header pushers.*

---

## 1.  Mission Statement
Launch **one immutable contract** that mints **1 wXMR for 1 XMR**, collateralised by **USX and yield-bearing native tokens**, with **110 %** backing and **rewards for Monero node block header pushers** to incentivize data availability.

---

## 2.  v1 Scope 
- **Collateral**: **yield-bearing stablecoins (USX) and yield-bearing native tokens**.  
- **Collateral ratio**: **minimum 110+% overcollateralization** for all LPs (can be higher).  
- **Position takeover**: **any LP can take over positions below 110%**.  
- **Payout on failure**: **exactly 110 % of burned value paid to users from seized collateral**.  
- **Price oracle**: **Pyth oracle used for wXMR price feeds** to prevent on-chain price manipulation.  
- **Block header rewards**: **yield proceeds distributed to Monero node block header pushers**, with **percentage set via wXMR governance voting**.  
- **Governance**: **wXMR token holders set reward percentages and Monero node addresses**.

---

## 3.  v1 Launch Sequence (one-shot)
1. **Deploy wXMR Token**.  
2. **Deployer sets valid yield-bearing asset whitelist** (USX, native tokens).  
3. **Deployer initializes protocol** → **zero wXMR supply to start**.  
4. **anyone can become LP** → **post 110% collateral** in whitelisted yield-bearing assets.  
5. **registration opens automatically** → **no admin keys**.

---

## 4.  v1 Roles & Rules
| Role | Responsibility | Reward | Risk |
|------|---------------|--------|------|
| **LP** | **Post XMR addresses**, **stake ≥ 110 % USX/native tokens**, **redeem within 2 h**. | **Mint fee (market-set)** | **Position taken if <110%, lose 110% if fail**. |
| **User** | **Send XMR**, **ZK-proof**, **burn wXMR**, **pick any LP ≥ 110%**. | **1 wXMR minted**, **110 % paid on failure**. | **None** (always ≥ 110 % backed). |
| **wXMR Token** | **Verify proofs**, **track obligations**, **seize collateral**, **allow position takeover**. | **None** (immutable). | **None** (no admin keys). |

------------------------------------------------
### v1 Parameters 
- **Min collateral ratio**: **≥110 %** (for all LPs, allows position takeover below 110%).  
- **User payout**: **exactly 110 % of burned value** → **fixed 10% bonus compensation**.  
- **Position takeover**: **any LP can take over positions below 110% collateral**.  
- **Countdown**: **2 hours**.  
- **Mint fee**: **LP declares** (basis points).  
- **Registration deposit**: **0.05 SOL** (scales with obligation to deter grief).
- **Price oracle**: **Pyth oracle for wXMR pricing**.
- **Governance**: **wXMR token voting for reward percentages and Monero node addresses**.

------------------------------------------------
### v1 Attack & Mitigation
| Attack | Mitigation |
|--------|------------|
| **Self-mint / self-burn** | **Deposit + mint fee + 2 h lock** → **net loss after gas**. |
| **LP undercollateralization** | **110% minimum + position takeover by other LPs** → **collateral always managed**. |
| **On-chain price manipulation** | **Pyth oracle prevents wXMR price manipulation**. |
| **Race to 110% → thin buffer** | **Position takeover mechanism** → **undercollateralized LPs lose positions**. |

------------------------------------------------
## 5.  v1 Flow

```mermaid
sequenceDiagram
  participant U as User
  participant W as wXMR Token
  participant L as Liquidity Provider  
  participant X as Monero Chain
  participant P as Pyth Oracle

  Note over U,L: MINT FLOW (User → XMR, wants wXMR)
  U->>W: request mint + pick any LP (≥ 110% collateral)
  W->>P: fetch wXMR/USD price  
  W->>W: check LP yield-bearing collateral ≥ 110% obligation
  U->>X: send XMR to LP stealth address
  U->>B: submit ZK proof of payment
  B->>U: mint wXMR immediately
  B->>B: increase LP obligation

  Note over U,L: BURN FLOW (wXMR → XMR)
  U->>W: burn wXMR + XMR destination
  W->>P: fetch wXMR/USD price
  W->>L: 2-hour countdown starts
  alt LP fulfils
    L->>X: send XMR to destination
    L->>W: ZK proof of XMR send
    W->>U: burn complete
  else LP fails
    W->>P: fetch wXMR/USD price
    W->>W: seize 110% collateral from LP
    W->>U: transfer 110% wXMR value using seized collateral via Pyth pricing
    W->>L: return residual collateral (if any above 110%)
  end
```

------------------------------------------------
## 6.  wXMR Governance Model
- **Governance token**: **wXMR holders vote on protocol parameters**
- **Votable parameters**: **block header pusher reward percentages**, **Monero node addresses**
- **Yield distribution**: **governance set percentage of yield from collateral goes to block header pushers**
- **Reward mechanism**: **Monero node operators push block headers → receive yield rewards**

------------------------------------------------
## 7.  Take-away
- **Yield-bearing collateral** provides **organic returns** for **block header pushers**.  
- **≥110% overcollateralization** enforced with **Pyth oracle price feeds**.  
- **wXMR governance** controls **reward percentages** and **Monero node addresses**.  
- **exactly 110% collateral payout on failure** → **fixed protection + 10% bonus**.  
- **Position takeover mechanism** → **LP accountability and system stability**.
