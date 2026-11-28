/**
 * GuildEra MCP client.
 *
 * Connects to https://mcp.guildera.ai/mcp (Streamable HTTP) for X/Twitter
 * post scraping. The service is free (demo) for now, so no key is needed.
 * When GuildEra turns on billing, a GUILD KEY (gk_live_...) is passed as
 * `key_hash` on every call; set it with env GUILDERA_KEY or ToolOptions.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

export const GUILDERA_MCP_URL = "https://mcp.guildera.ai/mcp";

interface ContentBlock {
  type: string;
  text?: string;
}

/** Minimal surface the tools need; tests swap in a fake. */
export interface GuilderaCaller {
  callTool(name: string, args?: Record<string, unknown>): Promise<unknown>;
}

export class GuilderaClient implements GuilderaCaller {
  private _client: Client | null = null;

  constructor(
    private readonly key?: string,
    private readonly url: string = GUILDERA_MCP_URL,
  ) {}

  private async connect(): Promise<Client> {
    if (this._client) return this._client;
    const c = new Client({ name: "xpay", version: "0.1.0" });
    await c.connect(new StreamableHTTPClientTransport(new URL(this.url)));
    this._client = c;
    return c;
  }

  async callTool(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
    const c = await this.connect();
    const result = await c.callTool({
      name,
      arguments: this.key ? { ...args, key_hash: this.key } : args,
    });
    const texts = (result.content as ContentBlock[])
      .filter((b) => b.type === "text" && b.text)
      .map((b) => b.text as string);
    const text = texts.join("\n");
    if (result.isError) {
      throw new Error(`GuildEra: ${text || "call failed"}`);
    }
    if (texts.length === 0) return null;
    try { return JSON.parse(text); } catch { return text; }
  }
}
