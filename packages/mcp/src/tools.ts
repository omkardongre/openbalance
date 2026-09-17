import { type OpenBalanceClient, OpenBalanceError } from "@openbalance/sdk";

export type ToolDefinition = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

export type ToolResult =
  | { ok: true; value: unknown }
  | { ok: false; code: string; message: string; retryable: boolean };

export const toolDefinitions: ToolDefinition[] = [
  {
    name: "fund_test_balance",
    description:
      "Grant clearly labelled test assets to the configured account. Test money only; never card funding.",
    inputSchema: {
      type: "object",
      required: ["amount"],
      properties: {
        amount: { type: "string", pattern: "^[1-9][0-9]*$", description: "Amount in base units." },
      },
    },
  },
  {
    name: "get_account_activity",
    description: "Read finalized payments and reserve transitions for the configured account.",
    inputSchema: {
      type: "object",
      properties: { limit: { type: "integer", minimum: 1, maximum: 100, default: 25 } },
    },
  },
  {
    name: "get_payment_intent",
    description: "Read one finalized payment projection by its 32-byte identifier.",
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: { id: { type: "string", pattern: "^0x[0-9a-fA-F]{64}$" } },
    },
  },
  {
    name: "get_reserve_channel",
    description:
      "Read the finalized state of a reserve channel, including remaining units and deadline.",
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: { id: { type: "string", pattern: "^0x[0-9a-fA-F]{64}$" } },
    },
  },
  {
    name: "create_checkout_order",
    description: "Create a vendor checkout order. Requires an idempotency key.",
    inputSchema: {
      type: "object",
      required: ["orderReference", "orderVersion", "description", "grossUnits", "idempotencyKey"],
      properties: {
        orderReference: { type: "string", maxLength: 160 },
        orderVersion: { type: "string", pattern: "^[1-9][0-9]*$" },
        description: { type: "string", maxLength: 160 },
        grossUnits: { type: "string", pattern: "^[1-9][0-9]*$" },
        idempotencyKey: { type: "string", maxLength: 128 },
      },
    },
  },
];

function asString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`Invalid ${name}`);
  return value;
}

/** Dispatches a tool call to the SDK. It never grants payment authority beyond the API's own rules. */
export async function callTool(
  client: OpenBalanceClient,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  try {
    switch (name) {
      case "fund_test_balance":
        return { ok: true, value: await client.fundTestBalance(asString(args.amount, "amount")) };
      case "get_account_activity": {
        const limit = typeof args.limit === "number" ? args.limit : 25;
        return { ok: true, value: await client.activity(limit) };
      }
      case "get_payment_intent":
        return { ok: true, value: await client.paymentIntent(asString(args.id, "id")) };
      case "get_reserve_channel":
        return { ok: true, value: await client.reserveChannel(asString(args.id, "id")) };
      case "create_checkout_order":
        return {
          ok: true,
          value: await client.createCheckoutOrder(
            {
              orderReference: asString(args.orderReference, "orderReference"),
              orderVersion: asString(args.orderVersion, "orderVersion"),
              description: asString(args.description, "description"),
              grossUnits: asString(args.grossUnits, "grossUnits"),
            },
            asString(args.idempotencyKey, "idempotencyKey"),
          ),
        };
      default:
        return {
          ok: false,
          code: "unknown_tool",
          message: `Unknown tool: ${name}`,
          retryable: false,
        };
    }
  } catch (error) {
    if (error instanceof OpenBalanceError)
      return { ok: false, code: error.code, message: error.message, retryable: error.retryable };
    return {
      ok: false,
      code: "invalid_arguments",
      message: error instanceof Error ? error.message : "Tool call failed",
      retryable: false,
    };
  }
}
