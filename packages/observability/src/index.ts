import { randomUUID } from "node:crypto";
import { metrics, SpanStatusCode, trace } from "@opentelemetry/api";
import { PrometheusExporter } from "@opentelemetry/exporter-prometheus";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from "@opentelemetry/semantic-conventions";
import type { FastifyInstance } from "fastify";

const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export type ReadinessCheck = { name: string; check: () => Promise<void> };

export async function startTelemetry(input: {
  serviceName: string;
  serviceVersion?: string;
  metricsPort?: number;
  otlpTraceUrl?: string;
}) {
  if (!/^[a-z][a-z0-9-]{1,63}$/.test(input.serviceName))
    throw new Error("Invalid telemetry service name");
  const metricReader = new PrometheusExporter({
    port: input.metricsPort ?? 9464,
    endpoint: "/metrics",
  });
  const sdk = new NodeSDK({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: input.serviceName,
      [ATTR_SERVICE_VERSION]: input.serviceVersion ?? "0.0.0",
    }),
    metricReader,
    ...(input.otlpTraceUrl
      ? { traceExporter: new OTLPTraceExporter({ url: input.otlpTraceUrl }) }
      : {}),
  });
  sdk.start();
  return {
    meter: metrics.getMeter(input.serviceName),
    tracer: trace.getTracer(input.serviceName),
    shutdown: () => sdk.shutdown(),
  };
}

export async function attachHttpOperations(
  app: FastifyInstance,
  input: { serviceName: string; readiness?: ReadinessCheck[] },
) {
  const tracer = trace.getTracer(input.serviceName);
  const meter = metrics.getMeter(input.serviceName);
  const requests = meter.createCounter("openbalance_http_requests", { unit: "{request}" });
  const duration = meter.createHistogram("openbalance_http_duration", { unit: "ms" });
  const spans = new WeakMap<
    object,
    { span: ReturnType<typeof tracer.startSpan>; started: number }
  >();

  app.addHook("onRequest", async (request, reply) => {
    const supplied = request.headers["x-request-id"];
    const requestId =
      typeof supplied === "string" && REQUEST_ID.test(supplied) ? supplied : randomUUID();
    reply.header("X-Request-Id", requestId);
    const span = tracer.startSpan(`${request.method} ${request.routeOptions.url ?? "unmatched"}`, {
      attributes: { "http.request.method": request.method, "openbalance.request_id": requestId },
    });
    spans.set(request, { span, started: performance.now() });
  });
  app.addHook("onResponse", async (request, reply) => {
    const active = spans.get(request);
    if (!active) return;
    const attributes = {
      method: request.method,
      route: request.routeOptions.url ?? "unmatched",
      status: reply.statusCode,
    };
    requests.add(1, attributes);
    duration.record(performance.now() - active.started, attributes);
    active.span.setAttribute("http.response.status_code", reply.statusCode);
    if (reply.statusCode >= 500) active.span.setStatus({ code: SpanStatusCode.ERROR });
    active.span.end();
  });
  app.get("/health/live", { config: { rateLimit: false } }, async () => ({
    status: "ok",
    service: input.serviceName,
  }));
  app.get("/health/ready", { config: { rateLimit: false } }, async (_request, reply) => {
    const results = await Promise.allSettled((input.readiness ?? []).map((probe) => probe.check()));
    const checks = results.map((result, index) => ({
      name: input.readiness?.[index]?.name,
      status: result.status === "fulfilled" ? "ok" : "failed",
    }));
    if (results.some((result) => result.status === "rejected"))
      return reply.code(503).send({ status: "not_ready", checks });
    return { status: "ready", checks };
  });
}

export function writeLog(
  service: string,
  level: "info" | "error",
  message: string,
  fields: Record<string, unknown> = {},
) {
  const safe = Object.fromEntries(
    Object.entries(fields).filter(
      ([key]) => !/(authorization|cookie|secret|privateKey|token)/i.test(key),
    ),
  );
  const output = level === "error" ? process.stderr : process.stdout;
  output.write(
    `${JSON.stringify({ timestamp: new Date().toISOString(), level, service, message, ...safe })}\n`,
  );
}

export { configurationView } from "./configuration-view.js";
