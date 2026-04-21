from __future__ import annotations

import unittest

from orchid.clients import InMemoryAckScheduler, InMemoryEnrichmentClient, InMemoryIncidentRepository, InMemoryPublisher
from orchid.services import IncidentOrchestrator
from orchid.settings import AppSettings


def build_settings() -> AppSettings:
    return AppSettings(
        project_id="local-dev",
        region="us-central1",
        firestore_database="(default)",
        fast_topic="incident.fast.v1",
        enrich_topic="incident.enrich.request.v1",
        ack_timeout_seconds=15,
        max_assignment_attempts=3,
        ack_callback_url="https://example.com/checkAckDeadline",
        ack_queue_id="incident-ack-deadline",
        ack_tasks_service_account_email=None,
        gemini_model="gemini-2.5-flash",
        enable_gemini=False,
        gemini_location="us-central1",
        google_api_key=None,
    )


class IncidentOrchestratorTests(unittest.TestCase):
    def setUp(self):
        self.repo = InMemoryIncidentRepository()
        self.publisher = InMemoryPublisher()
        self.scheduler = InMemoryAckScheduler()
        self.enricher = InMemoryEnrichmentClient()
        self.service = IncidentOrchestrator(
            repo=self.repo,
            publisher=self.publisher,
            scheduler=self.scheduler,
            enricher=self.enricher,
            settings=build_settings(),
        )
        self.repo.seed_users(
            [
                {
                    "uid": "resp-a",
                    "role": "responder",
                    "availability": True,
                    "skills": ["first_aid"],
                    "lastKnownLocation": {"lat": 12.9716, "lng": 77.5946},
                },
                {
                    "uid": "resp-b",
                    "role": "responder",
                    "availability": True,
                    "skills": ["first_aid"],
                    "lastKnownLocation": {"lat": 12.9718, "lng": 77.5948},
                },
                {
                    "uid": "resp-c",
                    "role": "responder",
                    "availability": True,
                    "skills": ["first_aid"],
                    "lastKnownLocation": {"lat": 12.9720, "lng": 77.5950},
                },
            ]
        )

    def _fast_event(self, request_id: str) -> dict[str, object]:
        return {
            "requestId": request_id,
            "cameraId": "cam-01",
            "timestamp": "2026-04-22T10:00:00Z",
            "source": "edge_mock_camera",
            "classification": {"provisional": "possible_medical_distress"},
            "severity": {"provisional": "high"},
            "confidence": 0.72,
            "location": {"lat": 12.9717, "lng": 77.5947},
        }

    def _expire_deadline(self, incident_id: str) -> None:
        # Test helper to simulate Cloud Tasks invoking the checker after deadline.
        self.repo._incidents[incident_id]["ackDeadline"] = "2000-01-01T00:00:00Z"

    def test_idempotent_persist_does_not_duplicate_or_restart_assignment(self):
        event = self._fast_event("req-dup-1")
        first = self.service.persist_fast_event(event)
        second = self.service.persist_fast_event(event)

        self.assertEqual(first["requestId"], "req-dup-1")
        self.assertEqual(second["requestId"], "req-dup-1")
        self.assertEqual(second["assignmentAttempt"], 1)
        self.assertEqual(len(self.scheduler.scheduled), 1)

    def test_retry_loop_reassigns_until_escalation(self):
        event = self._fast_event("req-retry-1")
        incident = self.service.persist_fast_event(event)
        self.assertEqual(incident["assignmentAttempt"], 1)
        self.assertEqual(incident["status"], "assigned")

        self._expire_deadline("req-retry-1")
        step2 = self.service.check_ack_deadline(incident_id="req-retry-1", assignment_attempt=1)
        self.assertEqual(step2["assignmentAttempt"], 2)
        self.assertEqual(step2["status"], "assigned")

        self._expire_deadline("req-retry-1")
        step3 = self.service.check_ack_deadline(incident_id="req-retry-1", assignment_attempt=2)
        self.assertEqual(step3["assignmentAttempt"], 3)
        self.assertEqual(step3["status"], "assigned")

        self._expire_deadline("req-retry-1")
        step4 = self.service.check_ack_deadline(incident_id="req-retry-1", assignment_attempt=3)
        self.assertEqual(step4["status"], "unacked_escalation")
        self.assertEqual(step4["assignedResponderId"], None)

    def test_ack_stops_retry_loop(self):
        event = self._fast_event("req-ack-1")
        incident = self.service.persist_fast_event(event)
        assigned = incident["assignedResponderId"]

        acked = self.service.acknowledge(incident_id="req-ack-1", responder_id=assigned)
        self.assertIsNotNone(acked)
        self.assertEqual(acked["status"], "acknowledged")

        check = self.service.check_ack_deadline(incident_id="req-ack-1", assignment_attempt=1)
        self.assertEqual(check["status"], "already_acknowledged")

    def test_deadline_check_before_due_is_noop(self):
        event = self._fast_event("req-not-due-1")
        self.service.persist_fast_event(event)
        check = self.service.check_ack_deadline(incident_id="req-not-due-1", assignment_attempt=1)
        self.assertEqual(check["status"], "not_due")

    def test_async_enrichment_updates_existing_incident(self):
        fast = self._fast_event("req-enrich-1")
        self.service.persist_fast_event(fast)
        enrich_event = {
            "requestId": "req-enrich-1",
            "provisionalClassification": "possible_medical_distress",
            "provisionalSeverity": "high",
            "imageRef": "gs://mock-bucket/crisis.jpg",
        }
        updated = self.service.handle_enrichment_event(enrich_event)

        self.assertEqual(updated["classification"]["enriched"], "possible_medical_distress_enriched")
        self.assertEqual(updated["enrichmentState"], "completed")


if __name__ == "__main__":
    unittest.main()
