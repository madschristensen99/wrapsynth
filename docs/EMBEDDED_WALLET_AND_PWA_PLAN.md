# WrapSynth — Embedded Wallet & PWA Strategy

> Investigation of FOID Wallet's Safari-compatible Web3 approach and how to adapt it for WrapSynth, plus a PWA plan for LP activity notifications.

---

## Table of Contents

1. [FOID Wallet: How It Works](#1-foid-wallet-how-it-works)
2. [WrapSynth Current Architecture](#2-wrapsynth-current-architecture)
3. [Embedded Wallet Adaptation Plan](#3-embedded-wallet-adaptation-plan)
4. [PWA + Push Notification Plan](#4-pwa--push-notification-plan)
5. [Combined Architecture](#5-combined-architecture)
6. [iOS Safari Limitations](#6-ios-safari-limitations)
7. [Implementation Priority](#7-implementation-priority)

---

## 1. FOID Wallet: How It Works

**Repository**: [github.com/traplordmoses/foiddotfun](https://github.com/traplordmoses/foiddotfun)

### Core Insight

The FOID Wallet is **not a Safari browser extension**. It is an **embedded wallet** — a fully self-contained JavaScript wallet that lives inside the web page itself. No extension needed, no app install. The wallet IS the website.

This bypasses the fundamental limitation of Safari on iOS: Apple does not support Chrome-style browser extensions on iOS Safari. Instead of injecting `window.ethereum` from an extension, the FOID wallet implements the EIP-1193 provider interface directly in JavaScript.

### Architecture

```
foid_fun/src/lib/
├── wallet/
│   ├── constants.ts    — Config values (KDF params, timeouts, storage keys)
│   ├── crypto.ts       — Argon2id, PBKDF2, AES-256-GCM, HMAC, PRF key combination
│   ├── passkey.ts      — WebAuthn passkey creation + authentication with PRF extension
│   ├── mnemonic.ts     — BIP-39 generation, BIP-44 derivation, vault payload encoding
│   ├── storage.ts      — localStorage persistence, v1→v3 migration, backup export/import
│   ├── session.ts      — Web Worker RPC + encrypted in-memory fallback
│   ├── worker.ts       — Web Worker holding private key, handles all signing
│   ├── throttle.ts     — Rate limiting with exponential backoff + nonce detection
│   └── index.ts        — Main wallet API: create(), unlock(), restoreFromMnemonic()
├── connectors/
│   ├── embeddedConnector.ts    — Custom wagmi v2 connector (EIP-1193 provider)
│   ├── embeddedRainbowKit.ts   — RainbowKit wallet definition
│   └── onboardingBridge.ts     — Event bridge between connector and React modal
```

### Layer-by-Layer Breakdown

#### 1.1 Key Creation & Encryption (`wallet/index.ts`, `wallet/crypto.ts`)

**Creation flow:**
1. Generate a **BIP-39 12-word mnemonic** and derive EVM private key via BIP-44
2. Create a **WebAuthn passkey** (Face ID / Touch ID) using `navigator.credentials.create()`
3. Derive an AES-256-GCM encryption key from the user's **PIN**:
   - **Primary KDF**: Argon2id (64MB memory-hard, 3 iterations) via `hash-wasm` — GPU-resistant
   - **Fallback KDF**: PBKDF2-SHA-256 (600,000 iterations) for devices without WASM
4. If the passkey returned a **PRF output**, the PIN-derived key is **XOR'd** with a PRF-derived key (via HKDF) — creating **dual-factor encryption** (PIN + biometric)
5. Encrypt the private key + mnemonic together with **AES-256-GCM** (random 12-byte IV per operation)
6. Compute an **HMAC-SHA-256** over the vault for tamper detection
7. Store the encrypted blob in `localStorage`

**Vault structure (`FoidWalletV3`):**
```typescript
{
  version: 3,
  kdf: 'argon2id' | 'pbkdf2',
  vault: { ciphertext, iv, salt, hmac },
  address,
  credentialId,
  prfActive,
  createdAt,
  hasMnemonic,
  throttleNonce
}
```

**Key derivation dispatch (`deriveEncryptionKey`):**
- If PRF output available: derive extractable PIN key + PRF key via HKDF, XOR them, import as non-extractable
- If no PRF: derive non-extractable PIN key directly
- KDF choice (Argon2id vs PBKDF2) is stored in the vault and used consistently for decrypt

#### 1.2 WebAuthn / Passkeys (`wallet/passkey.ts`)

This is what makes it work seamlessly on Safari/iOS:

- Uses `navigator.credentials.create()` and `navigator.credentials.get()` — **both fully supported in Safari on iOS 16+ and macOS**
- Requests **platform authenticator** (`authenticatorAttachment: 'platform'`) — triggers **Face ID** on iPhone, **Touch ID** on Mac
- Requests the **PRF (Pseudo-Random Function) extension** — Safari is one of the few browsers that supports PRF, which allows the passkey to produce a deterministic secret used as an encryption factor
- If PRF is unavailable, falls back to PIN-only encryption (still AES-256-GCM)
- `isPasskeyAvailable()` checks `PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable()`

**Passkey creation parameters:**
```javascript
{
  publicKey: {
    challenge: rand(32),
    rp: { name: 'FOID', id: window.location.hostname },
    user: { id, name, displayName },
    pubKeyCredParams: [
      { alg: -7, type: 'public-key' },    // ES256
      { alg: -257, type: 'public-key' },   // RS256
    ],
    authenticatorSelection: {
      authenticatorAttachment: 'platform',
      residentKey: 'required',
      userVerification: 'required',
    },
    hints: ['client-device'],
    extensions: { prf: { eval: { first: PRF_SALT } } },
  }
}
```

**Authentication flow:**
- Uses `navigator.credentials.get()` with `allowCredentials` referencing the stored credential ID
- Requests PRF output again (deterministic — same salt produces same output)
- If `withPrf` is true but PRF output is null, throws an error explaining biometric key derivation is no longer available

#### 1.3 Private Key Isolation via Web Worker (`wallet/worker.ts`, `wallet/session.ts`)

After unlocking, the private key is **never held on the main thread**:

- A **Web Worker** is spawned (Safari supports module workers)
- The private key is sent to the Worker via `postMessage`
- All signing operations (`signMessage`, `signTypedData`, `signTransaction`) go through **RPC to the Worker** — the main thread only sees signatures
- The Worker **auto-clears** the key after 30 minutes of inactivity (`SESSION_TIMEOUT_MS`)
- **Fallback**: if Workers are unavailable, the key is encrypted in memory with a random non-extractable AES key (XSS can't read it via `crypto.subtle`)

**Worker RPC protocol:**
- Main thread sends `{ type, id, ...data }` via `postMessage`
- Worker responds with `{ type: 'result', id, result }` or `{ type: 'error', id, error }`
- 30-second timeout safety per call
- `session_expired` event broadcast when auto-clear triggers

**Fallback encrypted in-memory:**
- Random non-extractable AES-256-GCM key generated via `crypto.subtle.generateKey()`
- Private key encrypted with this session key, plaintext zeroed immediately
- On sign: decrypt key, sign, zero decrypted buffer
- Same 30-minute timeout

#### 1.4 Wagmi Connector — EIP-1193 Provider (`connectors/embeddedConnector.ts`)

A custom wagmi v2 connector that acts as a fake EIP-1193 provider:

| EIP-1193 Method | Implementation |
|---|---|
| `eth_requestAccounts` | Returns stored wallet address |
| `eth_accounts` | Same |
| `eth_chainId` | Returns `toHex(TARGET_CHAIN_ID)` |
| `wallet_switchEthereumChain` | No-op (single chain) |
| `personal_sign` | Routes through `ensureUnlocked()` → Worker signs |
| `eth_signTypedData_v4` | Routes through Worker for EIP-712 signing |
| `eth_sendTransaction` | Fetches nonce + gas from RPC, constructs legacy tx, signs via Worker, broadcasts `eth_sendRawTransaction` |
| `eth_call`, `eth_getBalance`, etc. | Proxied to same-origin `/api/rpc` with fallback to public RPC |

**`ensureUnlocked()` pattern:**
- On page reload: only loads address from `localStorage` (no unlock needed)
- On first signing action: triggers unlock modal via onboarding bridge
- After unlock: initializes Web Worker session, returns sentinel `WORKER_MANAGED_KEY`

**RPC routing:**
- Primary: same-origin `/api/rpc` proxy (keeps dedicated RPC key out of client bundle)
- Fallback: public Fluent RPC
- Retry: 3 attempts per RPC with 500ms exponential backoff

#### 1.5 Onboarding Bridge (`connectors/onboardingBridge.ts`)

A simple event bus connecting the wagmi connector (plain JS) to the React modal UI:

- `requestWalletCreation()` dispatches `foid-wallet:request-create` custom event → React modal shows PIN entry → creates wallet → resolves promise with `{ address, privateKey }`
- `requestWalletUnlock()` dispatches `foid-wallet:request-unlock` → modal shows PIN + Face ID → unlocks vault → resolves with credentials
- `resolveWalletRequest(result)` called by React modal when user completes flow

#### 1.6 RainbowKit Integration (`connectors/embeddedRainbowKit.ts`)

Registers the embedded wallet as a RainbowKit wallet option called "FOID Wallet" — appears as the first option in the connect modal, marked as `installed: true` (no download needed). Custom SVG icon.

### Security Model

From the code's own documentation:

| Threat | Mitigation |
|---|---|
| XSS reads localStorage | Only gets encrypted blob, no key |
| XSS reads main thread memory | Key is in Worker, not accessible |
| Malicious extension reads storage | Same — encrypted blob |
| Physical access | Needs PIN + biometric (Face ID) |
| Interactive brute-force | Throttled after 10 attempts with exponential backoff + nonce detection |
| Offline brute-force | Argon2id 64MB makes GPU attacks impractical |

**Not designed for**: state-level adversaries, >$1000 in value (per their own comment).

### Why This Works on Safari (But MetaMask Doesn't)

| Capability | Safari Support | FOID Wallet Uses It? |
|---|---|---|
| Browser extensions (Chrome MV3) | **No** | No — not needed |
| Safari Web Extensions (requires iOS app) | Yes but complex | No — not needed |
| WebAuthn / Passkeys | **Yes** (iOS 16+, macOS) | **Yes** — Face ID/Touch ID |
| WebAuthn PRF extension | **Yes** (Safari 16+) | **Yes** — dual-factor encryption |
| Web Crypto API (`crypto.subtle`) | **Yes** | **Yes** — AES-GCM, PBKDF2, HKDF, HMAC |
| Web Workers (module type) | **Yes** | **Yes** — key isolation |
| `localStorage` | **Yes** | **Yes** — encrypted vault storage |
| `hash-wasm` (Argon2id via WASM) | **Yes** | **Yes** — memory-hard KDF |

The fundamental difference: MetaMask requires a browser extension to inject `window.ethereum`. Safari on iOS doesn't support Chrome-style extensions. The FOID wallet bypasses this by being the EIP-1193 provider itself — the wagmi connector creates a JavaScript object that implements `request()` and handles all wallet operations internally.

---

## 2. WrapSynth Current Architecture

### Frontend Stack

- **Vanilla JS SPA** — no framework, no build step
- ES modules loaded directly from `esm.sh` (viem, ethers, monero-ts)
- `window.ethereum` (MetaMask) for wallet connection via `viemClient.js`
- `localStorage` + `IndexedDB` for swap state and encrypted seed storage
- In-app slide-in notifications via `ui.js` (`showNotification()`)
- Service workers are **explicitly unregistered** in `app.html` (lines 47-51)

### Key Files

| File | Purpose |
|---|---|
| `js/viemClient.js` | EVM client setup, MetaMask connection, contract reads/writes |
| `js/phantomAgent.js` | Monero key derivation (BIP-39 seed → Ed25519 keys) |
| `js/seedStorage.js` | Two-layer encrypted seed storage (IndexedDB + wallet signature) |
| `js/seedManager.js` | BIP-39 seed generation + key set derivation |
| `js/lpClient.js` | HTTP client for LP server (quotes, mint status, burn status) |
| `js/lpPanel.js` | LP operator panel (vault management, collateral, fees) |
| `js/activityFeed.js` | On-chain event polling for recent mints/burns |
| `js/mintFlowTimers.js` | Deadline countdown + status polling for active mints |
| `js/storage.js` | Multi-swap state persistence in localStorage |
| `js/ui.js` | UI rendering, notifications, modals |
| `js/main.js` | Application entry point, orchestrates all flows |

### LP Server (`lp-server-js/`)

- Plain Express server with REST endpoints
- Endpoints: `/health`, `/mint/key`, `/mints`, `/mint/scan`, `/mint/notify`, `/mint/:id/status`, `/burn/:id/status`, `/quote/mint`, `/quote/burn`, `/reports`
- No WebSocket or SSE support currently
- No push notification infrastructure

### Existing Crypto Infrastructure

`seedStorage.js` already implements a sophisticated encryption scheme:
- Layer 1: Non-extractable AES-GCM key stored in IndexedDB (browser-bound)
- Layer 2: IV encrypted with wallet-signature-derived key
- Requires both browser access AND wallet signature to decrypt

This is conceptually similar to FOID's approach and could be extended/reused.

---

## 3. Embedded Wallet Adaptation Plan

### What It Solves

Current hard dependency: `window.ethereum` (MetaMask). On **Safari iOS**, this doesn't exist. Users can't mint, burn, or manage LP positions from their phone. The embedded wallet pattern eliminates this by being its own EIP-1193 provider.

### Components to Build

#### 3.1 Wallet Core (~800-1000 lines, mostly portable from FOID)

| Module | FOID Source | Adaptation Notes |
|---|---|---|
| `wallet/crypto.js` | `crypto.ts` | Near-direct port to vanilla JS. Remove TypeScript types. Keep Argon2id via `hash-wasm` (works with esm.sh imports). |
| `wallet/passkey.js` | `passkey.ts` | Near-direct port. Change RP name from 'FOID' to 'WrapSynth'. Change PRF salt. |
| `wallet/storage.js` | `storage.ts` | Port to vanilla JS. Keep v3 vault format. Can integrate with existing `seedStorage.js` IndexedDB patterns. |
| `wallet/session.js` | `session.ts` | Port to vanilla JS. Worker URL construction: `new Worker(new URL('./wallet/worker.js', import.meta.url), { type: 'module' })` — works with native ES modules. |
| `wallet/worker.js` | `worker.ts` | Port to vanilla JS. Uses `viem/accounts` `privateKeyToAccount` — available via esm.sh. |
| `wallet/mnemonic.js` | `mnemonic.ts` | Can reuse existing `seedManager.js` for BIP-39 generation. Add BIP-44 EVM derivation (currently seedManager does Monero Ed25519). |
| `wallet/constants.js` | `constants.ts` | Direct port. Adjust storage key to `wrapsynth_wallet`. |
| `wallet/throttle.js` | `throttle.ts` | Direct port. |

#### 3.2 EIP-1193 Provider (~300-400 lines)

Since WrapSynth doesn't use wagmi, build a **standalone EIP-1193 provider object** instead of a wagmi connector:

```javascript
// Pseudocode — NOT final implementation
const embeddedProvider = {
  request: async ({ method, params }) => {
    switch (method) {
      case 'eth_requestAccounts': /* return stored address */
      case 'eth_accounts': /* return stored address */
      case 'eth_chainId': /* return '0x64' (Gnosis) */
      case 'personal_sign': /* ensureUnlocked → sessionSign */
      case 'eth_signTypedData_v4': /* ensureUnlocked → sessionSignTypedData */
      case 'eth_sendTransaction': /* ensureUnlocked → fetch nonce/gas → sessionSignTransaction → eth_sendRawTransaction */
      case 'eth_call':
      case 'eth_getBalance':
      case 'eth_getTransactionCount':
      case 'eth_blockNumber':
      case 'eth_getTransactionReceipt':
      case 'eth_estimateGas': /* proxy to RPC */
      default: /* proxy to RPC */
    }
  }
}
```

**RPC routing for WrapSynth:**
- Primary: public Gnosis RPCs (Ankr, OnFinality, Gateway.fm — already configured in `config.js`)
- No same-origin proxy needed (WrapSynth uses public RPCs, no private endpoint)

#### 3.3 UI Modals (~200 lines)

- **Create wallet modal**: PIN entry (min 6 chars), confirm PIN, passkey prompt, mnemonic backup display
- **Unlock wallet modal**: PIN entry, passkey prompt (Face ID)
- **Style**: Match existing WrapSynth dark theme (`--bg: #0c0c14`, `--panel: #161621`, etc.)

#### 3.4 Integration with `viemClient.js` (~50 lines of changes)

Current code at `viemClient.js:31-38`:
```javascript
if (typeof window !== 'undefined' && window.ethereum) {
    return fallback([custom(window.ethereum), ...httpTransports]);
}
return fallback(httpTransports, { rank: false });
```

Adapted:
```javascript
if (typeof window !== 'undefined' && window.ethereum) {
    return fallback([custom(window.ethereum), ...httpTransports]);
}
// No MetaMask — try embedded wallet
if (embeddedWallet.exists()) {
    return fallback([custom(embeddedWallet.getProvider()), ...httpTransports]);
}
// No wallet at all — read-only via public RPCs
return fallback(httpTransports, { rank: false });
```

`connectWallet()` would also need a branch: if no `window.ethereum`, trigger embedded wallet creation/unlock flow.

#### 3.5 Key Differences from FOID

| Aspect | FOID | WrapSynth |
|---|---|---|
| Framework | Next.js + wagmi + RainbowKit | Vanilla JS + viem (no build step) |
| Chain | Fluent L2 (Chain 25363) | Gnosis Chain (Chain 100) |
| Wallet connector | wagmi `createConnector` | Direct `createWalletClient({ transport: custom() })` |
| RPC strategy | Same-origin proxy + public fallback | Public RPCs only (Ankr, OnFinality, Gateway.fm) |
| Existing crypto | None | `seedStorage.js` (IndexedDB + AES-GCM, two-layer) |
| Module system | TypeScript + bundler | Native ES modules via `esm.sh` |

---

## 4. PWA + Push Notification Plan

### 4.1 Web App Manifest (`manifest.json`)

```json
{
  "name": "WrapSynth — Atomic Liquidity for Monero",
  "short_name": "WrapSynth",
  "description": "Mint and burn wsXMR. Bridge Monero to Gnosis Chain with trustless atomic swaps.",
  "start_url": "/app.html",
  "display": "standalone",
  "background_color": "#0c0c14",
  "theme_color": "#0c0c14",
  "icons": [
    { "src": "favicon_monero/icon-192.png", "sizes": "192x192", "type": "image/png" },
    { "src": "favicon_monero/icon-512.png", "sizes": "512x512", "type": "image/png" }
  ],
  "screenshots": [...]
}
```

Link from `app.html` `<head>`:
```html
<link rel="manifest" href="manifest.json">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="WrapSynth">
```

### 4.2 Service Worker (`sw.js`)

Replace the current unregister logic in `app.html` (lines 47-51) with registration:

```javascript
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(console.error);
}
```

Service worker responsibilities:
- `push` event listener — display push notifications
- `notificationclick` event — focus app window, navigate to relevant mint/burn
- `activate` / `install` — cache static assets (optional)
- **No `esm.sh` imports** — service workers can't use importmaps. Must be plain JS or use `importScripts`.

### 4.3 Notification Infrastructure

#### Option A: Web Push API + VAPID (Server-side push)

- LP server generates VAPID key pair (`web-push` npm package)
- Frontend calls `serviceWorkerRegistration.pushManager.subscribe()` with public VAPID key
- Subscription endpoint sent to LP server for storage
- LP server sends push when events detected
- **Works on**: Chrome, Firefox, Edge, Android Chrome, macOS Safari 16+
- **Does NOT work on iOS Safari** — Apple does not support Web Push API on iOS

#### Option B: Polling + Notifications API (Client-side only)

- Frontend or service worker polls LP server `/mints` endpoint every N seconds
- On status change, call `Notification.requestPermission()` then `new Notification()`
- **Works on**: All browsers that support Notifications API
- **iOS Safari**: Supports Notifications API since iOS 16.4 **but only for installed PWAs**

#### Option C: SSE / WebSocket from LP server (Recommended)

- Add a `/events` SSE endpoint to the Express LP server
- Stream LP activity events in real-time to connected clients
- Frontend listens via `EventSource` and triggers notifications
- More responsive than polling, less infrastructure than Web Push
- **Works on all browsers including iOS Safari PWA**

#### Recommended: Option C (SSE) + Option B (Notification API)

SSE for real-time delivery when app is open, Notification API for display, polling fallback for when SSE disconnects.

### 4.4 SSE Endpoint Design (LP Server)

Add to `lp-server-js/server.js`:

```
GET /events

Response: text/event-stream
Events:
  - mint:initiated      { requestId, xmrAmount, wsxmrAmount, lpVault }
  - mint:key_provided   { requestId, lpPublicSpendKey, lpPublicViewKey }
  - mint:ready          { requestId }
  - mint:finalized      { requestId, secret }
  - mint:cancelled      { requestId }
  - burn:requested      { requestId, wsxmrAmount, xmrAmount, lpVault }
  - burn:committed      { requestId, deadline }
  - burn:finalized      { requestId, secret, reward }
  - burn:slashed        { requestId, totalSeized }
  - burn:cancelled      { requestId }
  - vault:warning       { lp, healthRatio, message }
```

The SSE endpoint would hook into the existing event listener (`startEventListener()` in `server.js`) and broadcast events to all connected SSE clients.

### 4.5 Frontend Notification Logic

```
1. On app load:
   - Register service worker
   - Request notification permission (if not already granted)
   - Open EventSource('/events') connection to LP server
   
2. On SSE event received:
   - If app is in foreground: show in-app slide-in notification (existing ui.js)
   - If app is in background: service worker shows native Notification
   
3. On notification click:
   - Focus app window
   - Navigate to relevant mint/burn detail view
   
4. Fallback (SSE disconnected):
   - Poll /mints every 30 seconds
   - Compare with last-known state
   - Trigger notification on status change
```

### 4.6 LP Activities to Notify On

| Event | Source | User Relevance |
|---|---|---|
| `MintInitiated` | On-chain event | LP: new mint to process |
| `LPKeyProvided` | On-chain event | User: LP has responded, deposit address available |
| `MintReady` | On-chain event | User: deposit confirmed, can finalize mint |
| `MintFinalized` | On-chain event | Both: mint completed |
| `MintCancelled` | On-chain event | Both: mint timed out / cancelled |
| `BurnRequested` | On-chain event | LP: new burn to process |
| `HashProposed` | On-chain event | User: LP proposed hash, verify and confirm |
| `BurnCommitted` | On-chain event | User: LP committed, confirm XMR receipt |
| `BurnFinalized` | On-chain event | Both: burn completed |
| `BurnSlashed` | On-chain event | LP: burn slashed (didn't commit in time) |
| `Vault health warning` | LP server check | LP: collateral ratio dropping below threshold |
| `Mint deadline approaching` | Timer | User: mint will timeout in N blocks |

---

## 5. Combined Architecture

```
User opens Safari → visits wrapsynth.com/app
  → PWA manifest detected → "Add to Home Screen" prompt
  → Service worker registered
  
User wants to mint but has no MetaMask
  → Embedded wallet modal: "Create wallet with Face ID + PIN"
  → Passkey created, EVM keypair generated, encrypted in localStorage
  → viemClient.js uses embedded wallet as custom transport
  → User initiates mint → signs tx via Web Worker → broadcasts to Gnosis
  
LP activity happens (deposit confirmed, burn committed, etc.)
  → SSE stream from LP server pushes event to frontend
  → If app is in foreground → in-app slide-in notification
  → If app is in background → service worker shows native Notification
  → User taps notification → app opens to relevant mint/burn detail
```

---

## 6. iOS Safari Limitations

| Limitation | Impact | Mitigation |
|---|---|---|
| **No Web Push API** | Can't do true server-side push notifications on iOS | Use SSE + Notification API (requires app open or recently active) |
| **Service worker lifecycle** | iOS aggressively kills background service workers | Can't rely on long-running background sync. Use foreground SSE instead. |
| **Notifications API** | Only works for installed PWAs (added to home screen) | Must implement PWA manifest + prompt users to install |
| **Storage eviction** | iOS may evict service worker cache and IndexedDB | Use `navigator.storage.persist()` to request persistent storage |
| **No importmaps in service worker** | Can't use `esm.sh` imports in SW | Write SW in plain JS, no external dependencies |
| **WebAuthn PRF** | Supported on Safari 16+ | Fallback to PIN-only encryption on older Safari |
| **Argon2id via WASM** | Supported on Safari | Fallback to PBKDF2 if WASM unavailable |

---

## 7. Implementation Priority

### Phase 1: PWA + Notifications (Quick Win — ~1 day)

1. Create `manifest.json` with app metadata and icons
2. Add manifest link + Apple PWA meta tags to `app.html` and `index.html`
3. Write `sw.js` service worker (notification display + click handling)
4. Replace service worker unregistration with registration in `app.html`
5. Add `/events` SSE endpoint to LP server
6. Add `EventSource` listener + notification trigger to frontend
7. Add notification permission request flow
8. Add polling fallback for when SSE disconnects

**Files to create:**
- `frontend/manifest.json`
- `frontend/sw.js`
- `frontend/js/notifications.js` (SSE client + notification logic)

**Files to modify:**
- `frontend/app.html` (manifest link, PWA meta tags, SW registration)
- `frontend/index.html` (manifest link, PWA meta tags)
- `lp-server-js/server.js` (SSE endpoint)

### Phase 2: Embedded Wallet (Bigger Project — ~3-5 days)

1. Port FOID's `crypto.ts` → `wallet/crypto.js` (vanilla JS)
2. Port FOID's `passkey.ts` → `wallet/passkey.js`
3. Port FOID's `storage.ts` → `wallet/storage.js`
4. Port FOID's `session.ts` + `worker.ts` → `wallet/session.js` + `wallet/worker.js`
5. Adapt `seedManager.js` for BIP-44 EVM key derivation (in addition to existing Ed25519)
6. Build standalone EIP-1193 provider (`wallet/provider.js`)
7. Build create/unlock UI modals (matching WrapSynth theme)
8. Integrate with `viemClient.js` (fallback transport when no `window.ethereum`)
9. Test on Safari iOS, Safari macOS, Chrome

**Files to create:**
- `frontend/js/wallet/crypto.js`
- `frontend/js/wallet/passkey.js`
- `frontend/js/wallet/storage.js`
- `frontend/js/wallet/session.js`
- `frontend/js/wallet/worker.js`
- `frontend/js/wallet/mnemonic.js`
- `frontend/js/wallet/constants.js`
- `frontend/js/wallet/throttle.js`
- `frontend/js/wallet/provider.js`
- `frontend/js/wallet/index.js`

**Files to modify:**
- `frontend/js/viemClient.js` (embedded wallet fallback transport)
- `frontend/js/main.js` (wallet connection flow branching)
- `frontend/js/ui.js` (create/unlock modal rendering)
- `frontend/app.html` (modal HTML containers)

### Phase 3: Polish (Optional — ~1-2 days)

- Offline caching strategy in service worker (cache static assets)
- `navigator.storage.persist()` call
- Deep link from notification click to specific mint/burn view
- Wallet export/import (encrypted backup JSON)
- Mnemonic restore flow
- Throttle UI (show remaining attempts, lockout countdown)
