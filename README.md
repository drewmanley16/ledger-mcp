# Ledge — Hardware-Secured AI Crypto Agent

An AI agent (powered by Claude) that manages an Ethereum wallet — with a hardware signing gate that no software can bypass.

Built with Claude Code + Ledger's DMK skills for the Ledger N3XT Agent Stack bounty.

---

## The problem with AI agents and crypto

Most AI agents that touch crypto sign transactions with a private key stored in a `.env` file or environment variable:

```bash
# The bad way — everything downstream of this is a single point of failure
PRIVATE_KEY=0xdeadbeef...
```

If an attacker prompt-injects your agent (a malicious website, a crafted tool response, a poisoned data source), they can instruct the agent to call `signAndSend` with their address. The agent signs. The funds move. There's no kill switch.

---

## The fix: hardware-enforced signing gates

Ledge replaces the private key with a **Ledger Device Management Kit (DMK)** integration. Every transaction goes through 5 mandatory gates before a signature is produced:

```
User request
    │
    ▼
[Claude Agent Brain] — proposes transaction, calls execute_send tool
    │
    ▼
[Gate 1] SDK Init       — DeviceManagementKit singleton initialized
    │
    ▼
[Gate 2] Device Session — Ledger device discovered and connected
    │
    ▼
[Gate 3] Device State   — device is unlocked and ready (not locked/busy)
    │
    ▼
[Gate 4] App Management — Ethereum app open on device
    │
    ▼
[Gate 5] Operation      — transaction displayed on device screen
    │
    └──► User approves on device → signature produced → tx broadcast
         User rejects on device  → ESCALATE, operation stops, no signature
```

**No software path bypasses the device screen.** A prompt-injected agent can call `execute_send` — the gate fires, the transaction appears on the Ledger screen, the user sees the real destination address, and rejects it. Done.

---

## Architecture

```
src/
  index.ts          — entry point; selects backend via SIGNER env var
  agent.ts          — Claude API agent (claude-sonnet-4-6) with tools:
                        get_wallet_info, get_recent_transactions,
                        estimate_send, execute_send
  signing/
    insecure.ts     — ⚠️ private key signing (shows the vulnerability)
    dmk.ts          — Ledger DMK 5-step gate (the secure approach)
```

The two signing backends expose the same interface — the agent doesn't know which one is active. The only difference is what happens when `execute_send` is called.

---

## Built with Ledger's DMK skills

This project was built with Claude Code and Ledger's official [agent skills](https://github.com/LedgerHQ/agent-skills):

```bash
npx skills add ledgerhq/agent-skills \
  -s ledger-dmk-implementation dmk-intent-vocabulary dmk-business-logic
```

The skills are installed in `.agents/skills/` and loaded by Claude Code when working on the DMK signing layer. They encode the 5-step process, correct observable patterns, ESCALATE/ABORT gates, and error classification — so the generated code matches Ledger's intended integration patterns.

---

## Setup

```bash
npm install

# Ledger mode (requires a Ledger device)
npm run start:ledger "What is my ETH balance?"
npm run start:ledger "Send 0.001 ETH to 0xRecipient..."

# Insecure mode (comparison demo — requires PRIVATE_KEY)
PRIVATE_KEY=0x... npm run start:insecure "What is my balance?"
```

Set `RPC_URL` to use a custom Ethereum RPC (defaults to `https://eth.llamarpc.com`).

---

## The security model

| Property | Insecure (`.env` key) | Ledger DMK |
|---|---|---|
| Key location | Environment variable | Never leaves the device |
| Prompt injection → funds move | Yes | No — hardware gate blocks it |
| Compromised runtime → funds move | Yes | No — device screen is truth |
| User sees destination before signing | No | Yes — on the trusted device screen |
| Kill switch | Delete the env var (too late) | Reject on device (always available) |

---

## Resources

- [Ledger AI Tools docs](https://developers.ledger.com/docs/ai-tools/overview)
- [DMK agent skills repo](https://github.com/LedgerHQ/agent-skills)
- [Device Management Kit SDK](https://github.com/LedgerHQ/device-sdk-ts)

#Sponsored #LedgerSponsor
