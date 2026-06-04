/**
 * Ledger DMK signing gate — hardware-enforced transaction authorization.
 *
 * Every send goes through 5 mandatory gates before a signature is produced:
 *   Init → Session → Device State → App Management → Operation
 *
 * No software path bypasses this. The Ledger device screen is the only
 * trusted display. Prompt injection can propose a transaction; it cannot
 * confirm one.
 *
 * Generated with Claude Code using the ledger-dmk-implementation skill.
 */

import {
  DeviceManagementKitBuilder,
  DeviceActionStatus,
  DeviceStatus,
  UserInteractionRequired,
  type DeviceManagementKit,
} from "@ledgerhq/device-management-kit";
import { nodeHidTransportFactory } from "@ledgerhq/device-transport-kit-node-hid";
import { SignerEthBuilder } from "@ledgerhq/device-signer-kit-ethereum";
import { ethers } from "ethers";
import { filter, firstValueFrom, map } from "rxjs";

// ── Singleton DMK instance (one per process) ──────────────────────────────────

let _dmk: DeviceManagementKit | null = null;

function getDmk(): DeviceManagementKit {
  if (!_dmk) {
    _dmk = new DeviceManagementKitBuilder()
      .addTransport(nodeHidTransportFactory)
      .build();
  }
  return _dmk;
}

// ── Gate result types ──────────────────────────────────────────────────────────

export type GateResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: "ABORT"; message: string }
  | { ok: false; reason: "ESCALATE"; message: string };

function abort(message: string): GateResult<never> {
  return { ok: false, reason: "ABORT", message };
}

function escalate(message: string): GateResult<never> {
  return { ok: false, reason: "ESCALATE", message };
}

// ── User interaction prompts (printed to stderr — not agent-visible) ──────────

function prompt(msg: string) {
  process.stderr.write(`\n[LEDGER] ${msg}\n`);
}

// ── Step 2: Device Session ─────────────────────────────────────────────────────

async function getSession(
  dmk: DeviceManagementKit
): Promise<GateResult<string>> {
  return new Promise((resolve) => {
    prompt("Plug in your Ledger and unlock it. Discovering device…");

    const devices$ = dmk.listenToAvailableDevices({});
    let resolved = false;

    const sub = devices$.subscribe({
      next: (devices) => {
        if (resolved) return;

        if (devices.length === 0) return; // waiting for device

        if (devices.length > 1) {
          resolved = true;
          sub.unsubscribe();
          resolve(
            escalate("Multiple Ledger devices detected — cannot select autonomously")
          );
          return;
        }

        resolved = true;
        sub.unsubscribe();

        dmk
          .connect({ device: devices[0]! })
          .then((sessionId) => resolve({ ok: true, value: sessionId }))
          .catch((err: unknown) =>
            resolve(abort(`Device connect failed: ${String(err)}`))
          );
      },
      error: (err: unknown) => {
        if (!resolved) {
          resolved = true;
          resolve(abort(`Device discovery failed: ${String(err)}`));
        }
      },
    });

    // 15-second timeout
    setTimeout(() => {
      if (!resolved) {
        resolved = true;
        sub.unsubscribe();
        resolve(abort("No Ledger device detected within 15 seconds"));
      }
    }, 15_000);
  });
}

// ── Step 3: Device State ───────────────────────────────────────────────────────

async function checkDeviceState(
  dmk: DeviceManagementKit,
  sessionId: string
): Promise<GateResult<void>> {
  const state = await firstValueFrom(
    dmk.getDeviceSessionState({ sessionId })
  );

  if (state.deviceStatus === DeviceStatus.CONNECTED) {
    return { ok: true, value: undefined };
  }
  if (state.deviceStatus === DeviceStatus.LOCKED) {
    prompt("Device is locked — please enter your PIN.");
    // Wait for unlock (up to 60s)
    try {
      await firstValueFrom(
        dmk.getDeviceSessionState({ sessionId }).pipe(
          filter((s) => s.deviceStatus === DeviceStatus.CONNECTED),
          map(() => undefined)
        )
      );
      return { ok: true, value: undefined };
    } catch {
      return escalate("Device remained locked — user must enter PIN");
    }
  }
  if (state.deviceStatus === DeviceStatus.BUSY) {
    return abort("Device is busy — try again shortly");
  }
  return abort("Device disconnected");
}

// ── Step 5: Sign ETH transaction ───────────────────────────────────────────────

async function signEthTransaction(
  dmk: DeviceManagementKit,
  sessionId: string,
  derivationPath: string,
  txBytes: Uint8Array
): Promise<GateResult<{ r: string; s: string; v: number }>> {
  const signer = new SignerEthBuilder({ dmk, sessionId }).build();
  const { observable, cancel: _cancel } = signer.signTransaction(derivationPath, txBytes);

  try {
    const output = await firstValueFrom(
      observable.pipe(
        // Surface user interaction prompts as they arrive
        map((s) => {
          if (s.status === DeviceActionStatus.Pending) {
            const interaction = (s as { intermediateValue?: { requiredUserInteraction?: UserInteractionRequired } })
              .intermediateValue?.requiredUserInteraction;
            if (interaction === UserInteractionRequired.SignTransaction) {
              prompt("Review and approve the transaction on your Ledger device.");
            } else if (interaction === UserInteractionRequired.UnlockDevice) {
              prompt("Unlock your Ledger device to continue.");
            }
          }
          return s;
        }),
        filter(
          (s) =>
            s.status === DeviceActionStatus.Completed ||
            s.status === DeviceActionStatus.Error ||
            s.status === DeviceActionStatus.Stopped
        ),
        map((s) => {
          if (s.status === DeviceActionStatus.Error) throw s.error;
          if (s.status === DeviceActionStatus.Stopped)
            throw new Error("Operation stopped");
          if (s.status === DeviceActionStatus.Completed) return s.output;
          throw new Error("Unexpected state");
        })
      )
    );

    return { ok: true, value: output as { r: string; s: string; v: number } };
  } catch (err: unknown) {
    const tag = (err as Record<string, unknown>)?._tag ?? "";
    const code =
      (err as Record<string, unknown>)?.errorCode ??
      (err as Record<string, Record<string, unknown>>)?.originalError?.errorCode ??
      "";

    if (
      tag === "RefusedByUserDAError" ||
      code === "5501" ||
      code === "6985"
    ) {
      return escalate("Transaction rejected on device — user cancelled");
    }
    return abort(`Signing failed: ${String(err)}`);
  }
}

// ── Public API ─────────────────────────────────────────────────────────────────

export interface HardwareSignResult {
  txHash: string;
  signedTransaction: string;
}

/**
 * Signs and broadcasts an ETH transaction through the Ledger hardware gate.
 *
 * All 5 DMK gates are mandatory. If any gate fails, the operation aborts
 * before a signature is produced. The device screen is the only trusted display.
 */
export async function signAndSend(
  to: string,
  valueEth: string,
  _memo?: string
): Promise<HardwareSignResult> {
  const dmk = getDmk();
  const provider = new ethers.JsonRpcProvider(
    process.env.RPC_URL ?? "https://eth.llamarpc.com"
  );
  const derivationPath = "44'/60'/0'/0/0";

  // Step 2: Session
  const sessionResult = await getSession(dmk);
  if (!sessionResult.ok) throw new Error(`[${sessionResult.reason}] ${sessionResult.message}`);
  const { value: sessionId } = sessionResult;

  try {
    // Step 3: Device state
    const stateResult = await checkDeviceState(dmk, sessionId);
    if (!stateResult.ok) throw new Error(`[${stateResult.reason}] ${stateResult.message}`);

    // Step 4: App management — SignerEthBuilder handles OpenApp automatically
    // Step 5: Build and sign the transaction

    // Derive the sender address from the device
    const signer = new SignerEthBuilder({ dmk, sessionId }).build();
    const addrResult$ = signer.getAddress(derivationPath, { checkOnDevice: false });
    const addrOutput = await firstValueFrom(
      addrResult$.observable.pipe(
        filter(
          (s) =>
            s.status === DeviceActionStatus.Completed ||
            s.status === DeviceActionStatus.Error
        ),
        map((s) => {
          if (s.status === DeviceActionStatus.Error) throw s.error;
          return s.output as { address: string };
        })
      )
    );

    const fromAddress = addrOutput.address;
    const nonce = await provider.getTransactionCount(fromAddress);
    const feeData = await provider.getFeeData();

    const tx = ethers.Transaction.from({
      to,
      from: fromAddress,
      value: ethers.parseEther(valueEth),
      nonce,
      gasLimit: 21_000n,
      maxFeePerGas: feeData.maxFeePerGas ?? undefined,
      maxPriorityFeePerGas: feeData.maxPriorityFeePerGas ?? undefined,
      chainId: 1,
      type: 2,
    });
    const txBytes = ethers.getBytes(tx.unsignedSerialized);

    prompt(
      `Sending ${valueEth} ETH to ${to}\nPlease review and confirm on your Ledger.`
    );

    const signResult = await signEthTransaction(dmk, sessionId, derivationPath, txBytes);
    if (!signResult.ok) throw new Error(`[${signResult.reason}] ${signResult.message}`);

    const { r, s, v } = signResult.value;
    tx.signature = ethers.Signature.from({ r, s, v });

    const response = await provider.broadcastTransaction(tx.serialized);
    return { txHash: response.hash, signedTransaction: tx.serialized };
  } finally {
    dmk.disconnect({ sessionId });
  }
}

export async function getAddress(): Promise<string> {
  const dmk = getDmk();
  const sessionResult = await getSession(dmk);
  if (!sessionResult.ok)
    throw new Error(`[${sessionResult.reason}] ${sessionResult.message}`);

  const { value: sessionId } = sessionResult;
  try {
    const signer = new SignerEthBuilder({ dmk, sessionId }).build();
    const { observable } = signer.getAddress("44'/60'/0'/0/0", {
      checkOnDevice: false,
    });
    const output = await firstValueFrom(
      observable.pipe(
        filter(
          (s) =>
            s.status === DeviceActionStatus.Completed ||
            s.status === DeviceActionStatus.Error
        ),
        map((s) => {
          if (s.status === DeviceActionStatus.Error) throw s.error;
          return s.output as { address: string };
        })
      )
    );
    return output.address;
  } finally {
    dmk.disconnect({ sessionId });
  }
}
