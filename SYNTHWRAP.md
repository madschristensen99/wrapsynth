# wXMR Synthwrap Model – Standalone v1.0  
*An immutable Monero ↔ Solana bridge that mints 1:1 wrapped-XMR, collateralised by yield-bearing assets, with **≥ 100 %** backing and rewards for Monero node block header pushers.*

---

## 1.  Mission Statement
Launch **one immutable contract** that mints **1 wXMR for 1 XMR**, collateralised by **yield-bearing stablecoins and yield-bearing native tokens**, with **≥ 100 %** backing and **rewards for Monero node block header pushers** to incentivize data availability.

---

## 2.  v1 Scope 
- **Collateral**: **yield-bearing stablecoins (USX) and yield-bearing native tokens**.  
- **Collateral ratio**: **enforced minimum 105 % overcollateralization** for all LPs.  
- **Payout on failure**: **entire collateral seized and distributed to affected users**.  
- **Price oracle**: **Pyth oracle used for wXMR price feeds** to prevent on-chain price manipulation.  
- **Block header rewards**: **yield proceeds distributed to Monero node block header pushers**, with **percentage set via wXMR governance voting**.  
- **Governance**: **wXMR token holders set reward percentages and protocol parameters**.

---

## 3.  v1 Launch Sequence (one-shot)
1. **Deploy bridge**.  
2. **Deployer deposits 1 real XMR** → **submits ZK proof**.  
3. **Bridge mints 1 wXMR** to deployer.  
4. **Mint authority is permanently disabled** → **supply can never change again**.  
5. **Deployer stakes the 1 wXMR** → **creates initial head-room (0.67 wXMR)**.  
6. **Deployer opens registration** → **anyone can LP**, **no further admin actions**.

---

## 4.  v1 Roles & Rules
| Role | Responsibility | Reward | Risk |
|------|---------------|--------|------|
| **LP** | **Post XMR addresses**, **stake ≥ 100 % self-declared wXMR**, **redeem within 2 h**. | **Mint fee (market-set)** | **Lose exactly 100 % wXMR if fail**. |
| **User** | **Send XMR**, **ZK-proof**, **burn wXMR**, **pick any LP ≥ parity**. | **1 wXMR minted**, **100 % wXMR paid on failure**. | **None** (always ≥ 100 % backed). |
| **Bridge** | **Verify proofs**, **track obligations**, **seize collateral**, **no upgrades**. | **None** (immutable). | **None** (no admin keys). |

------------------------------------------------
### v1 Parameters 
- **Min collateral ratio**: **105 %** (enforced for all LPs).  
- **Liquidation payout**: **entire collateral seized**.  
- **Countdown**: **2 hours**.  
- **Mint fee**: **LP declares** (basis points).  
- **Registration deposit**: **0.05 SOL** (scales with obligation to deter grief).
- **Price oracle**: **Pyth oracle for wXMR pricing**.
- **Governance**: **wXMR token voting for reward parameters**.

------------------------------------------------
### v1 Attack & Mitigation
| Attack | Mitigation |
|--------|------------|
| **Self-mint / self-burn** | **Deposit + mint fee + 2 h lock** → **net loss after gas**. |
| **Race to 105 % → thin buffer** | **105% enforced minimum + deposit scales with head-room** → **griefing costs money**. |
| **On-chain price manipulation** | **Pyth oracle prevents wXMR price manipulation**. |

------------------------------------------------
## 5.  v1 Flow (no external oracles)

```mermaid
sequenceDiagram
  participant U as User
  participant B as Bridge
  participant L as Liquidity Provider
  participant X as Monero Chain
  participant P as Pyth Oracle

  Note over U,L: MINT FLOW (User → XMR, wants wXMR)
  U->>B: request mint + pick any LP (≥ 105% collateral)
  B->>P: fetch wXMR/USD price
  B->>B: check LP yield-bearing collateral ≥ 105% obligation
  U->>X: send XMR to LP stealth address
  U->>B: submit ZK proof of payment
  B->>U: mint wXMR immediately
  B->>B: increase LP obligation

  Note over U,L: BURN FLOW (wXMR → XMR)
  U->>B: burn wXMR + XMR destination
  B->>P: fetch wXMR/USD price
  B->>L: 2-hour countdown starts
  alt LP fulfils
    L->>X: send XMR to destination
    L->>B: ZK proof of XMR send
    B->>U: burn complete
  else LP fails
    B->>P: fetch wXMR/USD price
    B->>B: seize entire collateral from LP
    B->>U: transfer wXMR value using seized collateral via Pyth pricing
    B->>L: return residual collateral (if any above 105%)
  end
```

------------------------------------------------
## 6.  wXMR Governance Model
- **Governance token**: **wXMR holders vote on protocol parameters**
- **Votable parameters**: **block header pusher reward percentages**, **collateral ratios**, **fees**
- **Yield distribution**: **governance set percentage of yield from collateral goes to block header pushers**
- **Reward mechanism**: **Monero node operators push block headers → receive yield rewards**

------------------------------------------------
## 7.  Take-away
- **Yield-bearing collateral** provides **organic returns** for **block header pushers**.  
- **105% overcollateralization** enforced with **Pyth oracle price feeds**.  
- **wXMR governance** controls **reward allocations** and **protocol evolution**.  
- **Entire collateral seized on failure** → **maximum user protection**.
