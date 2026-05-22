/**
 * Profile storage — read/write `wallet.json` + `config.json` under
 * `~/.xpay/<name>/` (or a workspace path) with passphrase-based encryption.
 *
 * Encryption uses Node's built-in crypto (no new deps): scrypt → AES-256-GCM
 * over the mnemonic. AES-GCM gives us authenticated encryption so we detect
 * wrong passphrases / tampering instead of returning garbage.
 */

import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, chmodSync, statSync } from "node:fs";
import { randomBytes, scryptSync, createCipheriv, createDecipheriv } from "node:crypto";
import type { ProfileConfig, WalletFile } from "./types.js";

const SCRYPT_N = 1 << 15; // 32768 — sane default, tunable.
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LEN = 32;

/** Root directory holding all profiles. Honors $XPAY_HOME. */
export function xpayHome(): string {
  return process.env.XPAY_HOME ?? join(homedir(), ".xpay");
}

/** Workspace-local profile dir (when `--workspace` is passed). */
export function workspaceXpayDir(cwd = process.cwd()): string {
  return join(resolve(cwd), ".xpay");
}

export function profilePath(name: string, opts: { workspace?: boolean | string } = {}): string {
  const root = opts.workspace
    ? typeof opts.workspace === "string"
      ? workspaceXpayDir(opts.workspace)
      : workspaceXpayDir()
    : xpayHome();
  return join(root, name);
}

export function profileExists(name: string, opts: { workspace?: boolean | string } = {}): boolean {
  return existsSync(join(profilePath(name, opts), "wallet.json"));
}

export function listProfiles(opts: { workspace?: boolean | string } = {}): string[] {
  const root = opts.workspace
    ? typeof opts.workspace === "string"
      ? workspaceXpayDir(opts.workspace)
      : workspaceXpayDir()
    : xpayHome();
  if (!existsSync(root)) return [];
  return readdirSync(root).filter((name) => {
    try {
      return statSync(join(root, name)).isDirectory() && existsSync(join(root, name, "wallet.json"));
    } catch {
      return false;
    }
  });
}

// -----------------------------------------------------------------------------
// Encryption
// -----------------------------------------------------------------------------

function encryptMnemonic(mnemonic: string, passphrase: string): WalletFile["encrypted"] {
  const salt = randomBytes(16);
  const key = scryptSync(passphrase, salt, KEY_LEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: 64 * 1024 * 1024,
  });
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(mnemonic, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return {
    cipher: "aes-256-gcm",
    kdf: { name: "scrypt", salt: salt.toString("hex"), N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P },
    iv: iv.toString("hex"),
    ciphertext: ciphertext.toString("hex"),
    authTag: authTag.toString("hex"),
  };
}

function decryptMnemonic(payload: NonNullable<WalletFile["encrypted"]>, passphrase: string): string {
  const salt = Buffer.from(payload.kdf.salt, "hex");
  const key = scryptSync(passphrase, salt, KEY_LEN, {
    N: payload.kdf.N,
    r: payload.kdf.r,
    p: payload.kdf.p,
    maxmem: 64 * 1024 * 1024,
  });
  const iv = Buffer.from(payload.iv, "hex");
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(Buffer.from(payload.authTag, "hex"));
  try {
    const plain = Buffer.concat([
      decipher.update(Buffer.from(payload.ciphertext, "hex")),
      decipher.final(),
    ]);
    return plain.toString("utf8");
  } catch {
    throw new Error("Wrong passphrase, or wallet file is corrupted/tampered");
  }
}

// -----------------------------------------------------------------------------
// Read / write
// -----------------------------------------------------------------------------

export function writeWalletFile(
  dir: string,
  wallet: WalletFile,
): void {
  ensureDir(dir);
  const file = join(dir, "wallet.json");
  writeFileSync(file, JSON.stringify(wallet, null, 2));
  // 0600 — readable only by the owner.
  try { chmodSync(file, 0o600); } catch { /* not POSIX */ }
}

export function readWalletFile(dir: string): WalletFile {
  const file = join(dir, "wallet.json");
  if (!existsSync(file)) {
    throw new Error(`No wallet at ${file}. Run \`xpay init\` first.`);
  }
  return JSON.parse(readFileSync(file, "utf8")) as WalletFile;
}

export function writeConfigFile(dir: string, config: ProfileConfig): void {
  ensureDir(dir);
  writeFileSync(join(dir, "config.json"), JSON.stringify(config, null, 2));
}

export function readConfigFile(dir: string): ProfileConfig {
  const file = join(dir, "config.json");
  if (!existsSync(file)) return defaultConfig();
  return JSON.parse(readFileSync(file, "utf8")) as ProfileConfig;
}

export function defaultConfig(): ProfileConfig {
  return {
    version: 1,
    networks: ["solana", "base"],
    defaultNetwork: "solana",
  };
}

function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
}

// -----------------------------------------------------------------------------
// Build / unlock WalletFile
// -----------------------------------------------------------------------------

export interface BuildWalletInput {
  mnemonic: string;
  addresses: WalletFile["addresses"];
  passphrase?: string; // omit for unencrypted (dev only)
}

export function buildWalletFile(input: BuildWalletInput): WalletFile {
  const base: WalletFile = {
    version: 1,
    createdAt: new Date().toISOString(),
    addresses: input.addresses,
  };
  if (input.passphrase && input.passphrase.length > 0) {
    base.encrypted = encryptMnemonic(input.mnemonic, input.passphrase);
  } else {
    base.mnemonic = input.mnemonic;
  }
  return base;
}

export function unlockWalletFile(wallet: WalletFile, passphrase?: string): string {
  if (wallet.mnemonic) return wallet.mnemonic; // unencrypted
  if (!wallet.encrypted) throw new Error("Wallet file has neither mnemonic nor encrypted payload");
  if (!passphrase) throw new Error("Wallet is encrypted — passphrase required");
  return decryptMnemonic(wallet.encrypted, passphrase);
}
