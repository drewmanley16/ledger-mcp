import { createHash } from "crypto";
import { appendFileSync, readFileSync, existsSync } from "fs";
import { join } from "path";

export type AuditAction =
  | "PROPOSED"
  | "CONFIRMED"
  | "REJECTED"
  | "HARDWARE_REJECTED"
  | "LIMIT_EXCEEDED";

export interface AuditEntry {
  seq: number;
  timestamp: string;
  action: AuditAction;
  tradeId: string;
  details: Record<string, unknown>;
  prevHash: string;
  hash: string;
}

export const LOG_PATH =
  process.env.LEDGER_AUDIT_LOG ?? join(process.cwd(), "ledger-audit.ndjson");

function computeHash(partial: Omit<AuditEntry, "hash">): string {
  return createHash("sha256").update(JSON.stringify(partial)).digest("hex");
}

let _seq = 0;
let _prevHash =
  "0000000000000000000000000000000000000000000000000000000000000000";

// Resume chain state from existing log file on startup
if (existsSync(LOG_PATH)) {
  const lines = readFileSync(LOG_PATH, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean);
  if (lines.length > 0) {
    const last = JSON.parse(lines[lines.length - 1]!) as AuditEntry;
    _seq = last.seq;
    _prevHash = last.hash;
  }
}

export function appendAuditEntry(
  action: AuditAction,
  tradeId: string,
  details: Record<string, unknown>
): AuditEntry {
  _seq += 1;
  const partial: Omit<AuditEntry, "hash"> = {
    seq: _seq,
    timestamp: new Date().toISOString(),
    action,
    tradeId,
    details,
    prevHash: _prevHash,
  };
  const entryHash = computeHash(partial);
  const entry: AuditEntry = { ...partial, hash: entryHash };
  _prevHash = entryHash;
  appendFileSync(LOG_PATH, JSON.stringify(entry) + "\n");
  return entry;
}

export function readAuditLog(limit = 20, tradeId?: string): AuditEntry[] {
  if (!existsSync(LOG_PATH)) return [];
  const lines = readFileSync(LOG_PATH, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean);
  const entries = lines.map((l) => JSON.parse(l) as AuditEntry);
  const filtered = tradeId
    ? entries.filter((e) => e.tradeId === tradeId)
    : entries;
  return filtered.slice(-limit);
}

export function verifyChain(): { ok: boolean; brokenAt?: number } {
  if (!existsSync(LOG_PATH)) return { ok: true };
  const lines = readFileSync(LOG_PATH, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean);
  let prev =
    "0000000000000000000000000000000000000000000000000000000000000000";
  for (const line of lines) {
    const entry = JSON.parse(line) as AuditEntry;
    if (entry.prevHash !== prev) return { ok: false, brokenAt: entry.seq };
    const { hash, ...partial } = entry;
    if (computeHash(partial) !== hash) return { ok: false, brokenAt: entry.seq };
    prev = hash;
  }
  return { ok: true };
}
