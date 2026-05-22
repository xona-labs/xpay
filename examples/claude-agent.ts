/**
 * Claude agent end-to-end: load profile, register xPay tools, run a turn.
 *
 * Run:
 *   ANTHROPIC_API_KEY=sk-ant-...  \
 *   XPAY_PASSPHRASE=...           \
 *   tsx examples/claude-agent.ts "find a cheap research API and call it"
 *
 * Prereq: `xpay init` has been run at least once.
 */

import "dotenv/config";
import Anthropic from "@anthropic-ai/sdk";
import { createXPay, forClaude, loadProfile } from "../src/index.js";

async function main() {
  const userPrompt =
    process.argv.slice(2).join(" ") || "find one cheap defi yields service and show me what it returns";

  const profile = await loadProfile({
    name: process.env.XPAY_PROFILE ?? "default",
    passphrase: process.env.XPAY_PASSPHRASE,
  });
  const xpay = createXPay({ profile });
  const { tools, handlers } = forClaude(xpay);

  const client = new Anthropic();
  let response = await client.messages.create({
    model: "claude-sonnet-4-5-20250929",
    max_tokens: 2048,
    tools,
    messages: [{ role: "user", content: userPrompt }],
  });

  // Tool loop: keep dispatching until the model returns an end_turn without tool calls.
  const history: Anthropic.Messages.MessageParam[] = [{ role: "user", content: userPrompt }];
  while (response.stop_reason === "tool_use") {
    history.push({ role: "assistant", content: response.content });
    const results: Anthropic.Messages.ToolResultBlockParam[] = [];
    for (const block of response.content) {
      if (block.type !== "tool_use") continue;
      console.log(`→ ${block.name}(${JSON.stringify(block.input).slice(0, 80)})`);
      try {
        const out = await handlers[block.name]!(block.input as Record<string, unknown>);
        results.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: JSON.stringify(out).slice(0, 8000),
        });
      } catch (err) {
        results.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: `Error: ${(err as Error).message}`,
          is_error: true,
        });
      }
    }
    history.push({ role: "user", content: results });
    response = await client.messages.create({
      model: "claude-sonnet-4-5-20250929",
      max_tokens: 2048,
      tools,
      messages: history,
    });
  }

  console.log("\n----- final answer -----\n");
  for (const block of response.content) {
    if (block.type === "text") process.stdout.write(block.text);
  }
  console.log("");
}

main().catch((err) => {
  console.error("FAIL:", err);
  process.exit(1);
});
