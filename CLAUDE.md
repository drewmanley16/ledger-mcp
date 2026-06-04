# Ledge — Claude Code instructions

## DMK Skills

Three Ledger DMK skill files are installed in `.agents/skills/`:

- **`ledger-dmk-implementation`** — The 5-step signing process: Init → Session → State → App → Operation. Load before touching anything in `src/signing/dmk.ts`.
- **`dmk-intent-vocabulary`** — Maps informal requests ("sign a tx", "get address") to precise DMK API calls. Load when intent is ambiguous.
- **`dmk-business-logic`** — Explains Clear Signing, Secure Channel, sessions, derivation paths. Load when you need to understand the *why*.

## Architecture

```
src/
  index.ts         — entry point; selects signing backend via SIGNER env var
  agent.ts         — Claude API agent with tool use (get_wallet_info, execute_send, etc.)
  signing/
    insecure.ts    — ⚠️ raw private key signing (demo of the bad approach)
    dmk.ts         — Ledger DMK 5-step hardware gate (the secure approach)
```

## Working on the DMK signing layer

When modifying `src/signing/dmk.ts`:

1. Load the `ledger-dmk-implementation` skill first
2. Follow the 5-step process — Steps 1–4 run before every operation
3. Never use `.setStub(true)` outside of tests
4. ESCALATE gates are not negotiable — surface to the user, do not retry
5. Derivation paths are constants, never user input

## Key invariants

- The DMK singleton (`getDmk()`) must be created once per process — do not instantiate in loops
- `listenToAvailableDevices` for Node.js (not `startDiscovering`, which needs a browser picker)
- Disconnect the session in a `finally` block after each operation
- User rejection (`RefusedByUserDAError`, `5501`, `6985`) is not an error — it's a neutral outcome

## Running locally

```bash
# Ledger mode (requires a Ledger device)
npm run start:ledger "Send 0.001 ETH to 0xDEF..."

# Insecure mode (demo only — shows the vulnerability)
PRIVATE_KEY=0x... npm run start:insecure "What is my balance?"
```
