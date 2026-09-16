variable "project_id" { type = string }
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
variable "database_tier" {
  type    = string
  default = "db-custom-2-7680"
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
  default = "e2-standard-2"
}
