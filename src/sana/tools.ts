/**
 * sana_* tool definitions for the xPay MCP / agent tool surface.
 *
 * Activated when the user has linked a Sana API key (`xpay sana link <key>`
 * or env SANABOT_API_KEY). Every tool proxies through the Sana MCP gateway at
 * https://mcp.sana.bot/mcp under the xpay_ naming convention.
 *
 * Tools:
 *   sana_card              → get_card
 *   sana_card_balance      → get_card_balance
 *   sana_card_deposit      → card_deposit
 *   sana_card_transactions → get_transaction_history { context: "card" }
 *   sana_portfolio         → get_net_worth + get_holdings (merged)
 *   sana_price             → get_price
 *   sana_swap              → wallet_swap
 *   sana_notifications     → get_notifications
 */

import type { ClaudeToolDef, ToolBundle } from "../tools/index.js";
import { SanaClient } from "./client.js";

export function forSana(apiKey: string): ToolBundle<ClaudeToolDef> {
  const sana = new SanaClient(apiKey);

  const tools: ClaudeToolDef[] = [
    {
      name: "sana_card",
      description:
        "Sana agent wallet card — card metadata: type, status, last 4 digits, expiry. " +
        "Use this to check whether the card is active before spending.",
      input_schema: { type: "object", properties: {} },
    },
    {
      name: "sana_card_balance",
      description:
        "Sana agent wallet card — available spending power / credit balance on the card.",
      input_schema: { type: "object", properties: {} },
    },
    {
      name: "sana_card_deposit",
      description:
        "Sana agent wallet card — top up the card balance with USDC from the Sana wallet. " +
        "Requires agent signing to be enabled on the API key.",
      input_schema: {
        type: "object",
        properties: {
          amount: { type: "number", description: "USDC amount to deposit, e.g. 10 for $10." },
        },
        required: ["amount"],
      },
    },
    {
      name: "sana_card_transactions",
      description:
        "Sana agent wallet card — card spending history, newest first.",
      input_schema: {
        type: "object",
        properties: {
          limit: { type: "number", description: "Max entries. Default 25." },
          cursor: { type: "string", description: "Pagination cursor from a previous call." },
        },
      },
    },
    {
      name: "sana_portfolio",
      description:
        "Sana wallet — total net worth in USD plus all token holdings with 24h price changes.",
      input_schema: { type: "object", properties: {} },
    },
    {
      name: "sana_price",
      description: "Sana wallet — current USD price and 24h change for a token symbol.",
      input_schema: {
        type: "object",
        properties: {
          token: { type: "string", description: "Token symbol, e.g. SOL, USDC, ETH." },
        },
        required: ["token"],
      },
    },
    {
      name: "sana_swap",
      description:
        "Sana wallet — swap tokens inside the Sana wallet. " +
        "Requires agent signing enabled on the API key.",
      input_schema: {
        type: "object",
        properties: {
          fromToken: { type: "string", description: "Input token symbol, e.g. SOL." },
          toToken: { type: "string", description: "Output token symbol, e.g. USDC." },
          amount: { type: "number", description: "Input token amount." },
        },
        required: ["fromToken", "toToken", "amount"],
      },
    },
    {
      name: "sana_notifications",
      description: "Sana wallet — recent wallet activity feed and notifications.",
      input_schema: { type: "object", properties: {} },
    },
  ];

  const handlers: ToolBundle<ClaudeToolDef>["handlers"] = {
    sana_card: () =>
      sana.callTool("get_card"),

    sana_card_balance: () =>
      sana.callTool("get_card_balance"),

    sana_card_deposit: (input) =>
      sana.callTool("card_deposit", { amount: input.amount as number }),

    sana_card_transactions: (input) =>
      sana.callTool("get_transaction_history", {
        context: "card",
        ...(input.limit !== undefined ? { limit: input.limit } : {}),
        ...(input.cursor !== undefined ? { cursor: input.cursor } : {}),
      }),

    sana_portfolio: async () => {
      const [netWorth, holdings] = await Promise.all([
        sana.callTool("get_net_worth"),
        sana.callTool("get_holdings"),
      ]);
      return { netWorth, holdings };
    },

    sana_price: (input) =>
      sana.callTool("get_price", { token: input.token as string }),

    sana_swap: (input) =>
      sana.callTool("wallet_swap", {
        fromToken: input.fromToken as string,
        toToken: input.toToken as string,
        amount: input.amount as number,
      }),

    sana_notifications: () =>
      sana.callTool("get_notifications"),
  };

  return { tools, handlers };
}
