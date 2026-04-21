output "project_id" {
  value = var.project_id
}

output "region" {
  value = var.region
}

output "fast_topic_id" {
  value = google_pubsub_topic.fast_topic.name
}

output "enrich_topic_id" {
  value = google_pubsub_topic.enrich_topic.name
}

output "ack_queue_id" {
  value = google_cloud_tasks_queue.ack_deadline.name
}
