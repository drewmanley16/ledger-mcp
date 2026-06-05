import { randomBytes } from "crypto";

export type TradeType = "send" | "swap" | "buy" | "sell";
export type TradeStatus = "pending" | "confirmed" | "rejected";

export interface TradeProposal {
  id: string;
  type: TradeType;
  // ETH send fields
  to?: string;
  value_eth?: string;
  // Generic trade fields (swap/buy/sell)
  fromAsset?: string;
  toAsset?: string;
  fromAmount?: string;
  toAmount?: string;
  venue?: string;
  note?: string;
  // Signing config
  derivation_path?: string;
  rpc_url?: string;
  // State
  proposedAt: number;
  status: TradeStatus;
  confirmedAt?: number;
  rejectedAt?: number;
  txHash?: string;
  signature?: string;
  rejectionReason?: string;
}

const _trades = new Map<string, TradeProposal>();

export function generateTradeId(): string {
  return `trade_${Date.now()}_${randomBytes(4).toString("hex")}`;
}

export function createTrade(
  params: Omit<TradeProposal, "id" | "proposedAt" | "status">
): TradeProposal {
  const trade: TradeProposal = {
    ...params,
    id: generateTradeId(),
    proposedAt: Date.now(),
    status: "pending",
  };
  _trades.set(trade.id, trade);
  return trade;
}

export function getTrade(id: string): TradeProposal | undefined {
  return _trades.get(id);
}

export function updateTrade(
  id: string,
  updates: Partial<TradeProposal>
): TradeProposal | undefined {
  const trade = _trades.get(id);
  if (!trade) return undefined;
  const updated = { ...trade, ...updates };
  _trades.set(id, updated);
  return updated;
}

// ── Spending limiter (session-scoped) ─────────────────────────────────────────

const LIMIT_ETH = parseFloat(process.env.LEDGER_SPENDING_LIMIT_ETH ?? "0");
let _spentEth = 0;

export function getSpendingLimit() {
  return {
    limit_eth: LIMIT_ETH > 0 ? LIMIT_ETH : null,
    spent_eth: _spentEth,
    remaining_eth: LIMIT_ETH > 0 ? Math.max(0, LIMIT_ETH - _spentEth) : null,
    unlimited: LIMIT_ETH <= 0,
    resets: "session",
  };
}

export function checkSpendingLimit(valueEth: string): {
  ok: boolean;
  reason?: string;
} {
  if (LIMIT_ETH <= 0) return { ok: true };
  const amount = parseFloat(valueEth);
  if (isNaN(amount)) return { ok: false, reason: "Invalid ETH amount" };
  if (_spentEth + amount > LIMIT_ETH) {
    return {
      ok: false,
      reason: `Spending limit: ${(_spentEth + amount).toFixed(4)} ETH would exceed the ${LIMIT_ETH} ETH session limit (${_spentEth.toFixed(4)} ETH already spent)`,
    };
  }
  return { ok: true };
}

export function recordSpend(valueEth: string) {
  const amount = parseFloat(valueEth);
  if (!isNaN(amount) && amount > 0) _spentEth += amount;
}
