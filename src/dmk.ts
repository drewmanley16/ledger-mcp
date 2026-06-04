/**
 * DMK session manager — singleton device connection shared across tool calls.
 * Uses Node-HID transport (no browser required).
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

// ── Singleton ──────────────────────────────────────────────────────────────────

let _dmk: DeviceManagementKit | null = null;

export function getDmk(): DeviceManagementKit {
  if (!_dmk) {
    _dmk = new DeviceManagementKitBuilder()
      .addTransport(nodeHidTransportFactory)
      .build();
  }
  return _dmk;
}

// ── Gate result type ───────────────────────────────────────────────────────────

export type GateResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: "ABORT" | "ESCALATE"; message: string };

export function abort(msg: string): GateResult<never> {
  return { ok: false, reason: "ABORT", message: msg };
}

export function escalate(msg: string): GateResult<never> {
  return { ok: false, reason: "ESCALATE", message: msg };
}

// ── Prompt helper (stderr — not captured by MCP client) ───────────────────────

export function devicePrompt(msg: string) {
  process.stderr.write(`\n[Ledger] ${msg}\n`);
}

// ── Step 2: connect to device ─────────────────────────────────────────────────

export async function connectDevice(
  dmk: DeviceManagementKit,
  timeoutMs = 15_000
): Promise<GateResult<string>> {
  return new Promise((resolve) => {
    devicePrompt("Waiting for Ledger device…");

    let done = false;
    const sub = dmk.listenToAvailableDevices({}).subscribe({
      next: (devices) => {
        if (done) return;
        if (devices.length === 0) return;
        if (devices.length > 1) {
          done = true;
          sub.unsubscribe();
          resolve(escalate("Multiple Ledger devices detected — connect only one"));
          return;
        }
        done = true;
        sub.unsubscribe();
        dmk
          .connect({ device: devices[0]! })
          .then((sessionId) => resolve({ ok: true, value: sessionId }))
          .catch((err: unknown) =>
            resolve(abort(`Connect failed: ${String(err)}`))
          );
      },
      error: (err: unknown) => {
        if (!done) {
          done = true;
          resolve(abort(`Discovery error: ${String(err)}`));
        }
      },
    });

    setTimeout(() => {
      if (!done) {
        done = true;
        sub.unsubscribe();
        resolve(abort("No Ledger device found within 15 seconds. Plug in your device and try again."));
      }
    }, timeoutMs);
  });
}

// ── Step 3: verify device is ready ────────────────────────────────────────────

export async function ensureReady(
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
    devicePrompt("Device is locked — enter your PIN on the device.");
    try {
      await firstValueFrom(
        dmk.getDeviceSessionState({ sessionId }).pipe(
          filter((s) => s.deviceStatus === DeviceStatus.CONNECTED),
          map(() => undefined)
        )
      );
      return { ok: true, value: undefined };
    } catch {
      return escalate("Device locked — user must enter PIN");
    }
  }
  if (state.deviceStatus === DeviceStatus.BUSY) {
    return abort("Device is busy");
  }
  return abort("Device disconnected");
}

// ── Observable → promise helper ────────────────────────────────────────────────

export async function observableToResult<T>(
  observable: ReturnType<typeof SignerEthBuilder.prototype.build>["getAddress"] extends (
    ...args: unknown[]
  ) => { observable: infer O }
    ? O
    : never,
  onPending?: (interaction: UserInteractionRequired) => void
): Promise<GateResult<T>> {
  try {
    const output = await firstValueFrom(
      (observable as ReturnType<ReturnType<typeof SignerEthBuilder.prototype.build>["getAddress"]>["observable"]).pipe(
        map((s) => {
          if (s.status === DeviceActionStatus.Pending && onPending) {
            const interaction = (
              s as { intermediateValue?: { requiredUserInteraction?: UserInteractionRequired } }
            ).intermediateValue?.requiredUserInteraction;
            if (interaction !== undefined) onPending(interaction);
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
          if (s.status === DeviceActionStatus.Stopped) throw new Error("Operation stopped");
          if (s.status === DeviceActionStatus.Completed) return s.output;
          throw new Error("Unexpected state");
        })
      )
    );
    return { ok: true, value: output as T };
  } catch (err: unknown) {
    const tag = (err as Record<string, unknown>)?._tag ?? "";
    const code =
      (err as Record<string, unknown>)?.errorCode ??
      (err as Record<string, Record<string, unknown>>)?.originalError?.errorCode ?? "";

    if (tag === "RefusedByUserDAError" || code === "5501" || code === "6985") {
      return escalate("Rejected on device — user cancelled");
    }
    return abort(`Device error: ${String(err)}`);
  }
}

// ── Eth address ───────────────────────────────────────────────────────────────

export async function getEthAddress(
  derivationPath = "44'/60'/0'/0/0",
  checkOnDevice = false
): Promise<GateResult<string>> {
  const dmk = getDmk();
  const sessionResult = await connectDevice(dmk);
  if (!sessionResult.ok) return sessionResult;

  const { value: sessionId } = sessionResult;
  try {
    const readyResult = await ensureReady(dmk, sessionId);
    if (!readyResult.ok) return readyResult;

    const signer = new SignerEthBuilder({ dmk, sessionId }).build();

    if (checkOnDevice) {
      devicePrompt("Verify the address on your Ledger device screen.");
    }

    const { observable } = signer.getAddress(derivationPath, { checkOnDevice });

    const result = await firstValueFrom(
      observable.pipe(
        filter(
          (s) =>
            s.status === DeviceActionStatus.Completed ||
            s.status === DeviceActionStatus.Error
        ),
        map((s) => {
          if (s.status === DeviceActionStatus.Error) throw s.error;
          return (s as { output: { address: string } }).output;
        })
      )
    );

    return { ok: true, value: result.address };
  } catch (err: unknown) {
    return abort(String(err));
  } finally {
    dmk.disconnect({ sessionId });
  }
}

// ── Sign ETH transaction ──────────────────────────────────────────────────────

export interface SignResult {
  signedTransaction: string;
  txHash: string;
}

export async function signAndSendEth(
  to: string,
  valueEth: string,
  rpcUrl: string,
  derivationPath = "44'/60'/0'/0/0"
): Promise<GateResult<SignResult>> {
  const dmk = getDmk();
  const sessionResult = await connectDevice(dmk);
  if (!sessionResult.ok) return sessionResult;

  const { value: sessionId } = sessionResult;
  try {
    const readyResult = await ensureReady(dmk, sessionId);
    if (!readyResult.ok) return readyResult;

    const provider = new ethers.JsonRpcProvider(rpcUrl);
    const signer = new SignerEthBuilder({ dmk, sessionId }).build();

    // Get sender address from device
    const { observable: addrObs } = signer.getAddress(derivationPath, { checkOnDevice: false });
    const addrOutput = await firstValueFrom(
      addrObs.pipe(
        filter(
          (s) =>
            s.status === DeviceActionStatus.Completed ||
            s.status === DeviceActionStatus.Error
        ),
        map((s) => {
          if (s.status === DeviceActionStatus.Error) throw s.error;
          return (s as { output: { address: string } }).output;
        })
      )
    );

    const from = addrOutput.address;
    const [nonce, feeData, chainId] = await Promise.all([
      provider.getTransactionCount(from),
      provider.getFeeData(),
      provider.getNetwork().then((n) => n.chainId),
    ]);

    const tx = ethers.Transaction.from({
      to,
      from,
      value: ethers.parseEther(valueEth),
      nonce,
      gasLimit: 21_000n,
      maxFeePerGas: feeData.maxFeePerGas ?? undefined,
      maxPriorityFeePerGas: feeData.maxPriorityFeePerGas ?? undefined,
      chainId,
      type: 2,
    });

    devicePrompt(
      `Review on device: send ${valueEth} ETH to ${to}\nApprove on your Ledger.`
    );

    const { observable: signObs } = signer.signTransaction(
      derivationPath,
      ethers.getBytes(tx.unsignedSerialized)
    );

    const sigOutput = await firstValueFrom(
      signObs.pipe(
        map((s) => {
          if (s.status === DeviceActionStatus.Pending) {
            const interaction = (
              s as { intermediateValue?: { requiredUserInteraction?: UserInteractionRequired } }
            ).intermediateValue?.requiredUserInteraction;
            if (interaction === UserInteractionRequired.SignTransaction) {
              devicePrompt("Approve the transaction on your Ledger.");
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
          if (s.status === DeviceActionStatus.Stopped) throw new Error("Stopped");
          return (s as { output: { r: string; s: string; v: number } }).output;
        })
      )
    );

    tx.signature = ethers.Signature.from(sigOutput);
    const response = await provider.broadcastTransaction(tx.serialized);

    return {
      ok: true,
      value: { signedTransaction: tx.serialized, txHash: response.hash },
    };
  } catch (err: unknown) {
    const tag = (err as Record<string, unknown>)?._tag ?? "";
    const code =
      (err as Record<string, unknown>)?.errorCode ??
      (err as Record<string, Record<string, unknown>>)?.originalError?.errorCode ?? "";
    if (tag === "RefusedByUserDAError" || code === "5501" || code === "6985") {
      return escalate("Transaction rejected on device");
    }
    return abort(String(err));
  } finally {
    dmk.disconnect({ sessionId });
  }
}

// ── Sign personal message ──────────────────────────────────────────────────────

export async function signMessage(
  message: string,
  derivationPath = "44'/60'/0'/0/0"
): Promise<GateResult<string>> {
  const dmk = getDmk();
  const sessionResult = await connectDevice(dmk);
  if (!sessionResult.ok) return sessionResult;

  const { value: sessionId } = sessionResult;
  try {
    const readyResult = await ensureReady(dmk, sessionId);
    if (!readyResult.ok) return readyResult;

    const signer = new SignerEthBuilder({ dmk, sessionId }).build();

    devicePrompt(`Review on device: sign message\n"${message.slice(0, 80)}${message.length > 80 ? "…" : ""}"`);

    const { observable } = signer.signMessage(derivationPath, message);

    const output = await firstValueFrom(
      observable.pipe(
        map((s) => {
          if (s.status === DeviceActionStatus.Pending) {
            const interaction = (
              s as { intermediateValue?: { requiredUserInteraction?: UserInteractionRequired } }
            ).intermediateValue?.requiredUserInteraction;
            if (interaction === UserInteractionRequired.SignPersonalMessage) {
              devicePrompt("Approve the message signature on your Ledger.");
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
          if (s.status === DeviceActionStatus.Stopped) throw new Error("Stopped");
          return (s as { output: { r: string; s: string; v: number } }).output;
        })
      )
    );

    // Reconstruct signature
    const sig = ethers.Signature.from(output);
    return { ok: true, value: sig.serialized };
  } catch (err: unknown) {
    const tag = (err as Record<string, unknown>)?._tag ?? "";
    const code =
      (err as Record<string, unknown>)?.errorCode ??
      (err as Record<string, Record<string, unknown>>)?.originalError?.errorCode ?? "";
    if (tag === "RefusedByUserDAError" || code === "5501" || code === "6985") {
      return escalate("Message signing rejected on device");
    }
    return abort(String(err));
  } finally {
    dmk.disconnect({ sessionId });
  }
}

// ── Get ETH balance (RPC, no device needed) ────────────────────────────────────

export async function getBalance(
  address: string,
  rpcUrl: string
): Promise<string> {
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const balance = await provider.getBalance(address);
  return ethers.formatEther(balance);
}
