locals {
  prefix = "openbalance-${var.environment}"
  services = {
    api         = { image = var.api_image, port = 3001, account = "api" }
    relayer     = { image = var.relayer_image, port = 3002, account = "relayer" }
    web         = { image = var.web_image, port = 3000, account = "web" }
    venue-relay = { image = var.venue_relay_image, port = 3003, account = "venue-relay" }
  }
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
  workers = toset(["indexer", "integrations", "financial-worker", "venue-relay-settlement"])

  # Secret material (manifests, signing keys) is consumed as mounted files rather than environment
  # values, because the services already take file paths and because an environment value is visible
  # to anything that can read the process table or a crash dump. `database-url` is the exception: it
  # is a connection string the runtime reads from the environment, so it is bound to an explicit
  # version rather than a floating one, since environment values resolve once at instance start.
  secrets = toset([
    "database-url", "account-manifest", "event-manifest", "checkout-capability",
    "integration-mapping", "relayer-signer", "venue-relay-key",
    "venue-relay-settlement-signer", "terminal-snapshot",
  ])

  # Which identity may read which secret. Declared per process rather than per service, so a worker
  # that shares a package with a request service does not inherit that service's credentials.
  secret_requirements = {
    api                    = ["database-url", "account-manifest", "checkout-capability"]
    relayer                = ["database-url", "event-manifest", "relayer-signer"]
    web                    = []
    venue-relay            = ["venue-relay-key", "terminal-snapshot"]
    indexer                = ["database-url", "event-manifest"]
    integrations           = ["database-url", "integration-mapping"]
    financial-worker       = ["database-url", "event-manifest", "relayer-signer"]
    venue-relay-settlement = ["event-manifest", "venue-relay-settlement-signer"]
  }

  secret_grants = merge([
    for identity, required in local.secret_requirements : {
      for secret in required : "${identity}:${secret}" => { identity = identity, secret = secret }
    }
  ]...)
  apis = toset([
    "artifactregistry.googleapis.com", "compute.googleapis.com", "iam.googleapis.com",
    "run.googleapis.com", "secretmanager.googleapis.com", "storage.googleapis.com"
  ])
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

# Least privilege is per secret, not per project: an identity that can read every runtime secret
# makes one compromised service equivalent to compromising the signing keys of all of them. Each
# grant below is one (identity, secret) pair drawn from the declared requirements.
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
  deletion_protection = true
  ingress             = "INGRESS_TRAFFIC_ALL"
  template {
    service_account = google_service_account.runtime[each.value.account].email
    scaling {
      min_instance_count = var.environment == "production" ? 1 : 0
      max_instance_count = 10
    }
    vpc_access {
      network_interfaces {
        network    = google_compute_network.application.id
        subnetwork = google_compute_subnetwork.application.id
      }
      egress = "PRIVATE_RANGES_ONLY"
    }
    containers {
      image = each.value.image
      ports { container_port = each.value.port }
      env {
        name  = "NODE_ENV"
        value = "production"
      }
      resources {
        limits   = { cpu = "1", memory = "1Gi" }
        cpu_idle = true
      }
      startup_probe {
        tcp_socket { port = each.value.port }
        failure_threshold = 12
        period_seconds    = 5
      }
    }
  }
  depends_on = [google_project_service.required]
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
  name_prefix  = "${local.prefix}-workers-"
  machine_type = var.worker_machine_type
  disk {
    source_image = "projects/cos-cloud/global/images/family/cos-stable"
    auto_delete  = true
    boot         = true
  }
  network_interface { subnetwork = google_compute_subnetwork.application.id }
  service_account {
    email  = google_service_account.runtime[each.key].email
    scopes = ["cloud-platform"]
  }
  metadata = {
    enable-oslogin         = "TRUE"
    block-project-ssh-keys = "TRUE"
    gce-container-declaration = yamlencode({
      spec = {
        containers = [{
          name  = each.key
          image = var.worker_images[each.key]
          env = [
            { name = "NODE_ENV", value = "production" },
            { name = "OPENBALANCE_PROCESS", value = each.key },
          ]
        }]
        restartPolicy = "Always"
      }
    })
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
    max_surge_fixed              = 1
    max_unavailable_fixed        = 0
    replacement_method           = "SUBSTITUTE"
    instance_redistribution_type = "PROACTIVE"
  }
}
