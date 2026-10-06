import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import { AccountAccessRejected, type AccountAccessService } from "@openbalance/api/account-access";
import { DeploymentMismatch } from "@openbalance/api/deployment-chain";
import { EnrollmentRejected } from "@openbalance/api/enrollment";
import {
  type DeploymentSponsorshipService,
  SponsorshipConflict,
  SponsorshipQuotaExceeded,
  SponsorshipUnavailable,
} from "@openbalance/api/sponsorship";
import { attachHttpOperations, type ReadinessCheck } from "@openbalance/observability";
import Fastify, { type FastifyReply } from "fastify";
import { z } from "zod";
import {
  AttendeeCommandNotFound,
  AttendeeCommandRejected,
  type AttendeeFinancialCommandService,
} from "./attendee-commands.js";
import { FinancialOperationConflict, FinancialOperationRejected } from "./financial-operations.js";
import {
  MAX_RECLAIMABLE_LISTING,
  ReserveReclaimRejected,
  type ReserveReclaimService,
} from "./reserve-reclaims.js";
import {
  VendorCommandNotFound,
  VendorCommandRejected,
  type VendorFinancialCommandService,
} from "./vendor-commands.js";
import {
  VendorTreasuryAccessRejected,
  type VendorTreasuryAccessService,
} from "./vendor-treasury-access.js";
import { type VendorVoucherSettlementService, VoucherChannelNotFound } from "./vendor-vouchers.js";

const reserveReturnRoute = "/v1/reserve-channels/:id/reclaims";
const bytes32Param = z.string().regex(/^0x[0-9a-fA-F]{64}$/);

function reclaimError(reply: FastifyReply, error: unknown) {
  if (error instanceof ReserveReclaimRejected) {
    const notFound =
      error.code === "channel_not_found" ||
      error.code === "event_not_found" ||
      error.code === "reclaim_not_found";
    return reply.code(notFound ? 404 : 409).send({
      error: error.code,
      action:
        error.code === "reclaim_not_yet_eligible"
          ? "Wait until the disclosed submission deadline."
          : "Refresh the finalized reserve state.",
      retryable: error.code === "reclaim_not_yet_eligible",
    });
  }
  if (error instanceof FinancialOperationConflict)
    return reply.code(409).send({ error: "reclaim_in_progress", retryable: true });
  if (error instanceof FinancialOperationRejected)
    return reply.code(422).send({ error: "reclaim_rejected", retryable: false });
  throw error;
}

export async function buildRelayerApp(
  sponsorship: DeploymentSponsorshipService,
  origin: string,
  financial?: {
    access: AccountAccessService;
    commands: AttendeeFinancialCommandService;
    reclaims?: ReserveReclaimService;
    treasuryAccess?: VendorTreasuryAccessService;
    treasuryCommands?: VendorFinancialCommandService;
    voucherSettlements?: VendorVoucherSettlementService;
  },
  readiness: ReadinessCheck[] = [],
) {
  const app = Fastify({ logger: false, bodyLimit: 300_000 });
  await app.register(cors, {
    allowedHeaders: ["Content-Type", "Authorization", "Idempotency-Key"],
    methods: ["GET", "POST"],
    origin,
  });
  await app.register(rateLimit, { max: 10, timeWindow: "1 minute" });
  await attachHttpOperations(app, { serviceName: "openbalance-relayer", readiness });
  app.addHook("onRequest", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    // The origin check protects requests that carry a session or credential. A reserve return
    // carries neither and always pays the original account, so any caller, browser or not, may
    // submit it.
    if (
      request.method === "POST" &&
      request.headers.origin !== origin &&
      request.routeOptions.url !== reserveReturnRoute
    )
      return reply.code(403).send({ error: "origin_denied" });
  });
  app.post("/v1/accounts/deployments/sponsor", async (request, reply) => {
    const parsed = z
      .object({ token: z.string().regex(/^[A-Za-z0-9_-]{43}$/) })
      .strict()
      .safeParse(request.body);
    const idempotencyKey = request.headers["idempotency-key"];
    if (!parsed.success || typeof idempotencyKey !== "string")
      return reply.code(400).send({ error: "invalid_sponsorship_request" });
    try {
      return await sponsorship.process(parsed.data.token, idempotencyKey);
    } catch (error) {
      if (error instanceof EnrollmentRejected)
        return reply.code(403).send({ error: "enrollment_required" });
      if (error instanceof SponsorshipConflict)
        return reply.code(409).send({ error: "idempotency_conflict" });
      if (error instanceof SponsorshipQuotaExceeded)
        return reply.code(429).send({ error: "sponsorship_quota_exceeded" });
      if (error instanceof SponsorshipUnavailable || error instanceof DeploymentMismatch)
        return reply.code(503).send({ error: "sponsorship_unavailable" });
      throw error;
    }
  });
  if (financial) {
    app.post("/v1/accounts/commands", async (request, reply) => {
      const parsed = z
        .object({
          kind: z.enum(["PAYMENT", "CANCELLATION", "RESERVE_OPEN"]),
          calldata: z
            .string()
            .regex(/^0x(?:[0-9a-fA-F]{2})+$/)
            .max(262_146),
        })
        .strict()
        .safeParse(request.body);
      const idempotencyKey = request.headers["idempotency-key"];
      if (!parsed.success || typeof idempotencyKey !== "string")
        return reply.code(400).send({
          error: "invalid_command_request",
          action: "Submit one supported account command with an idempotency key.",
          retryable: false,
        });
      try {
        const identity = await financial.access.authenticate(request.headers.authorization);
        const result = await financial.commands.accept(identity, {
          ...parsed.data,
          calldata: parsed.data.calldata as `0x${string}`,
          idempotencyKey,
        });
        return reply.code(202).send(result);
      } catch (error) {
        if (error instanceof AccountAccessRejected)
          return reply.code(401).send({
            error: "session_invalid",
            action: "Authenticate the deployed account again.",
            retryable: false,
          });
        if (error instanceof AttendeeCommandRejected || error instanceof FinancialOperationRejected)
          return reply.code(422).send({
            error: "command_rejected",
            action: "Recreate the command from current verified event terms.",
            retryable: false,
          });
        if (error instanceof FinancialOperationConflict)
          return reply.code(409).send({
            error: "idempotency_conflict",
            action: "Use the original payload or a new idempotency key.",
            retryable: false,
          });
        throw error;
      }
    });

    app.get("/v1/financial-operations/:id", async (request, reply) => {
      reply.header("Cache-Control", "private, no-store");
      const parsed = z.object({ id: z.string().uuid() }).strict().safeParse(request.params);
      if (!parsed.success)
        return reply.code(400).send({ error: "invalid_operation_id", retryable: false });
      try {
        const identity = await financial.access.authenticate(request.headers.authorization);
        return await financial.commands.get(identity, parsed.data.id);
      } catch (error) {
        if (error instanceof AccountAccessRejected)
          return reply.code(401).send({ error: "session_invalid", retryable: false });
        if (error instanceof AttendeeCommandNotFound)
          return reply.code(404).send({ error: "operation_not_found", retryable: false });
        throw error;
      }
    });
    const reclaims = financial.reclaims;
    if (reclaims) {
      // No session, credential or idempotency key: the vault pays only the original account, and
      // the service keeps at most one live return per channel however many callers ask.
      app.post(reserveReturnRoute, async (request, reply) => {
        const params = z.object({ id: bytes32Param }).strict().safeParse(request.params);
        const body = z.object({ eventId: bytes32Param }).strict().safeParse(request.body);
        if (!params.success || !body.success)
          return reply.code(400).send({ error: "invalid_reclaim_request", retryable: false });
        try {
          const result = await reclaims.accept({
            eventId: body.data.eventId as `0x${string}`,
            channelId: params.data.id as `0x${string}`,
          });
          return reply.code(result.created ? 202 : 200).send(result);
        } catch (error) {
          return reclaimError(reply, error);
        }
      });

      app.get(reserveReturnRoute, async (request, reply) => {
        const params = z.object({ id: bytes32Param }).strict().safeParse(request.params);
        if (!params.success)
          return reply.code(400).send({ error: "invalid_channel_id", retryable: false });
        try {
          return await reclaims.status(params.data.id as `0x${string}`);
        } catch (error) {
          return reclaimError(reply, error);
        }
      });

      app.get("/v1/events/:eventId/reclaimable-channels", async (request, reply) => {
        const params = z.object({ eventId: bytes32Param }).strict().safeParse(request.params);
        const query = z
          .object({
            limit: z.coerce
              .number()
              .int()
              .min(1)
              .max(MAX_RECLAIMABLE_LISTING)
              .default(MAX_RECLAIMABLE_LISTING),
          })
          .strict()
          .safeParse(request.query);
        if (!params.success || !query.success)
          return reply.code(400).send({ error: "invalid_reclaimable_request", retryable: false });
        try {
          return await reclaims.reclaimable(params.data.eventId as `0x${string}`, query.data.limit);
        } catch (error) {
          return reclaimError(reply, error);
        }
      });
    }
    const treasuryAccess = financial.treasuryAccess;
    const treasuryCommands = financial.treasuryCommands;
    if (treasuryAccess && treasuryCommands) {
      app.post("/v1/payments/:id/refunds", async (request, reply) => {
        const params = z
          .object({ id: z.string().regex(/^0x[0-9a-fA-F]{64}$/) })
          .strict()
          .safeParse(request.params);
        const body = z
          .object({
            calldata: z
              .string()
              .regex(/^0x(?:[0-9a-fA-F]{2})+$/)
              .max(262_146),
          })
          .strict()
          .safeParse(request.body);
        const idempotencyKey = request.headers["idempotency-key"];
        if (!params.success || !body.success || typeof idempotencyKey !== "string")
          return reply.code(400).send({ error: "invalid_refund_request", retryable: false });
        try {
          const identity = await treasuryAccess.authenticate(request.headers.authorization);
          return reply.code(202).send(
            await treasuryCommands.acceptRefund({
              identity,
              paymentId: params.data.id as `0x${string}`,
              calldata: body.data.calldata as `0x${string}`,
              idempotencyKey,
            }),
          );
        } catch (error) {
          return vendorCommandError(reply, error);
        }
      });

      app.post("/v1/vendors/:id/withdrawals", async (request, reply) => {
        const params = z
          .object({ id: z.string().regex(/^0x[0-9a-fA-F]{64}$/) })
          .strict()
          .safeParse(request.params);
        const body = z
          .object({ destinationVersion: z.string().regex(/^[1-9][0-9]*$/) })
          .strict()
          .safeParse(request.body);
        const idempotencyKey = request.headers["idempotency-key"];
        if (!params.success || !body.success || typeof idempotencyKey !== "string")
          return reply.code(400).send({ error: "invalid_withdrawal_request", retryable: false });
        try {
          const identity = await treasuryAccess.authenticate(request.headers.authorization);
          if (identity.vendorId.toLowerCase() !== params.data.id.toLowerCase())
            throw new VendorTreasuryAccessRejected();
          return reply.code(202).send(
            await treasuryCommands.acceptWithdrawal({
              identity,
              destinationVersion: BigInt(body.data.destinationVersion),
              idempotencyKey,
            }),
          );
        } catch (error) {
          return vendorCommandError(reply, error);
        }
      });

      const voucherSettlements = financial.voucherSettlements;
      if (voucherSettlements) {
        app.post("/v1/reserve-channels/:id/vouchers", async (request, reply) => {
          const params = z
            .object({ id: z.string().regex(/^0x[0-9a-fA-F]{64}$/) })
            .strict()
            .safeParse(request.params);
          const body = z
            .object({
              voucher: z
                .string()
                .regex(/^0x(?:[0-9a-fA-F]{2})+$/)
                .max(4_098),
              attendeeSignature: z.string().regex(/^0x[0-9a-fA-F]{130}$/),
              terminalSignature: z.string().regex(/^0x[0-9a-fA-F]{130}$/),
            })
            .strict()
            .safeParse(request.body);
          const idempotencyKey = request.headers["idempotency-key"];
          if (!params.success || !body.success || typeof idempotencyKey !== "string")
            return reply.code(400).send({ error: "invalid_voucher_request", retryable: false });
          try {
            const identity = await treasuryAccess.authenticate(request.headers.authorization);
            return reply.code(202).send(
              await voucherSettlements.accept({
                identity,
                channelId: params.data.id as `0x${string}`,
                voucher: body.data.voucher as `0x${string}`,
                attendeeSignature: body.data.attendeeSignature as `0x${string}`,
                terminalSignature: body.data.terminalSignature as `0x${string}`,
                idempotencyKey,
              }),
            );
          } catch (error) {
            if (error instanceof VoucherChannelNotFound)
              return reply.code(404).send({
                error: "channel_not_found",
                action: "Retry once the channel opening has finalized.",
                retryable: true,
              });
            return vendorCommandError(reply, error);
          }
        });
      }

      app.get("/v1/vendor-financial-operations/:id", async (request, reply) => {
        reply.header("Cache-Control", "private, no-store");
        const parsed = z.object({ id: z.string().uuid() }).strict().safeParse(request.params);
        if (!parsed.success)
          return reply.code(400).send({ error: "invalid_operation_id", retryable: false });
        try {
          const identity = await treasuryAccess.authenticate(request.headers.authorization);
          return await treasuryCommands.get(identity, parsed.data.id);
        } catch (error) {
          return vendorCommandError(reply, error);
        }
      });
    }
  }
  app.get("/health", { config: { rateLimit: false } }, async () => ({
    service: "openbalance-relayer",
    status: "ok",
  }));
  return app;
}

function vendorCommandError(reply: FastifyReply, error: unknown) {
  if (error instanceof VendorTreasuryAccessRejected)
    return reply.code(401).send({ error: "treasury_session_invalid", retryable: false });
  if (error instanceof VendorCommandRejected || error instanceof FinancialOperationRejected)
    return reply.code(422).send({
      error: "treasury_command_rejected",
      action: "Recreate the command from current finalized event and payment terms.",
      retryable: false,
    });
  if (error instanceof FinancialOperationConflict)
    return reply.code(409).send({ error: "idempotency_conflict", retryable: false });
  if (error instanceof VendorCommandNotFound)
    return reply.code(404).send({ error: "operation_not_found", retryable: false });
  throw error;
}
