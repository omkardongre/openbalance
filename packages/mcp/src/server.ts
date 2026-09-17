import type { OpenBalanceClient } from "@openbalance/sdk";
import { callTool, toolDefinitions } from "./tools.js";

export const PROTOCOL_VERSION = "2025-06-18";
export const SERVER_INFO = { name: "openbalance", version: "0.1.0" };

export type JsonRpcRequest = {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
};

export type JsonRpcResponse = {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string };
};

/** Minimal MCP JSON-RPC handler over stdio transport, exposing the OpenBalance tools. */
export async function handleRequest(
  client: OpenBalanceClient,
  request: JsonRpcRequest,
): Promise<JsonRpcResponse | null> {
  const id = request.id ?? null;
  if (request.method === "initialize")
    return {
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      },
    };
  if (request.method === "notifications/initialized" || request.method.startsWith("notifications/"))
    return null;
  if (request.method === "ping") return { jsonrpc: "2.0", id, result: {} };
  if (request.method === "tools/list")
    return { jsonrpc: "2.0", id, result: { tools: toolDefinitions } };
  if (request.method === "tools/call") {
    const name = request.params?.name;
    const args = (request.params?.arguments ?? {}) as Record<string, unknown>;
    if (typeof name !== "string")
      return { jsonrpc: "2.0", id, error: { code: -32602, message: "Invalid tool name" } };
    const result = await callTool(client, name, args);
    return {
      jsonrpc: "2.0",
      id,
      result: {
        isError: !result.ok,
        content: [
          {
            type: "text",
            text: JSON.stringify(
              result.ok
                ? result.value
                : { error: result.code, message: result.message, retryable: result.retryable },
            ),
          },
        ],
      },
    };
  }
  return {
    jsonrpc: "2.0",
    id,
    error: { code: -32601, message: `Method not found: ${request.method}` },
  };
}
