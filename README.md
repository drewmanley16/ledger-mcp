# ledger-mcp

An MCP server that puts a Ledger hardware device in the confirmation loop for any AI agent. Propose a trade, the server blocks on physical device approval, and nothing executes until the user taps ✓.

Works with Claude Code, Cursor, Cline, Windsurf, and any other MCP-compatible client.

---

## Tools

### Wallet tools

| Tool | Description | Device required? |
|---|---|---|
| `ledger_get_address` | Get ETH address for a derivation path, optionally verified on-device | Yes |
| `ledger_get_balance` | Check ETH balance for any address | No |
| `ledger_sign_transaction` | Sign and broadcast an ETH transfer | Yes — physical approval |
| `ledger_sign_message` | Sign a personal message (EIP-191) | Yes — physical approval |

### Trade confirmation tools

| Tool | Description | Device required? |
|---|---|---|
| `ledger_propose_trade` | Submit a trade intent — returns a `trade_id`, nothing executes yet | No |
| `ledger_confirm_trade` | Execute the trade — blocks until hardware approval or rejection | Yes — physical approval |
| `ledger_reject_trade` | Cancel a pending trade without touching the device | No |
| `ledger_get_spending_limit` | Check remaining per-session ETH budget | No |
| `ledger_audit_log` | View the tamper-evident hash-chained history of all actions | No |

Every signing tool blocks until the user physically approves on the device screen. No software path bypasses the hardware gate.

---

## How the trade confirmation flow works

```
Agent → ledger_get_spending_limit        checks remaining budget
Agent → ledger_propose_trade(...)        returns trade_id, nothing sent yet
Agent → ledger_confirm_trade(trade_id)   blocks here...
                                         ↓
                              [ Ledger screen shows trade details ]
                                         ↓
                              User taps ✓ or ✗ on device
                                         ↓
              ✓ Approved: broadcasts tx, records to audit log
              ✗ Rejected: records HARDWARE_REJECTED to audit log
```

For non-ETH trades (swaps, buys, sells), `confirm_trade` produces a hardware-signed intent record rather than an on-chain transaction — the signature proves the user approved the action on their physical device.

---

## Demo: rejection flow

```
Agent: I want to sell all your ETH.
  → calls ledger_propose_trade({ type: "sell", fromAsset: "ETH", ... })
  → trade_id: trade_1234_abcd

Agent: Confirming now...
  → calls ledger_confirm_trade({ trade_id: "trade_1234_abcd" })
  → Ledger screen: "Sign: {"type":"sell","fromAsset":"ETH",...}"

User taps ✗ on device
  → [ESCALATE] Rejected on device — user cancelled
  → Audit log records HARDWARE_REJECTED

Nothing executes. Audit trail preserved.
```

---

## Setup

### Claude Code

Add to `.claude/mcp.json` (or `~/.claude/mcp.json` for global):

```json
{
  "mcpServers": {
    "ledger": {
      "command": "npx",
      "args": ["tsx", "/path/to/ledger-mcp/src/index.ts"],
      "env": {
        "LEDGER_RPC_URL": "https://eth.llamarpc.com",
        "LEDGER_SPENDING_LIMIT_ETH": "1.0"
      }
    }
  }
}
```

Restart Claude Code. You'll see all 9 tools in your tools list.

### Speculos (hardware emulation)

For demo/CI use without a physical device:

```bash
# Start Speculos with Ethereum app
speculos --model nanosp ethereum-app.elf

# Run the MCP server in stub mode
LEDGER_STUB=1 npm start
# or
npm run start:stub
```

### Cursor / Cline / other MCP clients

Same config format — point to the server entry and set env vars as needed.

---

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `LEDGER_RPC_URL` | `https://ethereum.publicnode.com` | Ethereum JSON-RPC endpoint |
| `LEDGER_SPENDING_LIMIT_ETH` | `0` (unlimited) | Per-session ETH spending cap for trade agents |
| `LEDGER_AUDIT_LOG` | `./ledger-audit.ndjson` | Path for the tamper-evident audit log |
| `LEDGER_STUB` | unset | Set to `1` to run in stub mode (no physical device needed) |

---

## Audit log

Every action — proposals, confirmations, rejections — is written to `ledger-audit.ndjson` as a hash-chained log:

```json
{"seq":1,"timestamp":"2025-01-01T00:00:00.000Z","action":"PROPOSED","tradeId":"trade_1234_abcd","details":{...},"prevHash":"0000...","hash":"a1b2..."}
{"seq":2,"timestamp":"2025-01-01T00:00:10.000Z","action":"HARDWARE_REJECTED","tradeId":"trade_1234_abcd","details":{...},"prevHash":"a1b2...","hash":"c3d4..."}
```

Each entry's `hash` is SHA-256 of the entry body including `prevHash`. Any tampered entry breaks the chain, detectable via `ledger_audit_log({ verify: true })`.

---

## Built with

- [Ledger Device Management Kit](https://github.com/LedgerHQ/device-sdk-ts) — hardware communication
- [Ledger agent skills](https://github.com/LedgerHQ/agent-skills) — DMK integration patterns
- [Model Context Protocol SDK](https://github.com/modelcontextprotocol/typescript-sdk) — MCP server

#Sponsored #LedgerSponsor

Links: [developers.ledger.com/docs/ai-tools/overview](https://developers.ledger.com/docs/ai-tools/overview) · [github.com/LedgerHQ/agent-skills](https://github.com/LedgerHQ/agent-skills)
