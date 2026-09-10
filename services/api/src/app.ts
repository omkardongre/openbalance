import cors from "@fastify/cors";
import Fastify from "fastify";

export async function buildApp() {
  const app = Fastify({ logger: false });

  await app.register(cors, {
    methods: ["GET"],
    origin: false,
  });

  app.get("/health", async () => ({ service: "openbalance-api", status: "ok" }));

  return app;
}
