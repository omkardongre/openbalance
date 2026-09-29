# Deployment infrastructure

This Terraform root owns the network (deny-all ingress), Artifact Registry, private evidence bucket,
runtime-secret containers and their per-secret grants, one service identity per process, the
request-serving Cloud Run services, and one shielded regional worker group per background process.
`lb.tf` adds the web app's custom domain: a global external Application Load Balancer, serverless
NEG, and a DNS-authorized Certificate Manager certificate (see the root README for the two-step
domain rollout). It never holds secret values: `scripts/populate-secrets.mjs` writes those, so nothing secret lands in
plan output or state.

The database is managed Neon Postgres (see `.env.testnet.example`), not a Terraform-managed Cloud
SQL instance. Its connection string lives in the `database-url` secret.

Workers run on Container-Optimized OS. Their startup script (`worker-startup.sh.tftpl`) fetches that
process's secrets under the instance identity at boot and runs the digest-pinned image. They carry an
ephemeral external address for egress to public endpoints; the firewall admits no inbound traffic.

A digest of the committed deployment manifests is stamped on every Cloud Run revision and worker
template, so publishing new manifests and applying rolls every process that reads them.

```bash
export GOOGLE_OAUTH_ACCESS_TOKEN=$(gcloud auth print-access-token --account=<owner account>)
terraform plan -var-file=testnet.tfvars -out=change.tfplan   # review every change
terraform apply change.tfplan
```

State is local (`terraform.tfstate`, gitignored). Always apply a reviewed saved plan; a plan that
shows changes nobody intended means the running services drifted and must be reconciled first.
