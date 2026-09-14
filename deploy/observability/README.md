# Local observability

Every request service exposes liveness/readiness endpoints and publishes OpenTelemetry metrics on
its dedicated loopback port. Long-running workers publish financial, indexing, reconciliation, and
integration counters. Set `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` to export spans; traces remain local
no-ops when it is absent.

Create `secrets/grafana-admin-password` with a development-only password, then run:

```sh
docker compose -f deploy/observability/compose.yaml up -d
```

Prometheus and Grafana bind only to loopback. The dashboard is an operational starting point; alert
thresholds require measured baselines. Never place production credentials in this directory.
