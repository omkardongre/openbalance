locals {
  prefix = "openbalance-${var.environment}"
  services = {
    api         = { image = var.api_image, port = 3001, account = "api" }
    relayer     = { image = var.relayer_image, port = 3002, account = "relayer" }
    web         = { image = var.web_image, port = 3000, account = "web" }
    venue-relay = { image = var.venue_relay_image, port = 3003, account = "venue-relay" }
  }
  service_accounts = toset([
    "api", "relayer", "web", "indexer", "integrations", "financial-worker", "evidence",
    "venue-relay", "venue-relay-settlement",
  ])
  workers = toset(["indexer", "integrations", "financial-worker", "venue-relay-settlement"])
  apis = toset([
    "artifactregistry.googleapis.com", "compute.googleapis.com", "iam.googleapis.com",
    "run.googleapis.com", "secretmanager.googleapis.com", "servicenetworking.googleapis.com",
    "sqladmin.googleapis.com", "storage.googleapis.com"
  ])
}

resource "google_project_service" "required" {
  for_each           = local.apis
  service            = each.value
  disable_on_destroy = false
}

resource "google_service_account" "runtime" {
  for_each     = local.service_accounts
  account_id   = substr("${local.prefix}-${each.value}", 0, 30)
  display_name = "${local.prefix} ${each.value}"
  depends_on   = [google_project_service.required]
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

resource "google_compute_global_address" "private_services" {
  name          = "${local.prefix}-private-services"
  purpose       = "VPC_PEERING"
  address_type  = "INTERNAL"
  prefix_length = 16
  network       = google_compute_network.application.id
}

resource "google_service_networking_connection" "private_services" {
  network                 = google_compute_network.application.id
  service                 = "servicenetworking.googleapis.com"
  reserved_peering_ranges = [google_compute_global_address.private_services.name]
  depends_on              = [google_project_service.required]
}

resource "google_sql_database_instance" "postgres" {
  name                = "${local.prefix}-postgres"
  database_version    = "POSTGRES_16"
  deletion_protection = true
  settings {
    tier              = var.database_tier
    availability_type = var.environment == "production" ? "REGIONAL" : "ZONAL"
    backup_configuration {
      enabled                        = true
      point_in_time_recovery_enabled = true
      transaction_log_retention_days = 7
    }
    ip_configuration {
      ipv4_enabled                                  = false
      private_network                               = google_compute_network.application.id
      enable_private_path_for_google_cloud_services = true
    }
    database_flags {
      name  = "cloudsql.iam_authentication"
      value = "on"
    }
  }
  depends_on = [google_service_networking_connection.private_services]
}

resource "google_sql_database" "application" {
  name     = "openbalance"
  instance = google_sql_database_instance.postgres.name
}

resource "google_artifact_registry_repository" "images" {
  location      = var.region
  repository_id = local.prefix
  format        = "DOCKER"
  depends_on    = [google_project_service.required]
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
  for_each = toset([
    "account-manifest", "event-manifest", "checkout-capability", "integration-mapping",
    "relayer-signer", "venue-relay-key", "venue-relay-settlement-signer", "terminal-snapshot",
  ])
  secret_id = "${local.prefix}-${each.value}"
  replication {
    auto {}
  }
  depends_on = [google_project_service.required]
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
