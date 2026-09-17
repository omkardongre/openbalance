import { createInterface } from "node:readline";
import { OpenBalanceClient } from "@openbalance/sdk";
import { handleRequest, type JsonRpcRequest, type JsonRpcResponse } from "./server.js";

const baseUrl = process.env.OPENBALANCE_API_URL;
if (!baseUrl) {
  process.stderr.write("OPENBALANCE_API_URL is required\n");
  process.exitCode = 64;
} else {
  const client = new OpenBalanceClient({
    baseUrl,
    ...(process.env.OPENBALANCE_SESSION_TOKEN
      ? { sessionToken: process.env.OPENBALANCE_SESSION_TOKEN }
      : {}),
  });
  const lines = createInterface({ input: process.stdin });
  lines.on("line", async (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let response: JsonRpcResponse | null;
    try {
      response = await handleRequest(client, JSON.parse(trimmed) as JsonRpcRequest);
    } catch (error) {
      response = {
        jsonrpc: "2.0" as const,
        id: null,
        error: { code: -32700, message: error instanceof Error ? error.message : "Parse error" },
      };
    }
    if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
  });
}
