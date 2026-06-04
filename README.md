# ledger-mcp

An MCP server for Ledger hardware wallets. Plug in your Ledger and any MCP-compatible AI agent can sign transactions, derive addresses, and check balances — with hardware confirmation required for every signing operation.

Works with Claude Code, Cursor, Cline, Windsurf, and any other MCP-compatible client.

---

## Tools

| Tool | Description | Device required? |
|---|---|---|
| `ledger_get_address` | Get ETH address for a derivation path, optionally verified on-device | Yes |
| `ledger_get_balance` | Check ETH balance for any address | No |
| `ledger_sign_transaction` | Sign and broadcast an ETH transfer | Yes — physical approval |
| `ledger_sign_message` | Sign a personal message (EIP-191) | Yes — physical approval |

Every signing tool blocks until the user physically approves on the device screen. No software path bypasses the hardware gate.

---

## Setup

### Claude Code

Add to your project's `.claude/mcp.json` (or `~/.claude/mcp.json` for global):

```json
{
  "mcpServers": {
    "ledger": {
      "command": "npx",
      "args": ["tsx", "/path/to/ledger-mcp/src/index.ts"],
      "env": {
        "LEDGER_RPC_URL": "https://eth.llamarpc.com"
      }
    }
  }
}
```

Then restart Claude Code. You'll see `ledger_get_address`, `ledger_get_balance`, `ledger_sign_transaction`, and `ledger_sign_message` in your tools list.

### Cursor / Cline / other MCP clients

Same config format — point to the server and set `LEDGER_RPC_URL` if you want a custom RPC endpoint.

---

## Usage

Once connected, you can talk to your wallet naturally:

```
What's the ETH address on my Ledger?
→ calls ledger_get_address, returns 0x...

What's my balance?
→ calls ledger_get_balance with that address

Send 0.01 ETH to 0xRecipient...
→ agent confirms details with you, calls ledger_sign_transaction
→ transaction appears on Ledger screen
→ you approve (or reject) physically
→ broadcasts on approval
```

---

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `LEDGER_RPC_URL` | `https://eth.llamarpc.com` | Ethereum JSON-RPC endpoint |

---

## Built with

- [Ledger Device Management Kit](https://github.com/LedgerHQ/device-sdk-ts) — hardware communication
- [Ledger agent skills](https://github.com/LedgerHQ/agent-skills) — DMK integration patterns
- [Model Context Protocol SDK](https://github.com/modelcontextprotocol/typescript-sdk) — MCP server

#Sponsored #LedgerSponsor

Links: [developers.ledger.com/docs/ai-tools/overview](https://developers.ledger.com/docs/ai-tools/overview) · [github.com/LedgerHQ/agent-skills](https://github.com/LedgerHQ/agent-skills)
