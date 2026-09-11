import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from "@simplewebauthn/server";
import Fastify from "fastify";
import { z } from "zod";
import { AccountAccessRejected, type AccountAccessService } from "./account-access.js";
import { DeploymentMismatch } from "./deployment-chain.js";
import type { DeploymentService } from "./deployments.js";
import { EnrollmentRejected, type EnrollmentService } from "./enrollment.js";

export async function buildApp(
  enrollment?: EnrollmentService,
  origin?: string,
  deployment?: DeploymentService,
  access?: AccountAccessService,
) {
  const app = Fastify({ logger: false, bodyLimit: 32_768 });

  await app.register(cors, {
    allowedHeaders: ["Content-Type", "Authorization", "Idempotency-Key"],
    methods: ["GET", "POST"],
    origin: origin ?? false,
  });
  await app.register(rateLimit, { max: 20, timeWindow: "1 minute" });

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

  app.get("/health", { config: { rateLimit: false } }, async () => ({
    service: "openbalance-api",
    status: "ok",
  }));

  return app;
}
