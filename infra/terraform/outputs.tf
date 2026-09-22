output "request_service_uris" { value = { for name, service in google_cloud_run_v2_service.request : name => service.uri } }
output "artifact_registry" { value = google_artifact_registry_repository.images.name }
output "evidence_bucket" { value = google_storage_bucket.evidence.name }
output "runtime_service_accounts" { value = { for name, account in google_service_account.runtime : name => account.email } }
output "worker_groups" { value = { for name, group in google_compute_region_instance_group_manager.workers : name => group.name } }

# The origin the API and relayer were configured to trust. WebAuthn rejects an assertion whose origin
# differs by even a character, so this is worth confirming against the web service's real URI before
# treating an enrollment failure as a code problem.
output "configured_web_origin" { value = local.web_origin }
