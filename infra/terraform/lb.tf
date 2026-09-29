# Public entry point for the web app on its own domain.
#
# WebAuthn binds every passkey to the RP ID, so the web origin must be a stable domain we control rather
# than a platform hostname. Cloud Run's own domain mapping is a preview feature with known latency
# issues, so the domain is served by a global external Application Load Balancer with a serverless NEG.
#
# The certificate is Google-managed through Certificate Manager with DNS authorization. That lets it be
# issued before the domain's A record points here, and keeps it independent of the load balancer's
# lifecycle, so recreating the proxy never re-triggers issuance.
#
# Rollout is two applies: set `web_domain` first, publish the two DNS records from the outputs, wait for
# the certificate to become ACTIVE, then set `web_public_url` to the same origin and rebuild the web
# image. Switching the origin before the domain serves would leave passkeys bound to a host that fails.

locals {
  web_domain_enabled = var.web_domain != ""
  # The run.app host stays reachable until the origin actually moves, because until then it is the
  # only working origin. Afterwards only the load balancer may reach the web service.
  web_behind_load_balancer = local.web_domain_enabled && var.web_public_url == "https://${var.web_domain}"
}

resource "google_compute_global_address" "web" {
  count      = local.web_domain_enabled ? 1 : 0
  name       = "${local.prefix}-web"
  depends_on = [google_project_service.required]
}

resource "google_certificate_manager_dns_authorization" "web" {
  count      = local.web_domain_enabled ? 1 : 0
  name       = "${local.prefix}-web"
  domain     = var.web_domain
  depends_on = [google_project_service.required]
}

resource "google_certificate_manager_certificate" "web" {
  count = local.web_domain_enabled ? 1 : 0
  name  = "${local.prefix}-web"
  managed {
    domains            = [var.web_domain]
    dns_authorizations = [google_certificate_manager_dns_authorization.web[0].id]
  }
}

resource "google_certificate_manager_certificate_map" "web" {
  count      = local.web_domain_enabled ? 1 : 0
  name       = "${local.prefix}-web"
  depends_on = [google_project_service.required]
}

resource "google_certificate_manager_certificate_map_entry" "web" {
  count        = local.web_domain_enabled ? 1 : 0
  name         = "${local.prefix}-web"
  map          = google_certificate_manager_certificate_map.web[0].name
  hostname     = var.web_domain
  certificates = [google_certificate_manager_certificate.web[0].id]
}

resource "google_compute_region_network_endpoint_group" "web" {
  count                 = local.web_domain_enabled ? 1 : 0
  name                  = "${local.prefix}-web"
  region                = var.region
  network_endpoint_type = "SERVERLESS"
  cloud_run { service = google_cloud_run_v2_service.request["web"].name }
}

resource "google_compute_backend_service" "web" {
  count                 = local.web_domain_enabled ? 1 : 0
  name                  = "${local.prefix}-web"
  load_balancing_scheme = "EXTERNAL_MANAGED"
  protocol              = "HTTPS"
  backend { group = google_compute_region_network_endpoint_group.web[0].id }
  log_config {
    enable      = true
    sample_rate = 1
  }
}

# Only the configured host is served. A request for any other Host, including the bare IP, is
# redirected to the canonical origin, so the app is never presented under an origin its passkeys are
# not bound to.
resource "google_compute_url_map" "web" {
  count = local.web_domain_enabled ? 1 : 0
  name  = "${local.prefix}-web"
  default_url_redirect {
    host_redirect          = var.web_domain
    https_redirect         = true
    redirect_response_code = "PERMANENT_REDIRECT"
    strip_query            = true
  }
  host_rule {
    hosts        = [var.web_domain]
    path_matcher = "web"
  }
  path_matcher {
    name            = "web"
    default_service = google_compute_backend_service.web[0].id
  }
}

resource "google_compute_target_https_proxy" "web" {
  count           = local.web_domain_enabled ? 1 : 0
  name            = "${local.prefix}-web"
  url_map         = google_compute_url_map.web[0].id
  certificate_map = "//certificatemanager.googleapis.com/${google_certificate_manager_certificate_map.web[0].id}"
}

resource "google_compute_global_forwarding_rule" "web_https" {
  count                 = local.web_domain_enabled ? 1 : 0
  name                  = "${local.prefix}-web-https"
  load_balancing_scheme = "EXTERNAL_MANAGED"
  ip_address            = google_compute_global_address.web[0].id
  port_range            = "443"
  target                = google_compute_target_https_proxy.web[0].id
}

# Plain HTTP exists only to redirect. Passkeys require a secure context, so nothing is served over it.
resource "google_compute_url_map" "web_redirect" {
  count = local.web_domain_enabled ? 1 : 0
  name  = "${local.prefix}-web-redirect"
  default_url_redirect {
    https_redirect         = true
    redirect_response_code = "MOVED_PERMANENTLY_DEFAULT"
    strip_query            = false
  }
}

resource "google_compute_target_http_proxy" "web_redirect" {
  count   = local.web_domain_enabled ? 1 : 0
  name    = "${local.prefix}-web-redirect"
  url_map = google_compute_url_map.web_redirect[0].id
}

resource "google_compute_global_forwarding_rule" "web_http" {
  count                 = local.web_domain_enabled ? 1 : 0
  name                  = "${local.prefix}-web-http"
  load_balancing_scheme = "EXTERNAL_MANAGED"
  ip_address            = google_compute_global_address.web[0].id
  port_range            = "80"
  target                = google_compute_target_http_proxy.web_redirect[0].id
}
