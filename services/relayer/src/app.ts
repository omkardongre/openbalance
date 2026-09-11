import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import { DeploymentMismatch } from "@openbalance/api/deployment-chain";
import { EnrollmentRejected } from "@openbalance/api/enrollment";
import {
  type DeploymentSponsorshipService,
  SponsorshipConflict,
  SponsorshipQuotaExceeded,
  SponsorshipUnavailable,
} from "@openbalance/api/sponsorship";
import Fastify from "fastify";
import { z } from "zod";

export async function buildRelayerApp(sponsorship: DeploymentSponsorshipService, origin: string) {
  const app = Fastify({ logger: false, bodyLimit: 4_096 });
  await app.register(cors, {
    allowedHeaders: ["Content-Type", "Idempotency-Key"],
    methods: ["GET", "POST"],
    origin,
  });
  await app.register(rateLimit, { max: 10, timeWindow: "1 minute" });
  app.addHook("onRequest", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    if (request.method === "POST" && request.headers.origin !== origin)
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
  app.get("/health", { config: { rateLimit: false } }, async () => ({
    service: "openbalance-relayer",
    status: "ok",
  }));
  return app;
}
