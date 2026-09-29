locals {
  prefix = "openbalance-${var.environment}"

  # Cloud Run's deterministic hostname. Computing it rather than reading it back from the created
  # service breaks a genuine ordering problem: the API and relayer must be told the web origin at
  # startup because WebAuthn binds every credential to one exact origin, but the web image cannot be
  # built until those two services have URLs. One of the three has to be known in advance.
  request_processes = toset(["api", "relayer", "web", "venue-relay"])
  process_url = {
    for name in local.request_processes :
    name => "https://${local.prefix}-${name}-${var.project_number}.${var.region}.run.app"
  }
  web_origin = var.web_public_url != "" ? var.web_public_url : local.process_url["web"]
  web_rp_id  = replace(replace(local.web_origin, "https://", ""), "http://", "")

  all_services = {
    api         = { image = var.api_image, port = 3001, account = "api" }
    relayer     = { image = var.relayer_image, port = 3002, account = "relayer" }
    web         = { image = var.web_image, port = 3000, account = "web" }
    venue-relay = { image = var.venue_relay_image, port = 3003, account = "venue-relay" }
  }
  all_workers = toset(["indexer", "integrations", "financial-worker", "venue-relay-settlement"])

  services = { for name, service in local.all_services : name => service if contains(var.enabled_processes, name) }
  workers  = toset([for name in local.all_workers : name if contains(var.enabled_processes, name)])

  # Service account IDs are capped at 30 characters, which is shorter than several process names once
  # prefixed with the environment. Truncating is not a safe way to fit: `financial-worker` truncates
  # to a trailing hyphen, which is rejected outright, and `venue-relay-settlement` truncates to the
  # same ID as `venue-relay`, which would silently hand two processes one identity and defeat the
  # per-secret split below. Each ID is therefore declared explicitly.
  service_accounts = {
    api                    = "api"
    relayer                = "relayer"
    web                    = "web"
    indexer                = "indexer"
    integrations           = "integrations"
    financial-worker       = "fin-worker"
    evidence               = "evidence"
    venue-relay            = "relay"
    venue-relay-settlement = "relay-settle"
  }

  # Key material and manifests are consumed as mounted files rather than environment values, because
  # the services already take file paths and because an environment value is visible to anything that
  # can read the process table or a crash dump.
  #
  # Two values are unavoidably environment-delivered because the runtime reads them that way: the
  # database connection string, and the operational RPC URL. The RPC URL is a credential, not
  # configuration, since the provider embeds an API key in the path, so it is stored as a secret and
  # never written into a variables file.
  secrets = toset([
    "database-url", "operational-rpc-url", "account-manifest", "event-manifest",
    "sponsor-signer", "financial-signer", "faucet-signer",
    "checkout-manifest", "checkout-capability", "integration-mapping", "time-authority",
    "venue-relay-key", "venue-relay-settlement-signer", "terminal-snapshot",
  ])

  secret_directory = "/run/secrets"

  # Cloud Run presents a secret volume as a directory whose file is named by the item path, so the
  # readable file is `<dir>/<name>/<name>`. The worker startup script writes the same layout, so one
  # path holds on both runtimes.
  secret_path = { for secret in local.secrets : secret => "${local.secret_directory}/${secret}/${secret}" }

  # Digest of the committed manifests that `scripts/populate-secrets.mjs` publishes to Secret
  # Manager. Every process reads its manifest once
  # at startup, so this value is stamped on each Cloud Run revision and worker template to force a
  # rollout whenever a manifest changes. Populate the secrets before applying.
  manifest_digest = substr(sha256(join("", [
    for file in ["account-manifest.json", "financial-manifest.json", "checkout-manifest.json"] :
    filesha256("${path.module}/../../deployments/${var.environment}/${file}")
  ])), 0, 16)

  # Which identity may read which secret. Declared per process rather than per service, so a worker
  # that shares a package with a request service does not inherit that service's credentials.
  #
  # The account-deployment sponsor key and the money-path signing key are deliberately separate
  # secrets holding separate keys. Both processes reserve nonces for their own signing address
  # independently, so one shared address would let the relayer and the financial worker issue
  # colliding nonces and lose transactions with no error at the point of broadcast.
  secret_requirements = {
    # Both checkout secrets must hold a version before this applies: a mounted secret with no version
    # fails the revision outright. `scripts/populate-secrets.mjs` publishes the manifest; the capability
    # key is created once by `pnpm testnet:provision-checkout` and uploaded by the operator.
    # `time-authority` signs terminal time samples; its public half is pinned into terminal builds.
    api                    = ["database-url", "operational-rpc-url", "account-manifest", "faucet-signer", "checkout-manifest", "checkout-capability", "time-authority"]
    relayer                = ["database-url", "operational-rpc-url", "account-manifest", "event-manifest", "sponsor-signer"]
    web                    = []
    venue-relay            = ["venue-relay-key", "terminal-snapshot"]
    indexer                = ["database-url", "operational-rpc-url"]
    integrations           = ["database-url", "integration-mapping"]
    financial-worker       = ["database-url", "operational-rpc-url", "event-manifest", "financial-signer"]
    venue-relay-settlement = ["operational-rpc-url", "event-manifest", "venue-relay-key", "venue-relay-settlement-signer"]
  }

  # Secrets delivered as files, per process: the requirements above minus the two the runtime insists
  # on reading from the environment.
  environment_secrets = toset(["database-url", "operational-rpc-url"])
  secret_files = {
    for identity, required in local.secret_requirements :
    identity => [for secret in required : secret if !contains(local.environment_secrets, secret)]
  }

  # Environment-delivered secrets, per process. The RPC URL is bound to more than one variable on the
  # API because the deployment chain and the faucet each read their own.
  secret_environment = {
    api = {
      DATABASE_URL    = "database-url"
      ACCOUNT_RPC_URL = "operational-rpc-url"
      FAUCET_RPC_URL  = "operational-rpc-url"
    }
    relayer = {
      DATABASE_URL    = "database-url"
      ACCOUNT_RPC_URL = "operational-rpc-url"
    }
    web         = {}
    venue-relay = {}
    indexer = {
      INDEXER_DATABASE_URL = "database-url"
      INDEXER_RPC_URL      = "operational-rpc-url"
    }
    integrations = {
      INTEGRATION_DATABASE_URL = "database-url"
      INDEXER_DATABASE_URL     = "database-url"
      API_DATABASE_URL         = "database-url"
    }
    financial-worker = {
      DATABASE_URL      = "database-url"
      FINANCIAL_RPC_URL = "operational-rpc-url"
    }
    venue-relay-settlement = {
      VENUE_RELAY_RPC_URL = "operational-rpc-url"
    }
  }

  # Plain configuration, per process.
  #
  # `HOST` matters: every request service defaults to loopback, which a managed runtime's health check
  # cannot reach, so the revision would be reported unhealthy while the process itself looked fine.
  #
  # The relayer and venue-relay validate their own namespaces strictly, so an unrecognised variable
  # inside their prefixes is a hard startup failure. That is deliberate — within a service's own
  # namespace an unknown name is a typo, and a misspelled limit is silently not applied, leaving the
  # real limit at its default. It does mean cross-process leakage is a real risk here: setting
  # `FINANCIAL_RPC_URL` on the relayer, or any `VENUE_RELAY_SETTLEMENT_*` on the venue-relay request
  # service, would stop them booting. The split below is drawn to respect that.
  process_environment = {
    api = {
      HOST                     = "0.0.0.0"
      METRICS_PORT             = "9464"
      ACCOUNT_MANIFEST_PATH    = local.secret_path["account-manifest"]
      ACCOUNT_FINALITY_TAG     = var.finality_tag
      PROJECTION_READS_ENABLED = "true"
      WEBAUTHN_RP_ID           = local.web_rp_id
      WEBAUTHN_ORIGIN          = local.web_origin
      FAUCET_CHAIN_ID          = tostring(var.chain.id)
      FAUCET_CHAIN_NAME        = var.chain.name
      FAUCET_TOKEN_ADDRESS     = var.chain.asset
      FAUCET_TOKEN_DECIMALS    = tostring(var.chain.asset_decimals)
      FAUCET_PRIVATE_KEY_PATH  = local.secret_path["faucet-signer"]
      FAUCET_MAX_AMOUNT        = var.faucet.max_amount
      FAUCET_DAILY_LIMIT       = var.faucet.daily_limit
      FAUCET_ACCOUNT_LIMIT     = var.faucet.account_limit
      # The API constructs its checkout service only when both are set.
      CHECKOUT_MANIFEST_PATH       = local.secret_path["checkout-manifest"]
      CHECKOUT_CAPABILITY_KEY_PATH = local.secret_path["checkout-capability"]
      TIME_AUTHORITY_KEY_PATH      = local.secret_path["time-authority"]
    }
    relayer = {
      HOST                                   = "0.0.0.0"
      METRICS_PORT                           = "9465"
      ACCOUNT_MANIFEST_PATH                  = local.secret_path["account-manifest"]
      ACCOUNT_FINALITY_TAG                   = var.finality_tag
      WEBAUTHN_RP_ID                         = local.web_rp_id
      WEBAUTHN_ORIGIN                        = local.web_origin
      SPONSOR_PRIVATE_KEY_PATH               = local.secret_path["sponsor-signer"]
      SPONSOR_DAILY_DEPLOYMENTS              = tostring(var.sponsorship.daily_deployments)
      SPONSOR_MAX_DEPLOYMENT_GAS             = var.sponsorship.max_deployment_gas
      SPONSOR_MAX_FEE_PER_GAS_WEI            = var.sponsorship.max_fee_per_gas_wei
      SPONSOR_MAX_COST_WEI                   = var.sponsorship.max_cost_wei
      FINANCIAL_EVENT_MANIFEST_PATH          = local.secret_path["event-manifest"]
      FINANCIAL_COMMAND_MAX_LIFETIME_SECONDS = "3600"
    }
    # Next.js reads HOSTNAME rather than HOST. Its NEXT_PUBLIC_* values are compiled into browser
    # bundles at build time, so they are build inputs and do not appear here.
    web = {
      HOSTNAME = "0.0.0.0"
    }
    venue-relay = {
      HOST                      = "0.0.0.0"
      METRICS_PORT              = "9466"
      VENUE_RELAY_DATABASE_PATH = "/var/lib/openbalance/venue-relay.sqlite"
      VENUE_RELAY_KEY_PATH      = local.secret_path["venue-relay-key"]
      TERMINAL_SNAPSHOT_PATH    = local.secret_path["terminal-snapshot"]
      TERMINAL_INGRESS_AUDIENCE = "${local.process_url["venue-relay"]}/v1/vouchers"
    }
    indexer = {
      METRICS_PORT             = "9467"
      INDEXER_CHAIN_ID         = tostring(var.chain.id)
      INDEXER_CHAIN_NAME       = var.chain.name
      INDEXER_EVENT_ID         = var.chain.event_id
      INDEXER_ROUTER_ADDRESS   = var.chain.router
      INDEXER_LEDGER_ADDRESS   = var.chain.ledger
      INDEXER_VAULT_ADDRESS    = var.chain.vault
      INDEXER_DEPLOYMENT_BLOCK = var.chain.deployment_block
      INDEXER_ENVIRONMENT      = var.environment
      INDEXER_FINALITY_TAG     = var.finality_tag
    }
    integrations = {
      METRICS_PORT             = "9468"
      INTEGRATION_MAPPING_PATH = local.secret_path["integration-mapping"]
    }
    financial-worker = {
      METRICS_PORT                      = "9469"
      FINANCIAL_EVENT_MANIFEST_PATH     = local.secret_path["event-manifest"]
      FINANCIAL_CHAIN_NAME              = var.chain.name
      FINANCIAL_SIGNER_PRIVATE_KEY_PATH = local.secret_path["financial-signer"]
      FINANCIAL_WORKER_ID               = "financial-worker:${var.environment}"
      FINANCIAL_MAX_GAS                 = var.financial_limits.max_gas
      FINANCIAL_MAX_FEE_PER_GAS_WEI     = var.financial_limits.max_fee_per_gas_wei
      FINANCIAL_MAX_COST_WEI            = var.financial_limits.max_cost_wei
      FINANCIAL_FINALITY_TAG            = var.finality_tag
      # A lease must outlast the slowest pre-signing attempt. Policy checks and simulation are RPC
      # reads, and a provider timeout with client retries runs past the 30 s default, so the lease
      # lapsed mid-attempt and every payment on testnet cost a wasted attempt before settling.
      FINANCIAL_LEASE_MS = "120000"
    }
    # Deliberately not 9467: that is the indexer's, and these two would collide if co-located.
    venue-relay-settlement = {
      METRICS_PORT                            = "9470"
      VENUE_RELAY_DATABASE_PATH               = "/var/lib/openbalance/venue-relay.sqlite"
      VENUE_RELAY_KEY_PATH                    = local.secret_path["venue-relay-key"]
      VENUE_RELAY_CHAIN_ID                    = tostring(var.chain.id)
      VENUE_RELAY_CHAIN_NAME                  = var.chain.name
      VENUE_RELAY_VAULT_ADDRESS               = var.chain.vault
      VENUE_RELAY_DEPLOYMENT_BLOCK            = var.chain.deployment_block
      VENUE_RELAY_SETTLEMENT_PRIVATE_KEY_PATH = local.secret_path["venue-relay-settlement-signer"]
      VENUE_RELAY_SETTLEMENT_WORKER_ID        = "venue-relay-settlement:${var.environment}"
      VENUE_RELAY_FINALITY_TAG                = var.finality_tag
    }
  }

  secret_grants = merge([
    for identity, required in local.secret_requirements : {
      for secret in required : "${identity}:${secret}" => { identity = identity, secret = secret }
    }
  ]...)

  apis = toset([
    "artifactregistry.googleapis.com", "certificatemanager.googleapis.com", "compute.googleapis.com", "iam.googleapis.com",
    "logging.googleapis.com", "monitoring.googleapis.com", "run.googleapis.com",
    "secretmanager.googleapis.com", "storage.googleapis.com"
  ])

  # Workers poll continuously, so a request-scaled runtime would either lose its CPU between polls or
  # have to be pinned to a minimum instance at a higher price than an equivalent instance.
  #
  # Container-Optimized OS has no Secret Manager integration, and declarative container metadata
  # cannot carry a value fetched at boot, so secrets are retrieved by a startup script and handed to
  # the container as a root-owned environment file plus a mounted directory of key material. Nothing
  # secret is written into Terraform state or instance metadata, which a declarative container
  # environment could not have avoided.
  worker_startup_script = {
    for name in local.all_workers : name => templatefile("${path.module}/worker-startup.sh.tftpl", {
      container_label  = name
      image            = var.worker_images[name]
      registry         = "${var.region}-docker.pkg.dev"
      project_id       = var.project_id
      secret_names     = { for variable_name, secret in local.secret_environment[name] : variable_name => "${local.prefix}-${secret}" }
      secret_files     = { for secret in local.secret_files[name] : secret => "${local.prefix}-${secret}" }
      environment      = merge({ NODE_ENV = "production" }, local.process_environment[name])
      secret_directory = local.secret_directory
    })
  }
}

resource "google_project_service" "required" {
  for_each           = local.apis
  service            = each.value
  disable_on_destroy = false
}

resource "google_service_account" "runtime" {
  for_each     = local.service_accounts
  account_id   = "ob-${var.environment}-${each.value}"
  display_name = "${local.prefix} ${each.key}"
  depends_on   = [google_project_service.required]

  # Fail at plan time rather than partway through an apply if a future environment name pushes an ID
  # past the limit, since a rejected identity leaves whatever depends on it half-created.
  lifecycle {
    precondition {
      condition     = length("ob-${var.environment}-${each.value}") <= 30
      error_message = "Service account ID 'ob-${var.environment}-${each.value}' exceeds 30 characters."
    }
  }
}

resource "google_compute_network" "application" {
  name                    = "${local.prefix}-network"
  auto_create_subnetworks = false
}

resource "google_compute_subnetwork" "application" {
  name          = "${local.prefix}-subnet"
  network       = google_compute_network.application.id
  ip_cidr_range = "10.42.0.0/20"
}

# A custom network carries no ingress allow rule, so instances accept nothing from the internet even
# while holding an external address. The rule is declared explicitly rather than left implicit so the
# intent is reviewable and any later permissive rule is an obvious change rather than a default.
resource "google_compute_firewall" "deny_ingress" {
  name          = "${local.prefix}-deny-ingress"
  network       = google_compute_network.application.name
  direction     = "INGRESS"
  priority      = 65534
  source_ranges = ["0.0.0.0/0"]
  deny { protocol = "all" }
}

resource "google_artifact_registry_repository" "images" {
  location      = var.region
  repository_id = local.prefix
  format        = "DOCKER"
  description   = "Release images. Services are deployed by digest; tags are convenience only."

  # A deployed digest must keep resolving to the bytes that were reviewed, so a tag that has been
  # released can never be moved onto different content.
  docker_config { immutable_tags = true }

  # Untagged versions accumulate on every rebuild of the same tag and are unreachable, but retention
  # is ordered keep-before-delete so a recent release is never collected while a rollback may still
  # need it.
  cleanup_policies {
    id     = "keep-recent-releases"
    action = "KEEP"
    most_recent_versions { keep_count = 10 }
  }
  cleanup_policies {
    id     = "delete-stale-untagged"
    action = "DELETE"
    condition {
      tag_state  = "UNTAGGED"
      older_than = "604800s"
    }
  }

  depends_on = [google_project_service.required]
}

resource "google_storage_bucket" "evidence" {
  name                        = "${var.project_id}-${local.prefix}-evidence"
  location                    = var.region
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  versioning { enabled = true }
  lifecycle_rule {
    condition { age = 365 }
    action { type = "Delete" }
  }
}

resource "google_secret_manager_secret" "runtime" {
  for_each  = local.secrets
  secret_id = "${local.prefix}-${each.value}"
  replication {
    auto {}
  }
  depends_on = [google_project_service.required]
}

# Least privilege is per secret, not per project: an identity that can read every runtime secret makes
# one compromised service equivalent to compromising the signing keys of all of them. Each grant below
# is one (identity, secret) pair drawn from the declared requirements.
resource "google_secret_manager_secret_iam_member" "runtime" {
  for_each  = local.secret_grants
  secret_id = google_secret_manager_secret.runtime[each.value.secret].secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.runtime[each.value.identity].email}"
}

resource "google_cloud_run_v2_service" "request" {
  for_each            = local.services
  name                = "${local.prefix}-${each.key}"
  location            = var.region
  deletion_protection = var.request_service_deletion_protection
  # Once the web origin moves to the load balancer, its run.app host would be a second origin serving
  # the same app with passkeys that cannot work there, so direct traffic is refused.
  ingress = each.key == "web" && local.web_behind_load_balancer ? "INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER" : "INGRESS_TRAFFIC_ALL"
  template {
    service_account = google_service_account.runtime[each.value.account].email
    # Manifests are read once at startup, so a new manifest version reaches a service only through a
    # new revision. Tying a revision label to the manifest content makes a manifest change roll every
    # request service in the same apply, rather than depending on someone remembering to restart it.
    labels = { manifest-digest = local.manifest_digest }
    scaling {
      min_instance_count = var.environment == "production" ? 1 : 0
      max_instance_count = 10
    }
    # Direct VPC egress, so no Serverless VPC Access connector is billed while idle.
    vpc_access {
      network_interfaces {
        network    = google_compute_network.application.id
        subnetwork = google_compute_subnetwork.application.id
      }
      # The database and the RPC provider are public endpoints, so only private-range traffic needs to
      # traverse the network. Routing public egress through it too would require a NAT gateway that
      # nothing here uses.
      egress = "PRIVATE_RANGES_ONLY"
    }

    dynamic "volumes" {
      for_each = toset(local.secret_files[each.key])
      content {
        name = volumes.value
        secret {
          secret = google_secret_manager_secret.runtime[volumes.value].secret_id
          # Cloud Run defaults mounted secrets to 0444. The signing-key loader rejects any file
          # carrying group or other permission bits, so the default would fail every key read. 256 is
          # 0400 expressed as the decimal integer this field takes.
          default_mode = 256
          items {
            version = "latest"
            path    = volumes.value
            mode    = 256
          }
        }
      }
    }

    containers {
      image = each.value.image
      # Cloud Run injects PORT and every request service here honours it.
      ports { container_port = each.value.port }

      env {
        name  = "NODE_ENV"
        value = "production"
      }
      dynamic "env" {
        for_each = local.process_environment[each.key]
        content {
          name  = env.key
          value = env.value
        }
      }
      dynamic "env" {
        for_each = local.secret_environment[each.key]
        content {
          name = env.key
          value_source {
            secret_key_ref {
              secret = google_secret_manager_secret.runtime[env.value].secret_id
              # An environment value resolves once at instance start, so tracking `latest` means a
              # rotated secret is picked up by the next revision rather than never.
              version = "latest"
            }
          }
        }
      }

      dynamic "volume_mounts" {
        for_each = toset(local.secret_files[each.key])
        content {
          name       = volume_mounts.value
          mount_path = "${local.secret_directory}/${volume_mounts.value}"
        }
      }

      resources {
        limits   = { cpu = "1", memory = "1Gi" }
        cpu_idle = true
        # Services verify deployed bytecode and chain state over RPC before listening, which is the
        # slow part of a cold start; extra CPU only while starting shortens it at no idle cost.
        startup_cpu_boost = true
      }
      # A normal start takes 10-20 s, but instance start-up on the platform occasionally stalls well
      # past a minute before the process runs at all. 120 s absorbs that without masking a service
      # that genuinely cannot start, which still fails the revision and keeps the previous one serving.
      startup_probe {
        tcp_socket { port = each.value.port }
        failure_threshold = 24
        period_seconds    = 5
      }
    }
  }
  depends_on = [google_project_service.required]

  # A placeholder image would create a service that can never serve a request, so refuse at plan time
  # rather than leave a permanently failing revision behind.
  lifecycle {
    precondition {
      condition     = each.value.image != "PENDING"
      error_message = "Image for '${each.key}' is still PENDING. Publish it before enabling this process."
    }
  }
}

resource "google_cloud_run_v2_service_iam_member" "public_request" {
  for_each = local.services
  project  = google_cloud_run_v2_service.request[each.key].project
  location = google_cloud_run_v2_service.request[each.key].location
  name     = google_cloud_run_v2_service.request[each.key].name
  role     = "roles/run.invoker"
  member   = "allUsers"
}

resource "google_compute_instance_template" "workers" {
  for_each     = local.workers
  name_prefix  = "${local.prefix}-${each.key}-"
  machine_type = var.worker_machine_type
  disk {
    source_image = "projects/cos-cloud/global/images/family/cos-stable"
    auto_delete  = true
    boot         = true
  }
  network_interface {
    subnetwork = google_compute_subnetwork.application.id
    # Workers reach Neon, the RPC provider, Secret Manager and Artifact Registry, all public
    # endpoints. See the variable for why an address is preferred over a NAT gateway here.
    dynamic "access_config" {
      for_each = var.worker_external_address ? [1] : []
      content {}
    }
  }
  service_account {
    email  = google_service_account.runtime[each.key].email
    scopes = ["cloud-platform"]
  }
  metadata = {
    enable-oslogin         = "TRUE"
    block-project-ssh-keys = "TRUE"
    google-logging-enabled = "true"
    startup-script         = local.worker_startup_script[each.key]
    # Secrets are fetched once at boot; a changed digest yields a new template, which the group
    # manager's proactive update policy rolls out.
    manifest-digest = local.manifest_digest
  }
  shielded_instance_config {
    enable_secure_boot          = true
    enable_vtpm                 = true
    enable_integrity_monitoring = true
  }
  lifecycle { create_before_destroy = true }
}

resource "google_compute_region_instance_group_manager" "workers" {
  for_each           = local.workers
  name               = "${local.prefix}-${each.key}"
  base_instance_name = "${local.prefix}-${each.key}"
  region             = var.region
  target_size        = 1
  version { instance_template = google_compute_instance_template.workers[each.key].id }
  update_policy {
    type                         = "PROACTIVE"
    minimal_action               = "REPLACE"
    max_surge_fixed              = 3
    max_unavailable_fixed        = 0
    replacement_method           = "SUBSTITUTE"
    instance_redistribution_type = "PROACTIVE"
  }
}

# Worker VMs pull their own image under their instance identity (Cloud Run's pull is done by the
# platform's service agent instead), so each worker holds read access on this one repository only.
resource "google_artifact_registry_repository_iam_member" "worker_pull" {
  for_each   = local.workers
  project    = var.project_id
  location   = google_artifact_registry_repository.images.location
  repository = google_artifact_registry_repository.images.name
  role       = "roles/artifactregistry.reader"
  member     = "serviceAccount:${google_service_account.runtime[each.key].email}"
}

# The Container-Optimized OS logging and monitoring agents run as the instance identity. Without these,
# a VM that boots but never starts its container still reports RUNNING and the failure is invisible.
resource "google_project_iam_member" "worker_telemetry" {
  for_each = merge([
    for worker in local.workers : {
      for role in ["roles/logging.logWriter", "roles/monitoring.metricWriter"] :
      "${worker}:${role}" => { worker = worker, role = role }
    }
  ]...)
  project = var.project_id
  role    = each.value.role
  member  = "serviceAccount:${google_service_account.runtime[each.value.worker].email}"
}
