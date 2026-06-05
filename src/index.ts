#!/usr/bin/env node
/**
 * ledger-mcp — MCP server for Ledger hardware wallets
 *
 * Exposes Ledger signing, address derivation, and balance checks as MCP tools.
 * Any MCP-compatible AI agent (Claude Code, Cursor, Cline, etc.) can use your
 * Ledger device without touching the DMK SDK directly.
 *
 * Install in Claude Code:
 *   npx ledger-mcp install
 *
 * Or add to .claude/mcp.json:
 *   { "ledger": { "command": "npx", "args": ["ledger-mcp"] } }
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio";
import { z } from "zod";
import { getEthAddress, signAndSendEth, signMessage, getBalance } from "./dmk";
import {
  createTrade,
  getTrade,
  updateTrade,
  getSpendingLimit,
  checkSpendingLimit,
  recordSpend,
  type TradeType,
} from "./trades";
import { appendAuditEntry, readAuditLog, verifyChain, LOG_PATH } from "./audit";

const DEFAULT_RPC = process.env.LEDGER_RPC_URL ?? "https://ethereum.publicnode.com";
const DEFAULT_DERIVATION = "44'/60'/0'/0/0";

const server = new McpServer(
  {
    name: "ledger-mcp",
    version: "0.1.0",
  },
  {
    capabilities: { tools: {} },
    instructions: `
You have access to a Ledger hardware wallet via the ledger-mcp server.

Important:
- Every signing operation requires the user to physically confirm on their Ledger device.
- Always show the user what you are about to sign before calling a signing tool.
- Never call ledger_sign_transaction, ledger_sign_message, or ledger_confirm_trade without explicit user instruction.
- The device screen is the authoritative display — what appears there is what gets signed.
- Use ledger_get_address to get the wallet address before constructing transactions.

For AI trading agents:
- Call ledger_get_spending_limit before proposing any trade to check available budget.
- Use ledger_propose_trade to submit a trade intent. This returns a trade_id.
- Always call ledger_confirm_trade with the trade_id — never auto-confirm without the user's knowledge.
- Hardware rejection (user taps ✗ on device) is a neutral outcome, not an error.
- Every action is recorded in the tamper-evident audit log (ledger_audit_log).
`.trim(),
  }
);

// ── Tool: get_address ──────────────────────────────────────────────────────────

server.registerTool(
  "ledger_get_address",
  {
    description:
      "Get the Ethereum address for a derivation path from the connected Ledger device. " +
      "Optionally verify it on the device screen before returning.",
    inputSchema: {
      derivation_path: z
        .string()
        .optional()
        .describe(`BIP-44 derivation path. Default: ${DEFAULT_DERIVATION}`),
      verify_on_device: z
        .boolean()
        .optional()
        .describe(
          "If true, the address is displayed on the Ledger screen for the user to verify. " +
            "Use for receive addresses — never trust the host display alone."
        ),
    },
  },
  async ({ derivation_path, verify_on_device }) => {
    const path = derivation_path ?? DEFAULT_DERIVATION;
    const check = verify_on_device ?? false;

    const result = await getEthAddress(path, check);

    if (!result.ok) {
      return {
        content: [
          {
            type: "text",
            text: `[${result.reason}] ${result.message}`,
          },
        ],
        isError: true,
      };
    }

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            address: result.value,
            derivation_path: path,
            verified_on_device: check,
          }),
        },
      ],
    };
  }
);

// ── Tool: get_balance ──────────────────────────────────────────────────────────

server.registerTool(
  "ledger_get_balance",
  {
    description:
      "Get the ETH balance for an address. Does not require the Ledger device to be connected. " +
      "Tip: call ledger_get_address first to get the address from the device.",
    inputSchema: {
      address: z.string().describe("Ethereum address (0x...)"),
      rpc_url: z
        .string()
        .optional()
        .describe(`Ethereum RPC URL. Default: ${DEFAULT_RPC}`),
    },
  },
  async ({ address, rpc_url }) => {
    try {
      const balance = await getBalance(address, rpc_url ?? DEFAULT_RPC);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ address, balance_eth: balance }),
          },
        ],
      };
    } catch (err: unknown) {
      return {
        content: [{ type: "text", text: `Error: ${String(err)}` }],
        isError: true,
      };
    }
  }
);

// ── Tool: sign_transaction ─────────────────────────────────────────────────────

server.registerTool(
  "ledger_sign_transaction",
  {
    description:
      "Sign and broadcast an ETH transfer using the connected Ledger device. " +
      "The transaction is displayed on the device screen — the user must physically " +
      "approve it before it is signed and broadcast. " +
      "IMPORTANT: Always confirm the destination address and amount with the user before calling this.",
    inputSchema: {
      to: z.string().describe("Recipient Ethereum address"),
      value_eth: z
        .string()
        .describe("Amount to send in ETH (e.g. '0.01')"),
      derivation_path: z
        .string()
        .optional()
        .describe(`Sender derivation path. Default: ${DEFAULT_DERIVATION}`),
      rpc_url: z
        .string()
        .optional()
        .describe(`Ethereum RPC URL. Default: ${DEFAULT_RPC}`),
    },
  },
  async ({ to, value_eth, derivation_path, rpc_url }) => {
    const result = await signAndSendEth(
      to,
      value_eth,
      rpc_url ?? DEFAULT_RPC,
      derivation_path ?? DEFAULT_DERIVATION
    );

    if (!result.ok) {
      return {
        content: [
          {
            type: "text",
            text: `[${result.reason}] ${result.message}`,
          },
        ],
        isError: true,
      };
    }

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            tx_hash: result.value.txHash,
            to,
            value_eth,
            status: "broadcast",
          }),
        },
      ],
    };
  }
);

// ── Tool: sign_message ─────────────────────────────────────────────────────────

server.registerTool(
  "ledger_sign_message",
  {
    description:
      "Sign a personal message (EIP-191) using the connected Ledger device. " +
      "The message is displayed on the device screen — the user must physically approve it. " +
      "Returns the hex signature.",
    inputSchema: {
      message: z.string().describe("The message to sign"),
      derivation_path: z
        .string()
        .optional()
        .describe(`Derivation path. Default: ${DEFAULT_DERIVATION}`),
    },
  },
  async ({ message, derivation_path }) => {
    const result = await signMessage(
      message,
      derivation_path ?? DEFAULT_DERIVATION
    );

    if (!result.ok) {
      return {
        content: [
          {
            type: "text",
            text: `[${result.reason}] ${result.message}`,
          },
        ],
        isError: true,
      };
    }

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            message,
            signature: result.value,
          }),
        },
      ],
    };
  }
);

// ── Tool: ledger_propose_trade ────────────────────────────────────────────────

server.registerTool(
  "ledger_propose_trade",
  {
    description:
      "Propose a trade or transfer intent for hardware-gated confirmation. " +
      "Returns a trade_id that must be passed to ledger_confirm_trade before anything executes. " +
      "Call ledger_get_spending_limit first to check budget. " +
      "For ETH sends: provide type='send', to, value_eth. " +
      "For swaps/buys/sells: provide type, fromAsset, toAsset, fromAmount, venue.",
    inputSchema: {
      type: z
        .enum(["send", "swap", "buy", "sell"])
        .describe("Trade type: 'send' for ETH transfers, 'swap'/'buy'/'sell' for exchange intents"),
      to: z.string().optional().describe("Recipient address (required for type='send')"),
      value_eth: z.string().optional().describe("ETH amount to send (required for type='send')"),
      fromAsset: z.string().optional().describe("Asset to sell/spend (e.g. 'ETH', 'USDC')"),
      toAsset: z.string().optional().describe("Asset to receive (e.g. 'WBTC', 'DAI')"),
      fromAmount: z.string().optional().describe("Amount of fromAsset"),
      toAmount: z.string().optional().describe("Expected toAsset amount (for swaps)"),
      venue: z.string().optional().describe("Exchange or DEX name (e.g. 'Uniswap', 'Coinbase')"),
      note: z.string().optional().describe("Human-readable trade rationale (shown in audit log)"),
      derivation_path: z.string().optional().describe(`Signing key derivation path. Default: ${DEFAULT_DERIVATION}`),
      rpc_url: z.string().optional().describe(`RPC endpoint. Default: ${DEFAULT_RPC}`),
    },
  },
  async ({ type, to, value_eth, fromAsset, toAsset, fromAmount, toAmount, venue, note, derivation_path, rpc_url }) => {
    // Validate send-specific fields
    if (type === "send") {
      if (!to || !value_eth) {
        return {
          content: [{ type: "text", text: "[VALIDATION] type='send' requires both 'to' and 'value_eth'" }],
          isError: true,
        };
      }
      const limit = checkSpendingLimit(value_eth);
      if (!limit.ok) {
        const trade = createTrade({ type, to, value_eth, derivation_path, rpc_url });
        appendAuditEntry("LIMIT_EXCEEDED", trade.id, { type, to, value_eth, reason: limit.reason });
        updateTrade(trade.id, { status: "rejected", rejectionReason: limit.reason, rejectedAt: Date.now() });
        return {
          content: [{ type: "text", text: `[LIMIT_EXCEEDED] ${limit.reason}` }],
          isError: true,
        };
      }
    }

    const trade = createTrade({
      type: type as TradeType,
      to, value_eth, fromAsset, toAsset, fromAmount, toAmount, venue, note,
      derivation_path, rpc_url,
    });

    appendAuditEntry("PROPOSED", trade.id, {
      type, to, value_eth, fromAsset, toAsset, fromAmount, toAmount, venue, note,
    });

    const summary =
      type === "send"
        ? `Send ${value_eth} ETH to ${to}`
        : `${type.toUpperCase()} ${fromAmount ?? "?"} ${fromAsset ?? "?"} → ${toAsset ?? "?"} via ${venue ?? "unspecified"}`;

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            trade_id: trade.id,
            status: "pending",
            summary,
            note: "Call ledger_confirm_trade with this trade_id to proceed. Physical device approval required.",
          }),
        },
      ],
    };
  }
);

// ── Tool: ledger_confirm_trade ────────────────────────────────────────────────

server.registerTool(
  "ledger_confirm_trade",
  {
    description:
      "Execute a proposed trade after hardware confirmation on the Ledger device. " +
      "Blocks until the user physically approves or rejects on the device screen. " +
      "For ETH sends: broadcasts the transaction. " +
      "For other trade types: produces a hardware-signed intent record. " +
      "IMPORTANT: Only call this after the user has explicitly agreed to proceed.",
    inputSchema: {
      trade_id: z.string().describe("The trade_id returned by ledger_propose_trade"),
    },
  },
  async ({ trade_id }) => {
    const trade = getTrade(trade_id);

    if (!trade) {
      return {
        content: [{ type: "text", text: `[NOT_FOUND] No trade with id '${trade_id}'` }],
        isError: true,
      };
    }
    if (trade.status !== "pending") {
      return {
        content: [{ type: "text", text: `[INVALID_STATE] Trade ${trade_id} is already ${trade.status}` }],
        isError: true,
      };
    }

    const path = trade.derivation_path ?? DEFAULT_DERIVATION;
    const rpc = trade.rpc_url ?? DEFAULT_RPC;

    if (trade.type === "send" && trade.to && trade.value_eth) {
      // ETH transfer — full on-chain execution
      const result = await signAndSendEth(trade.to, trade.value_eth, rpc, path);

      if (!result.ok) {
        const action = result.reason === "ESCALATE" ? "HARDWARE_REJECTED" : "REJECTED";
        updateTrade(trade_id, {
          status: "rejected",
          rejectedAt: Date.now(),
          rejectionReason: result.message,
        });
        appendAuditEntry(action, trade_id, { reason: result.message });
        return {
          content: [{ type: "text", text: `[${result.reason}] ${result.message}` }],
          isError: true,
        };
      }

      recordSpend(trade.value_eth);
      updateTrade(trade_id, {
        status: "confirmed",
        confirmedAt: Date.now(),
        txHash: result.value.txHash,
      });
      appendAuditEntry("CONFIRMED", trade_id, {
        type: "send",
        to: trade.to,
        value_eth: trade.value_eth,
        txHash: result.value.txHash,
      });

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              trade_id,
              status: "confirmed",
              tx_hash: result.value.txHash,
              to: trade.to,
              value_eth: trade.value_eth,
            }),
          },
        ],
      };
    }

    // Non-ETH trade (swap/buy/sell) — hardware-signed intent
    const intentMessage = JSON.stringify({
      trade_id,
      type: trade.type,
      fromAsset: trade.fromAsset,
      toAsset: trade.toAsset,
      fromAmount: trade.fromAmount,
      toAmount: trade.toAmount,
      venue: trade.venue,
      note: trade.note,
      timestamp: new Date().toISOString(),
    });

    const result = await signMessage(intentMessage, path);

    if (!result.ok) {
      const action = result.reason === "ESCALATE" ? "HARDWARE_REJECTED" : "REJECTED";
      updateTrade(trade_id, {
        status: "rejected",
        rejectedAt: Date.now(),
        rejectionReason: result.message,
      });
      appendAuditEntry(action, trade_id, { reason: result.message });
      return {
        content: [{ type: "text", text: `[${result.reason}] ${result.message}` }],
        isError: true,
      };
    }

    updateTrade(trade_id, {
      status: "confirmed",
      confirmedAt: Date.now(),
      signature: result.value,
    });
    appendAuditEntry("CONFIRMED", trade_id, {
      type: trade.type,
      fromAsset: trade.fromAsset,
      toAsset: trade.toAsset,
      fromAmount: trade.fromAmount,
      venue: trade.venue,
      signature: result.value,
    });

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            trade_id,
            status: "confirmed",
            type: trade.type,
            hardware_signature: result.value,
            note: "Intent signed by hardware device. Execute via your trading venue using this signature as proof of approval.",
          }),
        },
      ],
    };
  }
);

// ── Tool: ledger_reject_trade ─────────────────────────────────────────────────

server.registerTool(
  "ledger_reject_trade",
  {
    description:
      "Cancel a pending trade proposal without touching the hardware device. " +
      "Use this when the agent or user decides not to proceed after proposing a trade. " +
      "The rejection is recorded in the audit log.",
    inputSchema: {
      trade_id: z.string().describe("The trade_id to cancel"),
      reason: z.string().optional().describe("Why the trade is being rejected (recorded in audit log)"),
    },
  },
  async ({ trade_id, reason }) => {
    const trade = getTrade(trade_id);

    if (!trade) {
      return {
        content: [{ type: "text", text: `[NOT_FOUND] No trade with id '${trade_id}'` }],
        isError: true,
      };
    }
    if (trade.status !== "pending") {
      return {
        content: [{ type: "text", text: `[INVALID_STATE] Trade ${trade_id} is already ${trade.status}` }],
        isError: true,
      };
    }

    updateTrade(trade_id, {
      status: "rejected",
      rejectedAt: Date.now(),
      rejectionReason: reason ?? "Rejected by agent",
    });
    appendAuditEntry("REJECTED", trade_id, {
      reason: reason ?? "Rejected by agent",
      type: trade.type,
    });

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            trade_id,
            status: "rejected",
            reason: reason ?? "Rejected by agent",
          }),
        },
      ],
    };
  }
);

// ── Tool: ledger_get_spending_limit ───────────────────────────────────────────

server.registerTool(
  "ledger_get_spending_limit",
  {
    description:
      "Check the current spending limit for this session. " +
      "Set LEDGER_SPENDING_LIMIT_ETH env var to enforce a per-session ETH budget. " +
      "Returns remaining budget and total spent. " +
      "Call this before proposing large trades.",
    inputSchema: {},
  },
  async () => {
    const limit = getSpendingLimit();
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(limit),
        },
      ],
    };
  }
);

// ── Tool: ledger_audit_log ────────────────────────────────────────────────────

server.registerTool(
  "ledger_audit_log",
  {
    description:
      "View the tamper-evident audit log of all trade proposals, confirmations, and rejections. " +
      "Each entry is SHA-256 hash-chained to the previous — any tampering breaks the chain. " +
      "Optionally filter by trade_id or limit the number of entries returned.",
    inputSchema: {
      limit: z
        .number()
        .int()
        .min(1)
        .max(200)
        .optional()
        .describe("Number of recent entries to return. Default: 20"),
      trade_id: z
        .string()
        .optional()
        .describe("Filter entries for a specific trade_id"),
      verify: z
        .boolean()
        .optional()
        .describe("If true, verify the hash chain integrity before returning entries"),
    },
  },
  async ({ limit, trade_id, verify }) => {
    const entries = readAuditLog(limit ?? 20, trade_id);
    const result: Record<string, unknown> = {
      entries,
      count: entries.length,
      log_path: LOG_PATH,
    };

    if (verify) {
      const check = verifyChain();
      result.chain_integrity = check.ok ? "valid" : `BROKEN at seq ${check.brokenAt}`;
    }

    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  }
);

// ── Start ──────────────────────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  process.stderr.write(`Fatal: ${err}\n`);
  process.exit(1);
});
