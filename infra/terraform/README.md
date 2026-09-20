# Deployment infrastructure

This Terraform root creates the network, Artifact Registry, private evidence bucket, empty
runtime-secret containers (including `database-url`), separate service identities,
request-serving Cloud Run services, and separate shielded regional worker groups. It does not
create secret versions, deploy contracts, expose internal APIs, or start worker containers.

The database is managed Neon Postgres (see `.env.testnet.example`), not a Terraform-managed Cloud
SQL instance, so every environment has exactly one database rather than one per deployment layer.
Populate the `database-url` secret with the environment's Neon connection string.

Before applying, supply immutable image digests, select a distinct GCP project for the environment,
and configure a remote encrypted Terraform state backend. Populate secrets through the deployment
operator after creation; do not pass secret values as Terraform variables. Grant each identity only
its documented secret, signing, and storage access after the exact runtime requirements are known.

Each worker group has no public IP, uses its own service identity, and intentionally has no startup
command. Install its long-running container through an approved instance-management path after
granting that identity only the required resources. The API and relayer are publicly routable
because browser clients call them; their application authentication, origin policy, and rate limits
remain mandatory. Do not run indexer, integration, or financial polling loops as request-only Cloud
Run services. `terraform plan` is safe for review; applying it creates billable cloud resources and
is outside local verification.
