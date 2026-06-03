/**
 * Sana MCP client.
 *
 * Connects to https://mcp.sana.bot/mcp via Streamable HTTP transport and
 * exposes a thin `callTool()` wrapper. One persistent connection per instance;
 * reconnects automatically if the transport closes.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const SANA_MCP_URL = "https://mcp.sana.bot/mcp";

interface ContentBlock {
  type: string;
  text?: string;
}

export class SanaClient {
  private _client: Client | null = null;

  constructor(private readonly apiKey: string) {}

  private async connect(): Promise<Client> {
    if (this._client) return this._client;

    const c = new Client({ name: "xpay", version: "0.1.0" });
    const transport = new StreamableHTTPClientTransport(new URL(SANA_MCP_URL), {
      requestInit: {
        headers: { Authorization: `Bearer ${this.apiKey}` },
      },
    });
    await c.connect(transport);
    this._client = c;
    return c;
  }

  async callTool(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
    const c = await this.connect();
    const result = await c.callTool({ name, arguments: args });
    const texts = (result.content as ContentBlock[])
      .filter((b) => b.type === "text" && b.text)
      .map((b) => b.text as string);

    if (texts.length === 0) return null;
    if (texts.length === 1) {
      try { return JSON.parse(texts[0]); } catch { return texts[0]; }
    }
    return texts.join("\n");
  }
}
