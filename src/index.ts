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

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { getEthAddress, signAndSendEth, signMessage, getBalance } from "./dmk.js";

const DEFAULT_RPC = process.env.LEDGER_RPC_URL ?? "https://eth.llamarpc.com";
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
- Never call ledger_sign_transaction or ledger_sign_message without explicit user instruction.
- The device screen is the authoritative display — what appears there is what gets signed.
- Use ledger_get_address to get the wallet address before constructing transactions.
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

// ── Start ──────────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
