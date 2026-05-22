/**
 * Derive Solana + EVM keys from a single BIP-39 mnemonic.
 *
 * Paths follow standard wallets so users can recover in Phantom/Solflare
 * (Solana) and MetaMask/Rabby (EVM) using the same seed:
 *   - Solana: m/44'/501'/0'/0'        (Phantom default)
 *   - EVM:    m/44'/60'/0'/0/0        (MetaMask default)
 */

import { mnemonicToSeedSync, generateMnemonic, validateMnemonic } from "bip39";
import { derivePath } from "ed25519-hd-key";
import { Keypair } from "@solana/web3.js";
import { HDNodeWallet, Mnemonic } from "ethers";
import type { ProfileAddresses } from "./types.js";

const SOLANA_PATH = "m/44'/501'/0'/0'";
const EVM_PATH = "m/44'/60'/0'/0/0";

/** Generate a fresh 24-word mnemonic (256-bit entropy). */
export function generateNewMnemonic(): string {
  return generateMnemonic(256);
}

/** Throws if `mnemonic` is not a valid BIP-39 phrase. */
export function assertValidMnemonic(mnemonic: string): void {
  if (!validateMnemonic(mnemonic)) {
    throw new Error("Invalid BIP-39 mnemonic phrase");
  }
}

export interface DerivedKeys {
  solana: {
    keypair: Keypair;
    secretKeyBase58: string;
    address: string;
  };
  evm: {
    privateKey: string;
    address: string;
  };
}

export function deriveKeysFromMnemonic(mnemonic: string): DerivedKeys {
  assertValidMnemonic(mnemonic);
  const seed = mnemonicToSeedSync(mnemonic);

  // --- Solana ---
  const solSeed = derivePath(SOLANA_PATH, seed.toString("hex")).key;
  const solKeypair = Keypair.fromSeed(new Uint8Array(solSeed));

  // --- EVM ---
  const evmWallet = HDNodeWallet.fromMnemonic(Mnemonic.fromPhrase(mnemonic), EVM_PATH);

  return {
    solana: {
      keypair: solKeypair,
      secretKeyBase58: base58Encode(solKeypair.secretKey),
      address: solKeypair.publicKey.toBase58(),
    },
    evm: {
      privateKey: evmWallet.privateKey,
      address: evmWallet.address,
    },
  };
}

export function addressesFromMnemonic(mnemonic: string): ProfileAddresses {
  const k = deriveKeysFromMnemonic(mnemonic);
  return { solana: k.solana.address, evm: k.evm.address };
}

/** Tiny Base58 encoder (avoids adding bs58 just for this). */
function base58Encode(bytes: Uint8Array): string {
  const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  if (bytes.length === 0) return "";
  const digits = [0];
  for (let i = 0; i < bytes.length; i++) {
    let carry = bytes[i]!;
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j]! << 8;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  // Preserve leading zero bytes as leading '1's.
  let out = "";
  for (let i = 0; i < bytes.length && bytes[i] === 0; i++) out += "1";
  for (let i = digits.length - 1; i >= 0; i--) out += ALPHABET[digits[i]!];
  return out;
}
