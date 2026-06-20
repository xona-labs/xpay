/**
 * Report — comprehensive USDC activity report fetched from the OrbitX402 API.
 *
 * Replaces the old direct-RPC history module. On-chain data is fetched
 * server-side by OrbitX402; xpay only receives the aggregated report.
 */

export type ReportPeriod = "daily" | "weekly" | "monthly";

export interface ReportTimelineEntry {
  date: string;
  sent: number;
  received: number;
  txCount: number;
}

export interface ReportCounterparty {
  address: string;
  sent: number;
  received: number;
  totalVolume: number;
  txCount: number;
}

export interface ReportTransaction {
  txHash: string;
  direction: "sent" | "received";
  amount: number;
  counterparty: string;
  timestamp: string | null;
}

export interface WalletReport {
  address: string;
  network: string;
  period: ReportPeriod;
  periodStart: string;
  periodEnd: string;
  summary: {
    totalSent: number;
    totalReceived: number;
    netFlow: number;
    txCount: number;
    asset: string;
  };
  timeline: ReportTimelineEntry[];
  topCounterparties: ReportCounterparty[];
  topTransactions: ReportTransaction[];
}

export interface ReportOptions {
  period?: ReportPeriod;
  network?: string;
  /** Override the OrbitX402 report endpoint (for tests / self-hosted). */
  endpoint?: string;
}

const DEFAULT_ENDPOINT = "https://api.orbitx402.com/api/report";

export async function fetchReport(
  address: string,
  opts: ReportOptions = {},
): Promise<WalletReport> {
  const period = opts.period ?? "weekly";
  const network = opts.network ?? "solana";
  const base = opts.endpoint ?? DEFAULT_ENDPOINT;

  const url = `${base}?address=${encodeURIComponent(address)}&period=${period}&network=${network}`;
  const res = await fetch(url, { headers: { accept: "application/json" } });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`xpay report: ${res.status} ${res.statusText}${body ? ` — ${body}` : ""}`);
  }

  return res.json() as Promise<WalletReport>;
}
