output "request_service_uris" { value = { for name, service in google_cloud_run_v2_service.request : name => service.uri } }
output "artifact_registry" { value = google_artifact_registry_repository.images.name }
output "evidence_bucket" { value = google_storage_bucket.evidence.name }
output "runtime_service_accounts" { value = { for name, account in google_service_account.runtime : name => account.email } }
output "worker_groups" { value = { for name, group in google_compute_region_instance_group_manager.workers : name => group.name } }

# The origin the API and relayer were configured to trust. WebAuthn rejects an assertion whose origin
# differs by even a character, so this is worth confirming against the web service's real URI before
# treating an enrollment failure as a code problem.
output "configured_web_origin" { value = local.web_origin }

# The two DNS records the domain's registrar must hold: the A record routes traffic to the load
# balancer, and the CNAME proves domain control so the certificate can be issued.
output "web_domain_dns_records" {
  value = local.web_domain_enabled ? {
    address = { type = "A", name = var.web_domain, data = google_compute_global_address.web[0].address }
    certificate_authorization = {
      type = google_certificate_manager_dns_authorization.web[0].dns_resource_record[0].type
      name = google_certificate_manager_dns_authorization.web[0].dns_resource_record[0].name
      data = google_certificate_manager_dns_authorization.web[0].dns_resource_record[0].data
    }
  } : null
}
