# ledge

**Your AI agent can't send a single transaction without your thumb on a physical button.**

ledge is an MCP server that puts your [Ledger hardware wallet](https://www.ledger.com/) in the confirmation loop for any AI agent. Every signing operation — transfers, trades, intent signatures — physically blocks until you approve on the device screen. No software path, no env var, no prompt injection bypasses the hardware gate.

Works natively in **Claude Code**, Cursor, Cline, Windsurf, and any MCP-compatible client.

---

## The problem

AI agents that control crypto wallets are a liability. A jailbroken prompt, a confused model, a supply-chain compromise — any of these can drain a hot wallet silently. The standard mitigation is spending limits and logging, but those live in software and software can be overridden.

ledge moves the gate to hardware. The private key never leaves the device. The transaction details appear on the Ledger screen. The user physically taps ✓ or ✗. Nothing else matters.

---

## How it works

```
┌─────────────────────────────────────────────────────────┐
│                    AI Agent (Claude)                     │
│                                                          │
│  1. ledger_get_spending_limit  → check budget            │
│  2. ledger_propose_trade(...)  → returns trade_id        │
│  3. ledger_confirm_trade(id)   → BLOCKS                  │
└──────────────────────────┬──────────────────────────────┘
                           │ stdio MCP
┌──────────────────────────▼──────────────────────────────┐
│                    ledge MCP server                      │
│                                                          │
│  • spending limit check                                  │
│  • propose → confirm → audit lifecycle                   │
│  • tamper-evident hash-chained audit log                 │
└──────────────────────────┬──────────────────────────────┘
                           │ USB/HID (Ledger DMK)
┌──────────────────────────▼──────────────────────────────┐
│               Ledger Hardware Device                     │
│                                                          │
│  ┌──────────────────────────────────┐                   │
│  │  Send 0.5 ETH to 0xDEAD...?      │                   │
│  │                                  │                   │
│  │     ✓ Approve    ✗ Reject        │                   │
│  └──────────────────────────────────┘                   │
└─────────────────────────────────────────────────────────┘
```

The agent proposes. The hardware decides. The audit log remembers.

---

## Live in Claude Code

Add to `.claude/mcp.json`:

```json
{
  "mcpServers": {
    "ledger": {
      "command": "npx",
      "args": ["tsx", "/path/to/ledge/src/index.ts"],
      "env": {
        "LEDGER_RPC_URL": "https://eth.llamarpc.com",
        "LEDGER_SPENDING_LIMIT_ETH": "1.0"
      }
    }
  }
}
```

Restart Claude Code. All 9 tools appear automatically. Then just talk to it:

```
You: check my wallet balance and tell me if I can afford to send 0.1 ETH

Claude: Let me check your balance.
  → ledger_get_address()          0x742d...F44e
  → ledger_get_balance(0x742d...)  1.43 ETH

You have 1.43 ETH. A 0.1 ETH send is within your session limit (1.0 ETH).
Want me to propose the trade?

You: yeah send it to 0xDEAD...

Claude: Proposing the trade now.
  → ledger_propose_trade({ type: "send", to: "0xDEAD...", value_eth: "0.1" })
  trade_id: trade_1749756823_a4f2

Ready to confirm — your Ledger will prompt you to approve.
  → ledger_confirm_trade("trade_1749756823_a4f2")
  [blocks — device screen shows transaction details]

[User taps ✓ on device]

  tx_hash: 0x8f3a...c21b — broadcast.
```

---

## What if the agent goes rogue?

```
You: swap all my ETH for some random memecoin

Claude: Proposing a swap of your full balance to DEGEN via Uniswap.
  → ledger_propose_trade({ type: "swap", fromAsset: "ETH", fromAmount: "1.43", toAsset: "DEGEN" })

  → ledger_confirm_trade(...)
  [Ledger screen: "Sign intent: sell all ETH → DEGEN?"]

[User taps ✗]

[ESCALATE] Rejected on device — user cancelled.

Nothing executed. Audit log entry written:
  { "action": "HARDWARE_REJECTED", "tradeId": "trade_1749756900_b8c1", ... }
```

The hardware rejection is the final word. The agent can't retry, can't reroute, can't find another path.

---

## Tools

### Wallet

| Tool | What it does | Device needed |
|---|---|:-:|
| `ledger_get_address` | Derive ETH address from the device, optionally display on-screen for verification | ✓ |
| `ledger_get_balance` | Check ETH balance for any address via RPC | — |
| `ledger_sign_transaction` | Sign and broadcast an ETH transfer | ✓ |
| `ledger_sign_message` | Sign a personal message (EIP-191) | ✓ |

### Trade lifecycle

| Tool | What it does | Device needed |
|---|---|:-:|
| `ledger_propose_trade` | Submit a `send` / `swap` / `buy` / `sell` intent — returns a `trade_id`, nothing executes | — |
| `ledger_confirm_trade` | Execute the trade — blocks until hardware approval or rejection | ✓ |
| `ledger_reject_trade` | Cancel a pending trade without touching the device | — |
| `ledger_get_spending_limit` | Check remaining per-session ETH budget | — |
| `ledger_audit_log` | Read and optionally verify the hash-chained audit log | — |

---

## Tamper-evident audit log

Every action writes an entry to `ledger-audit.ndjson`. Each entry's `hash` is SHA-256 of the full entry body including the previous hash — same construction as a blockchain. Delete or edit any entry and the chain breaks.

```jsonc
// seq 1 — agent proposes a trade
{"seq":1,"timestamp":"2026-06-12T14:00:00.000Z","action":"PROPOSED",
 "tradeId":"trade_1749756823_a4f2","details":{"type":"send","to":"0xDEAD...","value_eth":"0.1"},
 "prevHash":"0000000000000000000000000000000000000000000000000000000000000000",
 "hash":"a1b2c3d4..."}

// seq 2 — user rejected on hardware
{"seq":2,"timestamp":"2026-06-12T14:00:30.000Z","action":"HARDWARE_REJECTED",
 "tradeId":"trade_1749756823_a4f2","details":{"reason":"Rejected on device — user cancelled"},
 "prevHash":"a1b2c3d4...",
 "hash":"e5f6a7b8..."}
```

Verify the chain at any time:

```
ledger_audit_log({ verify: true })
→ { "chain_integrity": "valid", "count": 12, ... }
```

---

## Spending limits

Set `LEDGER_SPENDING_LIMIT_ETH` to cap how much an agent can move per session. The limit is enforced before the proposal reaches the device — a rogue agent can't even try to exceed it.

```
ledger_get_spending_limit()
→ { "limit_eth": 1.0, "spent_eth": 0.1, "remaining_eth": 0.9 }
```

Set to `0` (default) for unlimited — the hardware still gates every action.

---

## Running locally

```bash
# Install dependencies
npm install

# With a physical Ledger connected
npm start

# Without hardware (stub device — safe for dev and demos)
npm run start:stub

# Interactive tool explorer (MCP Inspector at localhost:5173)
npm run inspect:stub
```

### Environment variables

| Variable | Default | Description |
|---|---|---|
| `LEDGER_RPC_URL` | `https://ethereum.publicnode.com` | Ethereum JSON-RPC endpoint |
| `LEDGER_SPENDING_LIMIT_ETH` | `0` (unlimited) | Per-session ETH spending cap |
| `LEDGER_AUDIT_LOG` | `./ledger-audit.ndjson` | Audit log path |
| `LEDGER_STUB` | unset | `1` to run without physical hardware |

---

## Architecture

```
src/
  index.ts   — MCP server; registers all 9 tools
  dmk.ts     — Ledger Device Management Kit integration; all hardware I/O
  trades.ts  — In-memory trade store + per-session spending limiter
  audit.ts   — Hash-chained audit log (append-only, tamper-evident)
```

The DMK layer runs a 4-step gate before every hardware operation: singleton init → device connect → ready check → operation. User rejection (`RefusedByUserDAError`) is a neutral outcome that surfaces to the caller as `ESCALATE` — it's never retried.

---

## Built with

- [Ledger Device Management Kit](https://github.com/LedgerHQ/device-sdk-ts) — hardware communication over USB/HID
- [Ledger Agent Skills](https://github.com/LedgerHQ/agent-skills) — DMK integration patterns
- [Model Context Protocol SDK](https://github.com/modelcontextprotocol/typescript-sdk) — MCP server

#Sponsored #LedgerSponsor

[developers.ledger.com/docs/ai-tools/overview](https://developers.ledger.com/docs/ai-tools/overview) · [github.com/LedgerHQ/agent-skills](https://github.com/LedgerHQ/agent-skills)
