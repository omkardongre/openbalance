import rateLimit from "@fastify/rate-limit";
import { attachHttpOperations } from "@openbalance/observability";
import Fastify from "fastify";
import type { Hex } from "viem";
import { z } from "zod";
import {
  InvalidReceipt,
  ReceiptConflict,
  type VenueRelayJournal,
  type VoucherReceipt,
} from "./journal.js";
import {
  authenticateTerminalReceipt,
  TerminalAuthenticationFailed,
  type TerminalDirectory,
} from "./transport.js";

const hex32 = z.string().regex(/^0x[0-9a-fA-F]{64}$/);
const hexBytes = z.string().regex(/^0x(?:[0-9a-fA-F]{2})+$/);
const receiptSchema = z
  .object({
    receiptId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/),
    terminalId: hex32,
    channelId: hex32,
    sequence: z.number().int().min(1).max(0xffff_ffff),
    paymentId: hex32,
    voucher: hexBytes,
    attendeeSignature: hexBytes,
    terminalSignature: hexBytes,
  })
  .strict();
const ingressSchema = z
  .object({
    receipt: receiptSchema,
    authorization: z
      .object({
        keyVersion: z.string().regex(/^[1-9][0-9]*$/),
        sentAt: z.number().int().nonnegative(),
        nonce: hex32,
        signature: z.string().regex(/^0x[0-9a-fA-F]{130}$/),
      })
      .strict(),
  })
  .strict();

export type VenueRelayAppOptions = {
  journal: VenueRelayJournal;
  directory: TerminalDirectory;
  audience: string;
  maximumClockSkewSeconds?: number;
  now?: () => number;
  readiness?: () => Promise<void>;
  /** PEM certificate chain and key; when set the relay serves HTTPS itself. */
  tls?: { cert: Buffer; key: Buffer };
};

export async function buildVenueRelayApp(options: VenueRelayAppOptions) {
  const app = Fastify({
    logger: false,
    bodyLimit: 128 * 1_024,
    ...(options.tls ? { https: { ...options.tls, minVersion: "TLSv1.2" as const } } : {}),
  } as { logger: false; bodyLimit: number });
  await app.register(rateLimit, { max: 120, timeWindow: "1 minute" });
  await attachHttpOperations(app, {
    serviceName: "openbalance-venue-relay",
    readiness: options.readiness ? [{ name: "journal", check: options.readiness }] : [],
  });
  app.addHook("onRequest", async (_request, reply) => {
    reply.header("Cache-Control", "no-store");
    reply.header("X-Content-Type-Options", "nosniff");
  });
  app.post("/v1/vouchers", async (request, reply) => {
    const parsed = ingressSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_voucher_request" });
    const nowMilliseconds = (options.now ?? Date.now)();
    try {
      const receipt = parsed.data.receipt as VoucherReceipt;
      const authentication = await authenticateTerminalReceipt({
        receipt,
        authorization: {
          keyVersion: BigInt(parsed.data.authorization.keyVersion),
          sentAt: parsed.data.authorization.sentAt,
          nonce: parsed.data.authorization.nonce as Hex,
          signature: parsed.data.authorization.signature as Hex,
        },
        audience: options.audience,
        directory: options.directory,
        nowSeconds: Math.floor(nowMilliseconds / 1_000),
        maximumClockSkewSeconds: options.maximumClockSkewSeconds ?? 120,
      });
      const result = options.journal.ingestAuthenticated(
        receipt,
        {
          nonce: parsed.data.authorization.nonce,
          payloadHash: authentication.payloadHash,
          authenticatedAt: nowMilliseconds,
        },
        nowMilliseconds,
      );
      return reply.code(result.created ? 201 : 200).send({
        receiptId: result.record.receiptId,
        state: result.record.state,
        transactionHash: result.record.transactionHash,
        duplicate: !result.created,
      });
    } catch (error) {
      if (error instanceof TerminalAuthenticationFailed)
        return reply.code(401).send({ error: "terminal_authentication_failed" });
      if (error instanceof ReceiptConflict)
        return reply.code(409).send({ error: "voucher_conflict" });
      if (error instanceof InvalidReceipt)
        return reply.code(400).send({ error: "invalid_voucher_request" });
      throw error;
    }
  });
  app.get("/health", { config: { rateLimit: false } }, async () => ({
    service: "openbalance-venue-relay",
    status: "ok",
  }));
  return app;
}
