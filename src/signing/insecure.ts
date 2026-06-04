/**
 * ⚠️  INSECURE BASELINE — do not use in production
 *
 * Signs transactions with a raw private key from the environment.
 * If an attacker prompt-injects the agent or steals the .env file,
 * they have unconditional access to move every dollar in this wallet.
 */

import { ethers } from "ethers";

export interface SignedTx {
  signedTransaction: string;
  txHash: string;
}

function getWallet(): ethers.Wallet {
  const key = process.env.PRIVATE_KEY;
  if (!key) throw new Error("PRIVATE_KEY not set in environment");
  const provider = new ethers.JsonRpcProvider(
    process.env.RPC_URL ?? "https://eth.llamarpc.com"
  );
  return new ethers.Wallet(key, provider);
}

export async function getAddress(): Promise<string> {
  return getWallet().address;
}

export async function signAndSend(
  to: string,
  valueEth: string,
  memo?: string
): Promise<SignedTx> {
  const wallet = getWallet();
  const tx = await wallet.sendTransaction({
    to,
    value: ethers.parseEther(valueEth),
    data: memo ? ethers.hexlify(ethers.toUtf8Bytes(memo)) : "0x",
  });
  return {
    signedTransaction: tx.hash,
    txHash: tx.hash,
  };
}

export async function estimateGas(to: string, valueEth: string): Promise<string> {
  const wallet = getWallet();
  const gas = await wallet.estimateGas({
    to,
    value: ethers.parseEther(valueEth),
  });
  return gas.toString();
}
