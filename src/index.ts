/**
 * Ledge — hardware-secured AI crypto agent
 *
 * SIGNER=insecure  → private key from .env (⚠️ vulnerable to prompt injection)
 * SIGNER=ledger    → Ledger hardware gate (default — no key in software)
 *
 * Usage:
 *   npm run start:ledger   # requires a Ledger device
 *   npm run start:insecure # for comparison/demo only
 */

import { runAgent } from "./agent.js";
import type { Signer } from "./agent.js";

const signerMode = process.env.SIGNER ?? "ledger";
const prompt = process.argv[2] ?? "What is my wallet address and current ETH balance?";

async function main() {
  let signer: Signer;

  if (signerMode === "insecure") {
    console.log("⚠️  Running in INSECURE mode — private key in environment");
    const insecure = await import("./signing/insecure.js");
    signer = {
      getAddress: insecure.getAddress,
      signAndSend: insecure.signAndSend,
    };
  } else {
    console.log("🔐 Running in LEDGER mode — hardware signing gate active");
    const dmk = await import("./signing/dmk.js");
    signer = {
      getAddress: dmk.getAddress,
      signAndSend: dmk.signAndSend,
    };
  }

  await runAgent(prompt, signer, signerMode);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
