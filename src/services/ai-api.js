import { defineService } from "./registry.js";
import { fail, json, readJson } from "../lib/http.js";
import { estimateTokens } from "../lib/money.js";

const MAX_MESSAGES = 50;
const MAX_MESSAGE_CHARS = 32_000;
const ROLES = new Set(["system", "user", "assistant"]);

function readMessages(body) {
  const messages = body.messages;
  if (!Array.isArray(messages) || messages.length === 0) {
    throw fail(400, "invalid_field", '"messages" must be a non-empty array of chat messages.');
  }
  if (messages.length > MAX_MESSAGES) {
    throw fail(400, "invalid_field", `"messages" may contain at most ${MAX_MESSAGES} entries.`);
  }
  return messages.map((message, index) => {
    if (!message || typeof message !== "object") {
      throw fail(400, "invalid_field", `messages[${index}] must be an object.`);
    }
    if (!ROLES.has(message.role)) {
      throw fail(400, "invalid_field", `messages[${index}].role must be system, user or assistant.`);
    }
    if (typeof message.content !== "string" || message.content.length === 0) {
      throw fail(400, "invalid_field", `messages[${index}].content must be a non-empty string.`);
    }
    if (message.content.length > MAX_MESSAGE_CHARS) {
      throw fail(
        413,
        "message_too_long",
        `messages[${index}].content exceeds ${MAX_MESSAGE_CHARS} characters.`,
      );
    }
    return { role: message.role, content: message.content };
  });
}

/**
 * Managed AI API — the launch SKU.
 *
 * Billed on `token`, taken from the provider's reported usage, never from our own estimate.
 * The estimate is used only for the pre-flight quota check.
 *
 * This service was promoted ahead of the MCP gateway because the account already has Workers
 * AI enabled and an AI Gateway in use, so it provisions no new infrastructure — the shortest
 * honest path to a billable unit. See docs/05-resource-audit.md.
 */
export default defineService({
  id: "ai-api",
  name: "Managed AI API",
  summary:
    "One OpenAI-compatible chat endpoint over Workers AI, metered per token, with per-tenant keys and quotas.",
  unit: "token",
  unitLabel: "tokens",
  sellable: true,
  docsUrl: "/v1/services/ai-api",
  plans: [
    {
      id: "free",
      name: "Free",
      description: "Evaluate with no card. Stops at the allowance rather than billing you.",
      priceMonthlyCents: 0,
      includedUnits: 50_000,
      overageMicrosPerUnit: 0,
    },
    {
      id: "starter",
      name: "Starter",
      description: "For one product or a prototype heading to production.",
      priceMonthlyCents: 2_900,
      includedUnits: 1_000_000,
      overageMicrosPerUnit: 2,
    },
    {
      id: "pro",
      name: "Pro",
      description: "For a product with steady traffic.",
      priceMonthlyCents: 9_900,
      includedUnits: 6_000_000,
      overageMicrosPerUnit: 2,
    },
    {
      id: "business",
      name: "Business",
      description: "High volume, with the lowest per-token overage.",
      priceMonthlyCents: 34_900,
      includedUnits: 30_000_000,
      overageMicrosPerUnit: 1,
    },
  ],
  routes: [
    {
      method: "POST",
      path: "/v1/ai/chat/completions",
      async handler(ctx) {
        const body = await readJson(ctx.request);
        const messages = readMessages(body);

        const requestedModel = typeof body.model === "string" ? body.model.trim() : "";
        const model = requestedModel || ctx.env.DEFAULT_AI_MODEL;
        if (!model) {
          throw fail(500, "model_not_configured", "This deployment has no default model configured.");
        }

        // Pre-flight. Only the hard-stop free tier has a finite allowance here; paid plans
        // carry overage and are allowed through so a burst is billed, not refused.
        const estimatedPromptTokens = messages.reduce(
          (total, message) => total + estimateTokens(message.content),
          0,
        );
        if (ctx.remainingUnits !== null && estimatedPromptTokens > ctx.remainingUnits) {
          throw fail(
            402,
            "quota_exceeded",
            "This request would exceed the plan allowance. Upgrade the plan or wait for the next period.",
            { remaining_units: ctx.remainingUnits, estimated_units: estimatedPromptTokens },
          );
        }

        let result;
        try {
          result = await ctx.env.AI.run(model, { messages });
        } catch (error) {
          throw fail(
            502,
            "upstream_error",
            `The model provider rejected the request: ${error?.message ?? "unknown error"}`,
          );
        }

        const usage = result?.usage ?? {};
        const promptTokens = Number.isInteger(usage.prompt_tokens)
          ? usage.prompt_tokens
          : estimatedPromptTokens;
        const content = typeof result?.response === "string"
          ? result.response
          : JSON.stringify(result?.response ?? "");
        const completionTokens = Number.isInteger(usage.completion_tokens)
          ? usage.completion_tokens
          : estimateTokens(content);
        const totalTokens = Number.isInteger(usage.total_tokens)
          ? usage.total_tokens
          : promptTokens + completionTokens;

        // Billing happens here, on the provider's numbers.
        await ctx.record({ units: totalTokens });

        return json({
          id: `chatcmpl_${ctx.requestId.replace(/-/g, "").slice(0, 24)}`,
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model,
          choices: [
            { index: 0, message: { role: "assistant", content }, finish_reason: "stop" },
          ],
          usage: {
            prompt_tokens: promptTokens,
            completion_tokens: completionTokens,
            total_tokens: totalTokens,
          },
        });
      },
    },
  ],
});
