/**
 * Profile types. A profile is a named set of keys + config persisted under
 * `~/.xpay/<name>/` (or `<workspace>/.xpay/<name>/` when workspace-local).
 *
 * One mnemonic derives both Solana and EVM keys — standard BIP-39 + BIP-44
 * paths so the keys are recoverable in Phantom, MetaMask, Solflare, etc.
 */

export interface ProfileAddresses {
  /** Base58 Solana public key. */
  solana: string;
  /** 0x-prefixed EVM address (same address on every EVM chain). */
  evm: string;
}

/** Shape persisted on disk (`wallet.json`). */
export interface WalletFile {
  version: 1;
  createdAt: string;
  addresses: ProfileAddresses;
  /** When unencrypted (dev only), the mnemonic lives here in plaintext. */
  mnemonic?: string;
  /** When encrypted: scrypt-derived AES-256-GCM blob containing the mnemonic. */
  encrypted?: {
    cipher: "aes-256-gcm";
    kdf: { name: "scrypt"; salt: string; N: number; r: number; p: number };
    iv: string;
    ciphertext: string;
    authTag: string;
  };
}

/** Shape persisted on disk (`config.json`). Hand-edited by users sometimes. */
export interface ProfileConfig {
  version: 1;
  /** Networks the profile is active on. */
  networks: string[];
  /** Default network for transfers / pay when not specified. */
  defaultNetwork: string;
  /** Per-network RPC overrides. Falls back to SDK defaults. */
  rpcs?: Partial<Record<string, string>>;
  /** Guardrail policy (mirrors GuardrailConfig but JSON-serializable). */
  guardrail?: {
    maxPerTx?: number;
    maxPerDay?: number;
    allowedHosts?: string[];
    requireApprovalAbove?: number;
  };
  /**
   * Biometric unlock (macOS Touch ID). When enabled, the wallet passphrase is
   * held in the login keychain and released after a biometric check via
   * `xpay biometric enable`. The passphrase itself remains the recovery path.
   */
  biometric?: {
    enabled: boolean;
  };
  /** Linked API key for opt-in dashboard sync. */
  link?: {
    apiKey: string;
    endpoint: string;
  };
  /**
   * Sana agent wallet card integration.
   * Activate with `xpay sana link <key>` or set env SANABOT_API_KEY.
   * When present, the MCP server registers sana_* tools automatically.
   */
  sana?: {
    apiKey: string;
  };
  /**
   * MagicBlock Private Ephemeral Rollup integration.
   * Platform-level config — set once by the xpay operator via `xpay magicblock configure`.
   * End users never need a MagicBlock account; they just pass private:true.
   */
  magicblock?: {
    /** Override the MagicBlock Payments API base URL. */
    apiUrl?: string;
    /** Override the ephemeral rollup RPC endpoint. */
    ephemeralRpc?: string;
  };
}

/** Runtime handle returned by {@link initProfile}/{@link loadProfile}. */
export interface LoadedProfile {
  /** Profile name (directory name under `~/.xpay/`). */
  name: string;
  /** Absolute path to the profile directory. */
  path: string;
  addresses: ProfileAddresses;
  config: ProfileConfig;
  /** Decoded mnemonic — only present while the process holds the unlocked profile. */
  mnemonic: string;
}
