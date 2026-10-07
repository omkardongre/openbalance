variable "project_id" { type = string }

# Needed in advance because Cloud Run's deterministic hostname embeds it, and the API and relayer must
# be told the web origin before the web service exists (see `local.process_url`).
variable "project_number" { type = string }

variable "region" {
  type    = string
  default = "us-central1"
}
variable "environment" {
  type = string
  validation {
    condition     = contains(["testnet", "production"], var.environment)
    error_message = "Environment must be testnet or production."
  }
}

variable "enabled_processes" {
  type        = list(string)
  description = "Processes an apply creates. Anything absent is neither granted secrets nor deployed."
  validation {
    condition = alltrue([for name in var.enabled_processes : contains([
      "api", "relayer", "web", "venue-relay",
      "indexer", "integrations", "financial-worker", "venue-relay-settlement",
    ], name)])
    error_message = "Unknown process in enabled_processes."
  }
}

# Public chain facts. The services re-derive code hashes from these at startup and refuse to serve on
# drift, so a stale value fails closed.
variable "chain" {
  type = object({
    id               = number
    name             = string
    event_id         = string
    router           = string
    ledger           = string
    vault            = string
    asset            = string
    asset_decimals   = number
    deployment_block = string
  })
}

# Envio HyperSync endpoint for the chain; the indexer reads finalized logs from it.
variable "hypersync_url" {
  type    = string
  default = "https://monad-testnet.hypersync.xyz"
  validation {
    condition     = can(regex("^https://[a-z0-9-]+\\.hypersync\\.xyz$", var.hypersync_url))
    error_message = "hypersync_url must be an https://<chain>.hypersync.xyz origin."
  }
}

# Commitment level every chain reader waits for before treating a read as settled.
variable "finality_tag" {
  type    = string
  default = "finalized"
  validation {
    condition     = contains(["finalized", "safe"], var.finality_tag)
    error_message = "finality_tag must be finalized or safe."
  }
}

# The public origin passkeys are bound to. Empty means the web service's deterministic run.app host.
# Changing it invalidates every enrolled passkey, since WebAuthn pins a credential to its RP ID.
variable "web_public_url" {
  type    = string
  default = ""
  validation {
    condition     = var.web_public_url == "" || startswith(var.web_public_url, "https://")
    error_message = "web_public_url must be empty or an https:// origin."
  }
}

# Hostname the load balancer serves the web app on (lb.tf). Empty creates no load balancer.
variable "web_domain" {
  type    = string
  default = ""
  validation {
    condition     = var.web_domain == "" || can(regex("^([a-z0-9]([a-z0-9-]*[a-z0-9])?\\.)+[a-z]{2,}$", var.web_domain))
    error_message = "web_domain must be a bare lowercase hostname, without scheme or path."
  }
}

# Base units of the settlement asset (6 decimals for USDC). One grant covers the full test journey
# (a 1 USDC purchase plus a 2 USDC reserve); the per-account cap allows one retry, and stops one
# freshly enrolled identity after another from draining the pool meant for everyone else.
variable "faucet" {
  type = object({ max_amount = string, daily_limit = string, account_limit = string })
  default = {
    max_amount    = "5000000"
    daily_limit   = "100000000"
    account_limit = "10000000"
  }
}

variable "sponsorship" {
  type = object({
    daily_deployments   = number
    max_deployment_gas  = string
    max_fee_per_gas_wei = string
    max_cost_wei        = string
  })
  default = {
    daily_deployments   = 200
    max_deployment_gas  = "2000000"
    max_fee_per_gas_wei = "150000000000"
    max_cost_wei        = "300000000000000000"
  }
}

variable "financial_limits" {
  type = object({
    max_gas             = string
    max_fee_per_gas_wei = string
    max_cost_wei        = string
  })
  default = {
    max_gas             = "1500000"
    max_fee_per_gas_wei = "150000000000"
    max_cost_wei        = "225000000000000000"
  }
}

variable "request_service_deletion_protection" {
  type    = bool
  default = true
}

# Workers reach only public endpoints (Neon, RPC, Secret Manager, Artifact Registry). An ephemeral
# external address with a deny-all ingress firewall costs less than a Cloud NAT gateway and exposes
# nothing inbound.
variable "worker_external_address" {
  type    = bool
  default = true
}

variable "api_image" { type = string }
variable "relayer_image" { type = string }
variable "web_image" { type = string }
variable "venue_relay_image" { type = string }
variable "worker_images" {
  type        = map(string)
  description = "Container image per background worker (indexer, integrations, financial-worker, venue-relay-settlement)."
}
variable "worker_machine_type" {
  type    = string
  default = "e2-small"
}
