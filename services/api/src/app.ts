import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import { attachHttpOperations, type ReadinessCheck } from "@openbalance/observability";
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from "@simplewebauthn/server";
import Fastify, { type FastifyReply } from "fastify";
import { z } from "zod";
import { AccountAccessRejected, type AccountAccessService } from "./account-access.js";
import {
  CheckoutConflict,
  CheckoutNotFound,
  CheckoutRejected,
  type CheckoutService,
} from "./checkout.js";
import { DeploymentMismatch } from "./deployment-chain.js";
import type { DeploymentService } from "./deployments.js";
import { EnrollmentRejected, type EnrollmentService } from "./enrollment.js";
import {
  IncidentConflict,
  IncidentNotFound,
  IncidentRejected,
  type IncidentService,
} from "./incidents.js";
import { type OperationalReadService, ProjectionNotFound } from "./operations.js";
import {
  OperationsAccessRejected,
  type OperationsAccessService,
  OperationsScopeRejected,
} from "./operations-access.js";
import type { OperationsReportingService } from "./operations-reporting.js";
import {
  OrganizerConfigurationConflict,
  OrganizerConfigurationNotFound,
  OrganizerConfigurationRejected,
  type OrganizerConfigurationService,
} from "./organizer-configuration.js";
import { OrganizerConfigurationMismatch } from "./organizer-configuration-chain.js";

export type OperationsControl = {
  access: OperationsAccessService;
  reporting: OperationsReportingService;
  incidents: IncidentService;
  checkout?: CheckoutService;
  organizerConfiguration?: OrganizerConfigurationService;
};

export async function buildApp(
  enrollment?: EnrollmentService,
  origin?: string,
  deployment?: DeploymentService,
  access?: AccountAccessService,
  operations?: OperationalReadService,
  control?: OperationsControl,
  readiness: ReadinessCheck[] = [],
) {
  const app = Fastify({ logger: false, bodyLimit: 32_768 });

  await app.register(cors, {
    allowedHeaders: ["Content-Type", "Authorization", "Idempotency-Key"],
    methods: ["GET", "POST"],
    origin: origin ?? false,
  });
  await app.register(rateLimit, { max: 20, timeWindow: "1 minute" });
  await attachHttpOperations(app, { serviceName: "openbalance-api", readiness });

  if (enrollment && origin) {
    const bodySchema = z.object({
      token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
      response: z
        .object({
          id: z.string().max(2048),
          rawId: z.string().max(2048),
          type: z.literal("public-key"),
          clientExtensionResults: z.record(z.string(), z.unknown()),
          response: z.union([
            z
              .object({
                clientDataJSON: z.string().max(4096),
                attestationObject: z.string().max(24000),
              })
              .passthrough(),
            z
              .object({
                clientDataJSON: z.string().max(4096),
                authenticatorData: z.string().max(2048),
                signature: z.string().max(2048),
                userHandle: z.string().nullable().optional(),
              })
              .passthrough(),
          ]),
        })
        .passthrough(),
    });
    app.addHook("onRequest", async (request, reply) => {
      if (request.method === "POST") {
        reply.header("Cache-Control", "no-store");
        if (request.headers.origin !== origin)
          return reply.code(403).send({ error: "origin_denied" });
      }
    });
    app.post("/v1/accounts/enrollment-challenges", async () => enrollment.begin());
    if (access) {
      app.post("/v1/accounts/authentication-challenges", async (request, reply) => {
        const parsed = z
          .object({ account: z.string().regex(/^0x[0-9a-fA-F]{40}$/) })
          .strict()
          .safeParse(request.body);
        if (!parsed.success)
          return reply.code(400).send({ error: "invalid_authentication_request" });
        try {
          return await access.begin(parsed.data.account);
        } catch (error) {
          if (error instanceof AccountAccessRejected)
            return reply.code(403).send({ error: "authentication_rejected" });
          throw error;
        }
      });
      app.post("/v1/accounts/authentications", async (request, reply) => {
        const parsed = z
          .object({
            challengeToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
            response: bodySchema.shape.response,
          })
          .strict()
          .safeParse(request.body);
        if (!parsed.success)
          return reply.code(400).send({ error: "invalid_authentication_request" });
        try {
          return await access.verify(
            parsed.data.challengeToken,
            parsed.data.response as AuthenticationResponseJSON,
          );
        } catch (error) {
          if (error instanceof AccountAccessRejected)
            return reply.code(403).send({ error: "authentication_rejected" });
          throw error;
        }
      });
      app.get("/v1/accounts/me", async (request, reply) => {
        reply.header("Cache-Control", "no-store");
        try {
          return await access.me(request.headers.authorization);
        } catch (error) {
          if (error instanceof AccountAccessRejected)
            return reply.code(401).send({ error: "session_invalid" });
          throw error;
        }
      });
      app.post("/v1/accounts/sessions/revoke", async (request, reply) => {
        try {
          return await access.revoke(request.headers.authorization);
        } catch (error) {
          if (error instanceof AccountAccessRejected)
            return reply.code(401).send({ error: "session_invalid" });
          throw error;
        }
      });

      if (operations) {
        const identifierSchema = z.object({
          id: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
        });
        const projectionError = (reply: FastifyReply, error: unknown) => {
          if (error instanceof AccountAccessRejected)
            return reply.code(401).send({ error: "session_invalid", retryable: false });
          if (error instanceof ProjectionNotFound)
            return reply.code(404).send({
              error: "projection_not_found",
              action: "Check the identifier and finalized status before retrying.",
              retryable: false,
            });
          throw error;
        };

        app.get("/v1/payment-intents/:id", async (request, reply) => {
          reply.header("Cache-Control", "private, no-store");
          const parsed = identifierSchema.safeParse(request.params);
          if (!parsed.success)
            return reply.code(400).send({ error: "invalid_payment_id", retryable: false });
          try {
            const identity = await access.authenticate(request.headers.authorization);
            return await operations.payment(identity.account, parsed.data.id as `0x${string}`);
          } catch (error) {
            return projectionError(reply, error);
          }
        });

        app.get("/v1/reserve-channels/:id", async (request, reply) => {
          reply.header("Cache-Control", "private, no-store");
          const parsed = identifierSchema.safeParse(request.params);
          if (!parsed.success)
            return reply.code(400).send({ error: "invalid_channel_id", retryable: false });
          try {
            const identity = await access.authenticate(request.headers.authorization);
            return await operations.channel(identity.account, parsed.data.id as `0x${string}`);
          } catch (error) {
            return projectionError(reply, error);
          }
        });

        app.get("/v1/accounts/me/activity", async (request, reply) => {
          reply.header("Cache-Control", "private, no-store");
          const parsed = z
            .object({
              limit: z.coerce.number().int().min(1).max(100).default(25),
              beforeBlock: z.coerce.bigint().nonnegative().optional(),
              beforeTransitionId: z.string().min(1).max(256).optional(),
            })
            .strict()
            .superRefine((value, context) => {
              if (
                Boolean(value.beforeBlock === undefined) !==
                Boolean(value.beforeTransitionId === undefined)
              )
                context.addIssue({ code: "custom", message: "Both cursor fields are required" });
            })
            .safeParse(request.query);
          if (!parsed.success)
            return reply.code(400).send({ error: "invalid_activity_query", retryable: false });
          try {
            const identity = await access.authenticate(request.headers.authorization);
            const cursor =
              parsed.data.beforeBlock === undefined || !parsed.data.beforeTransitionId
                ? undefined
                : {
                    blockNumber: parsed.data.beforeBlock,
                    transitionId: parsed.data.beforeTransitionId,
                  };
            return await operations.activity(identity.account, parsed.data.limit, cursor);
          } catch (error) {
            return projectionError(reply, error);
          }
        });
      }
    }
    if (deployment) {
      for (const operation of ["prepare", "confirm"] as const) {
        app.post(`/v1/accounts/deployments/${operation}`, async (request, reply) => {
          const parsed = z
            .object({ token: z.string().regex(/^[A-Za-z0-9_-]{43}$/) })
            .strict()
            .safeParse(request.body);
          if (!parsed.success) return reply.code(400).send({ error: "invalid_deployment_request" });
          try {
            return await deployment.process(parsed.data.token, operation === "confirm");
          } catch (error) {
            if (error instanceof EnrollmentRejected)
              return reply.code(403).send({ error: "enrollment_required" });
            if (error instanceof DeploymentMismatch)
              return reply.code(409).send({ error: "deployment_mismatch" });
            // RPC errors can embed credential-bearing URLs; keep details out of HTTP responses.
            return reply.code(503).send({ error: "deployment_unavailable" });
          }
        });
      }
    }
    for (const kind of ["register", "prove"] as const) {
      app.post(`/v1/accounts/enrollments/${kind}`, async (request, reply) => {
        const parsed = bodySchema.safeParse(request.body);
        if (!parsed.success) return reply.code(400).send({ error: "invalid_enrollment" });
        try {
          return await enrollment.verify(
            parsed.data.token,
            kind,
            parsed.data.response as RegistrationResponseJSON | AuthenticationResponseJSON,
          );
        } catch (error) {
          if (error instanceof EnrollmentRejected || error instanceof SyntaxError)
            return reply.code(400).send({ error: "enrollment_rejected" });
          throw error;
        }
      });
    }
  }

  if (control) {
    const bytes32 = z.string().regex(/^0x[0-9a-fA-F]{64}$/);
    const operationsError = (reply: FastifyReply, error: unknown) => {
      if (error instanceof OperationsAccessRejected)
        return reply.code(401).send({ error: "operations_session_invalid", retryable: false });
      if (error instanceof OperationsScopeRejected)
        return reply.code(403).send({ error: "operations_scope_denied", retryable: false });
      if (error instanceof CheckoutRejected)
        return reply.code(403).send({ error: "checkout_scope_denied", retryable: false });
      if (error instanceof ProjectionNotFound || error instanceof IncidentNotFound)
        return reply.code(404).send({ error: "operational_record_not_found", retryable: false });
      if (error instanceof IncidentConflict)
        return reply.code(409).send({ error: "idempotency_conflict", retryable: false });
      if (error instanceof OrganizerConfigurationConflict)
        return reply.code(409).send({ error: "configuration_conflict", retryable: false });
      if (error instanceof OrganizerConfigurationMismatch)
        return reply.code(409).send({ error: "configuration_state_mismatch", retryable: false });
      if (error instanceof OrganizerConfigurationNotFound)
        return reply
          .code(404)
          .send({ error: "configuration_operation_not_found", retryable: false });
      if (
        error instanceof IncidentRejected ||
        error instanceof OrganizerConfigurationRejected ||
        error instanceof RangeError
      )
        return reply.code(422).send({ error: "operational_request_rejected", retryable: false });
      throw error;
    };

    if (control.organizerConfiguration) {
      const organizerConfiguration = control.organizerConfiguration;
      const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
      const positive = z.coerce.bigint().positive();
      const timestamp = z.coerce
        .bigint()
        .nonnegative()
        .lt(1n << 48n);
      const command = z.discriminatedUnion("kind", [
        z
          .object({
            kind: z.literal("CONFIG"),
            version: positive,
            validAfter: timestamp,
            validUntil: timestamp,
            organizerFeeBps: z.number().int().min(0).max(10_000),
            platformFeeBps: z.number().int().min(0).max(10_000),
            maximumAcceptanceDuration: positive.lt(1n << 48n),
            maximumSubmissionDelay: positive.lt(1n << 48n),
            organizerDestination: address,
            platformDestination: address,
            termsHash: bytes32,
            enabled: z.boolean(),
          })
          .strict(),
        z.object({ kind: z.literal("VENDOR"), vendorId: bytes32, authority: address }).strict(),
        z
          .object({
            kind: z.literal("DESTINATION"),
            vendorId: bytes32,
            version: positive,
            destination: address,
            deadline: positive,
            vendorSignature: z.string().regex(/^0x[0-9a-fA-F]{130}$/),
          })
          .strict(),
        z
          .object({
            kind: z.literal("TERMINAL"),
            terminalId: bytes32,
            version: positive,
            vendorId: bytes32,
            signer: address,
            validAfter: timestamp,
            validUntil: timestamp,
          })
          .strict(),
      ]);
      const operationParams = z
        .object({ eventId: bytes32, operationId: z.string().uuid() })
        .strict();

      app.post("/v1/events/:eventId/configuration-operations", async (request, reply) => {
        const params = z.object({ eventId: bytes32 }).strict().safeParse(request.params);
        const body = command.safeParse(request.body);
        const idempotencyKey = request.headers["idempotency-key"];
        if (!params.success || !body.success || typeof idempotencyKey !== "string")
          return reply.code(400).send({ error: "invalid_configuration_request", retryable: false });
        try {
          const identity = await control.access.authenticate(request.headers.authorization);
          control.access.assertRole(identity, ["ORGANIZER"]);
          control.access.assertEvent(identity, params.data.eventId as `0x${string}`);
          const result = await organizerConfiguration.prepare(
            identity,
            params.data.eventId as `0x${string}`,
            body.data as Parameters<OrganizerConfigurationService["prepare"]>[2],
            idempotencyKey,
          );
          return reply.code(result.created ? 201 : 200).send(result);
        } catch (error) {
          return operationsError(reply, error);
        }
      });

      app.post(
        "/v1/events/:eventId/configuration-operations/:operationId/confirmations",
        async (request, reply) => {
          const params = operationParams.safeParse(request.params);
          const body = z.object({ transactionHash: bytes32 }).strict().safeParse(request.body);
          if (!params.success || !body.success)
            return reply.code(400).send({
              error: "invalid_configuration_confirmation",
              retryable: false,
            });
          try {
            const identity = await control.access.authenticate(request.headers.authorization);
            control.access.assertRole(identity, ["ORGANIZER"]);
            control.access.assertEvent(identity, params.data.eventId as `0x${string}`);
            const result = await organizerConfiguration.confirm(
              identity,
              params.data.eventId as `0x${string}`,
              params.data.operationId,
              body.data.transactionHash.toLowerCase() as `0x${string}`,
            );
            return reply.code("confirmation" in result ? 202 : 200).send(result);
          } catch (error) {
            return operationsError(reply, error);
          }
        },
      );

      app.get(
        "/v1/events/:eventId/configuration-operations/:operationId",
        async (request, reply) => {
          reply.header("Cache-Control", "private, no-store");
          const params = operationParams.safeParse(request.params);
          if (!params.success)
            return reply.code(404).send({
              error: "configuration_operation_not_found",
              retryable: false,
            });
          try {
            const identity = await control.access.authenticate(request.headers.authorization);
            control.access.assertRole(identity, ["ORGANIZER"]);
            control.access.assertEvent(identity, params.data.eventId as `0x${string}`);
            return await organizerConfiguration.get(
              identity,
              params.data.eventId as `0x${string}`,
              params.data.operationId,
            );
          } catch (error) {
            return operationsError(reply, error);
          }
        },
      );
    }

    if (control.checkout) {
      const checkout = control.checkout;
      const orderId = z.object({ id: z.string().uuid() }).strict();
      app.post("/v1/checkout-orders", async (request, reply) => {
        const parsed = z
          .object({
            orderReference: z.string().min(1).max(160),
            orderVersion: z.coerce.bigint().positive(),
            description: z.string().min(1).max(160),
            grossUnits: z.coerce.bigint().positive(),
          })
          .strict()
          .safeParse(request.body);
        const idempotencyKey = request.headers["idempotency-key"];
        if (!parsed.success || typeof idempotencyKey !== "string")
          return reply.code(400).send({ error: "invalid_checkout_request", retryable: false });
        try {
          const identity = await control.access.authenticate(request.headers.authorization);
          control.access.assertRole(identity, ["VENDOR"]);
          const result = await checkout.create(identity, { ...parsed.data, idempotencyKey });
          return reply.code(result.created ? 201 : 200).send(result);
        } catch (error) {
          if (error instanceof CheckoutConflict)
            return reply.code(409).send({ error: "checkout_conflict", retryable: false });
          if (error instanceof CheckoutRejected)
            return reply.code(422).send({ error: "checkout_rejected", retryable: false });
          return operationsError(reply, error);
        }
      });

      app.get("/v1/checkout-orders/:id/cashier", async (request, reply) => {
        reply.header("Cache-Control", "private, no-store");
        const params = orderId.safeParse(request.params);
        if (!params.success)
          return reply.code(404).send({ error: "checkout_not_found", retryable: false });
        try {
          const identity = await control.access.authenticate(request.headers.authorization);
          control.access.assertRole(identity, ["VENDOR"]);
          return await checkout.cashier(identity, params.data.id);
        } catch (error) {
          if (error instanceof CheckoutNotFound)
            return reply.code(404).send({ error: "checkout_not_found", retryable: false });
          return operationsError(reply, error);
        }
      });

      if (access) {
        app.post("/v1/checkout-orders/:id/bindings", async (request, reply) => {
          const params = orderId.safeParse(request.params);
          const body = z
            .object({ checkoutCapability: z.string().regex(/^[A-Za-z0-9_-]{43}$/) })
            .strict()
            .safeParse(request.body);
          if (!params.success || !body.success)
            return reply.code(400).send({ error: "invalid_checkout_binding", retryable: false });
          try {
            const identity = await access.authenticate(request.headers.authorization);
            return reply
              .code(202)
              .send(await checkout.bind(identity, params.data.id, body.data.checkoutCapability));
          } catch (error) {
            if (error instanceof AccountAccessRejected)
              return reply.code(401).send({ error: "session_invalid", retryable: false });
            if (error instanceof CheckoutNotFound)
              return reply.code(404).send({ error: "checkout_not_found", retryable: false });
            if (error instanceof CheckoutConflict)
              return reply.code(409).send({ error: "checkout_binding_conflict", retryable: false });
            if (error instanceof CheckoutRejected)
              return reply.code(422).send({ error: "checkout_binding_rejected", retryable: false });
            throw error;
          }
        });
      }

      app.post("/v1/checkout-orders/:id/terminal-signature", async (request, reply) => {
        const params = orderId.safeParse(request.params);
        const body = z
          .object({ terminalSignature: z.string().regex(/^0x[0-9a-fA-F]{130}$/) })
          .strict()
          .safeParse(request.body);
        if (!params.success || !body.success)
          return reply.code(400).send({ error: "invalid_terminal_signature", retryable: false });
        try {
          const identity = await control.access.authenticate(request.headers.authorization);
          control.access.assertRole(identity, ["VENDOR"]);
          return await checkout.attachSignature(
            identity,
            params.data.id,
            body.data.terminalSignature as `0x${string}`,
          );
        } catch (error) {
          if (error instanceof CheckoutNotFound)
            return reply.code(404).send({ error: "checkout_not_found", retryable: false });
          if (error instanceof CheckoutConflict)
            return reply.code(409).send({ error: "checkout_conflict", retryable: false });
          if (error instanceof CheckoutRejected)
            return reply.code(422).send({ error: "terminal_signature_rejected", retryable: false });
          return operationsError(reply, error);
        }
      });

      app.get("/v1/checkout-orders/:id", async (request, reply) => {
        reply.header("Cache-Control", "private, no-store");
        const params = orderId.safeParse(request.params);
        if (!params.success)
          return reply.code(404).send({ error: "checkout_not_found", retryable: false });
        try {
          return await checkout.resolve(params.data.id, request.headers.authorization);
        } catch (error) {
          if (error instanceof CheckoutNotFound)
            return reply.code(404).send({ error: "checkout_not_found", retryable: false });
          throw error;
        }
      });
    }

    app.get("/v1/operations/me", async (request, reply) => {
      reply.header("Cache-Control", "private, no-store");
      try {
        const identity = await control.access.authenticate(request.headers.authorization);
        return {
          role: identity.role,
          eventId: identity.eventId,
          vendorId: identity.vendorId,
          checkoutPolicy:
            control.checkout && identity.role === "VENDOR"
              ? control.checkout.policy(identity)
              : null,
          organizerPolicy:
            control.organizerConfiguration && identity.role === "ORGANIZER"
              ? control.organizerConfiguration.policy(identity)
              : null,
        };
      } catch (error) {
        return operationsError(reply, error);
      }
    });

    app.get("/v1/events/:eventId/statements", async (request, reply) => {
      reply.header("Cache-Control", "private, no-store");
      const parsed = z.object({ eventId: bytes32 }).strict().safeParse(request.params);
      const query = z
        .object({
          vendorId: bytes32,
          fromBlock: z.coerce.bigint().nonnegative().optional(),
          toBlock: z.coerce.bigint().nonnegative().optional(),
          limit: z.coerce.number().int().min(1).max(100).default(50),
          afterBlock: z.coerce.bigint().nonnegative().optional(),
          afterPaymentId: bytes32.optional(),
        })
        .strict()
        .superRefine((value, context) => {
          if (
            Boolean(value.afterBlock === undefined) !== Boolean(value.afterPaymentId === undefined)
          )
            context.addIssue({
              code: "custom",
              message: "Both statement cursor fields are required",
            });
        })
        .safeParse(request.query);
      if (!parsed.success || !query.success)
        return reply.code(400).send({ error: "invalid_statement_request", retryable: false });
      try {
        const identity = await control.access.authenticate(request.headers.authorization);
        const eventId = parsed.data.eventId as `0x${string}`;
        const vendorId = query.data.vendorId as `0x${string}`;
        control.access.assertRole(identity, ["VENDOR", "ORGANIZER", "FINANCE"]);
        control.access.assertEvent(identity, eventId);
        control.access.assertVendor(identity, vendorId);
        const range: {
          fromBlock?: bigint;
          toBlock?: bigint;
          limit: number;
          afterBlock?: bigint;
          afterPaymentId?: `0x${string}`;
        } = { limit: query.data.limit };
        if (query.data.fromBlock !== undefined) range.fromBlock = query.data.fromBlock;
        if (query.data.toBlock !== undefined) range.toBlock = query.data.toBlock;
        if (query.data.afterBlock !== undefined) range.afterBlock = query.data.afterBlock;
        if (query.data.afterPaymentId !== undefined)
          range.afterPaymentId = query.data.afterPaymentId as `0x${string}`;
        return await control.reporting.statement(identity, vendorId, range);
      } catch (error) {
        return operationsError(reply, error);
      }
    });

    app.get("/v1/events/:eventId/reconciliation", async (request, reply) => {
      reply.header("Cache-Control", "private, no-store");
      const parsed = z.object({ eventId: bytes32 }).strict().safeParse(request.params);
      if (!parsed.success)
        return reply.code(400).send({ error: "invalid_reconciliation_request", retryable: false });
      try {
        const identity = await control.access.authenticate(request.headers.authorization);
        control.access.assertRole(identity, ["ORGANIZER", "FINANCE"]);
        control.access.assertEvent(identity, parsed.data.eventId as `0x${string}`);
        return await control.reporting.reconciliation(identity);
      } catch (error) {
        return operationsError(reply, error);
      }
    });

    app.post("/v1/incidents", async (request, reply) => {
      const parsed = z
        .object({
          eventId: bytes32,
          affectedVendorId: bytes32.nullable().default(null),
          affectedTerminalId: bytes32.nullable().default(null),
          severity: z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]),
          summary: z.string().min(5).max(500),
          mitigation: z.string().min(1).max(2_000),
          nextAction: z.string().min(1).max(1_000),
          evidenceRefs: z.array(z.string().min(1).max(500)).max(20).default([]),
          owner: z.string().min(3).max(128),
        })
        .strict()
        .safeParse(request.body);
      const idempotencyKey = request.headers["idempotency-key"];
      if (!parsed.success || typeof idempotencyKey !== "string")
        return reply.code(400).send({ error: "invalid_incident_request", retryable: false });
      try {
        const identity = await control.access.authenticate(request.headers.authorization);
        control.access.assertEvent(identity, parsed.data.eventId as `0x${string}`);
        const {
          eventId: _eventId,
          affectedVendorId,
          affectedTerminalId,
          ...incidentInput
        } = parsed.data;
        const incident = await control.incidents.open(identity, {
          ...incidentInput,
          affectedVendorId: affectedVendorId as `0x${string}` | null,
          affectedTerminalId: affectedTerminalId as `0x${string}` | null,
          idempotencyKey,
        });
        return reply.code(202).send(incident);
      } catch (error) {
        return operationsError(reply, error);
      }
    });

    app.get("/v1/events/:eventId/incidents", async (request, reply) => {
      reply.header("Cache-Control", "private, no-store");
      const params = z.object({ eventId: bytes32 }).strict().safeParse(request.params);
      const query = z
        .object({
          status: z.enum(["OPEN", "RESOLVED"]).default("OPEN"),
          limit: z.coerce.number().int().min(1).max(100).default(25),
        })
        .strict()
        .safeParse(request.query);
      if (!params.success || !query.success)
        return reply.code(400).send({ error: "invalid_incident_query", retryable: false });
      try {
        const identity = await control.access.authenticate(request.headers.authorization);
        control.access.assertEvent(identity, params.data.eventId as `0x${string}`);
        return await control.incidents.list(identity, query.data.status, query.data.limit);
      } catch (error) {
        return operationsError(reply, error);
      }
    });

    app.post("/v1/incidents/:incidentId/resolutions", async (request, reply) => {
      const params = z.object({ incidentId: z.string().uuid() }).strict().safeParse(request.params);
      const body = z
        .object({ resolutionProof: z.string().min(1).max(2_000) })
        .strict()
        .safeParse(request.body);
      const idempotencyKey = request.headers["idempotency-key"];
      if (!params.success || !body.success || typeof idempotencyKey !== "string")
        return reply.code(400).send({ error: "invalid_resolution_request", retryable: false });
      try {
        const identity = await control.access.authenticate(request.headers.authorization);
        return await control.incidents.resolve(identity, params.data.incidentId, {
          ...body.data,
          idempotencyKey,
        });
      } catch (error) {
        return operationsError(reply, error);
      }
    });
  }

  app.get("/health", { config: { rateLimit: false } }, async () => ({
    service: "openbalance-api",
    status: "ok",
  }));

  return app;
}
