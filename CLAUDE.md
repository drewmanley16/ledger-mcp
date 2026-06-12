# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run typecheck          # TypeScript type check (no emit)
npm start                  # Run MCP server (requires physical Ledger)
npm run start:stub          # Run with stub device (no hardware needed)
npm run inspect            # MCP Inspector UI at localhost:5173
npm run inspect:stub       # MCP Inspector with stub device
```

There are no tests. The MCP Inspector (`npm run inspect:stub`) is the primary way to exercise tools interactively.

## Architecture

This is a stdio MCP server exposing 9 tools for Ledger hardware wallet interaction.

```
src/
  index.ts   — MCP server; registers all 9 tools; entry point
  dmk.ts     — Ledger DMK integration; all hardware I/O lives here
  trades.ts  — In-memory trade state store + per-session spending limiter
  audit.ts   — Tamper-evident hash-chained audit log (ledger-audit.ndjson)
```

**Tool groups:**
- Wallet tools (`ledger_get_address`, `ledger_get_balance`, `ledger_sign_transaction`, `ledger_sign_message`) — thin wrappers over `dmk.ts` functions.
- Trade tools (`ledger_propose_trade`, `ledger_confirm_trade`, `ledger_reject_trade`, `ledger_get_spending_limit`, `ledger_audit_log`) — implement a propose→confirm→audit lifecycle layered on top of the wallet tools.

## DMK layer (`src/dmk.ts`)

Every hardware operation runs the same 4-step gate before executing:
1. `getDmk()` — singleton, created once per process
2. `connectDevice()` — `listenToAvailableDevices` (Node HID; never `startDiscovering`)
3. `ensureReady()` — checks `DeviceStatus`, handles LOCKED
4. Build `SignerEthBuilder` with the session, then call the operation

Always disconnect in a `finally` block. User rejection (`RefusedByUserDAError`, error code `5501` or `6985`) returns `{ ok: false, reason: "ESCALATE" }` — never retry, surface to the caller.

`GateResult<T>` is the return type: `{ ok: true, value: T }` or `{ ok: false, reason: "ABORT" | "ESCALATE", message: string }`.

## Trade confirm flow

`propose_trade` → creates `TradeProposal` in memory, appends `PROPOSED` to audit log, returns `trade_id`.  
`confirm_trade` → for `type=send` calls `signAndSendEth`; for `swap/buy/sell` calls `signMessage` with the intent JSON as the message payload.  
Hardware rejection during confirm writes `HARDWARE_REJECTED` to the audit log; nothing is broadcast.

## Audit log (`src/audit.ts`)

Entries are written to `ledger-audit.ndjson` (configurable via `LEDGER_AUDIT_LOG`). Each entry's `hash` is SHA-256 of `{seq, timestamp, action, tradeId, details, prevHash}`. The chain state (`_seq`, `_prevHash`) is restored from the last line of the file on startup. `verifyChain()` re-derives hashes for all entries.

## Key invariants

- `LEDGER_STUB=1` enables stub mode — safe for dev and CI, never set in production
- Derivation paths are constants (`44'/60'/0'/0/0`), never derived from user input
- `LEDGER_SPENDING_LIMIT_ETH=0` (or unset) means unlimited; the hardware still gates every action
- Stub mode is set via `builder.setStub(true)` inside `getDmk()` — never call it anywhere else
