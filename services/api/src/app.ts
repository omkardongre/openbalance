import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from "@simplewebauthn/server";
import Fastify from "fastify";
import { z } from "zod";
import { EnrollmentRejected, type EnrollmentService } from "./enrollment.js";

export async function buildApp(enrollment?: EnrollmentService, origin?: string) {
  const app = Fastify({ logger: false, bodyLimit: 32_768 });

  await app.register(cors, {
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
