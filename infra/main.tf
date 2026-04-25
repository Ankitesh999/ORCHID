terraform {
  required_version = ">= 1.5.0"
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 5.43"
    }
    google-beta = {
      source  = "hashicorp/google-beta"
      version = "~> 5.43"
    }
  }
}

provider "google" {
  project = var.project_id
  region  = var.region
}

provider "google-beta" {
  project = var.project_id
  region  = var.region
}

locals {
  services = [
    "artifactregistry.googleapis.com",
    "cloudbilling.googleapis.com",
    "cloudbuild.googleapis.com",
    "cloudfunctions.googleapis.com",
    "cloudtasks.googleapis.com",
    "eventarc.googleapis.com",
    "firestore.googleapis.com",
    "firebase.googleapis.com",
    "firebasehosting.googleapis.com",
    "iam.googleapis.com",
    "pubsub.googleapis.com",
    "run.googleapis.com"
  ]
}

resource "google_project_service" "enabled" {
  for_each = toset(local.services)
  project  = var.project_id
  service  = each.value
}

resource "google_firebase_project" "default" {
  provider   = google-beta
  project    = var.project_id
  depends_on = [google_project_service.enabled]
}

resource "google_firestore_database" "default" {
  project                     = var.project_id
  name                        = "(default)"
  location_id                 = var.region
  type                        = "FIRESTORE_NATIVE"
  concurrency_mode            = "OPTIMISTIC"
  app_engine_integration_mode = "DISABLED"
  depends_on                  = [google_project_service.enabled]
}

resource "google_pubsub_topic" "fast_topic" {
  name       = "incident.fast.v1"
  depends_on = [google_project_service.enabled]
}

resource "google_pubsub_topic" "enrich_topic" {
  name       = "incident.enrich.request.v1"
  depends_on = [google_project_service.enabled]
}

resource "google_cloud_tasks_queue" "ack_deadline" {
  name     = var.ack_queue_id
  location = var.region
  retry_config {
    max_attempts = 5
  }
  depends_on = [google_project_service.enabled]
}
