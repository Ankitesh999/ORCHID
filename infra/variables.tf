variable "project_id" {
  type        = string
  description = "GCP project id for ORCHID MVP"
}

variable "region" {
  type        = string
  description = "Primary region"
  default     = "us-central1"
}

variable "ack_queue_id" {
  type        = string
  default     = "incident-ack-deadline"
}
