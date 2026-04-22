from __future__ import annotations

import unittest

from orchid.clients import (
    InMemoryAckScheduler,
    InMemoryDetectionClient,
    InMemoryEnrichmentClient,
    InMemoryIncidentRepository,
    InMemoryPublisher,
)
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
        no_candidate_retry_seconds=30,
        ack_callback_url="https://example.com/checkAckDeadline",
        ack_queue_id="incident-ack-deadline",
        ack_tasks_service_account_email=None,
        vertex_detection_model="gemini-2.5-flash",
        vertex_detection_confidence_threshold=0.6,
        enable_vertex_detection=False,
        gemini_model="gemini-2.5-flash",
        enable_gemini=False,
        enable_tactical_reasoning=False,
        gemini_location="us-central1",
        google_api_key=None,
    )


class IncidentOrchestratorTests(unittest.TestCase):
    def setUp(self):
        self.repo = InMemoryIncidentRepository()
        self.publisher = InMemoryPublisher()
        self.scheduler = InMemoryAckScheduler()
        self.enricher = InMemoryEnrichmentClient()
        self.detector = InMemoryDetectionClient()
        self.service = IncidentOrchestrator(
            repo=self.repo,
            publisher=self.publisher,
            scheduler=self.scheduler,
            enricher=self.enricher,
            detector=self.detector,
            settings=build_settings(),
        )

    def seed_responders(self, responders: list[dict[str, object]]) -> None:
        self.repo.seed_users(responders)

    def ingest_and_persist(self, request_id: str, mock_label: str = "medical_distress") -> None:
        self.service.ingest_http(
            {
                "requestId": request_id,
                "cameraId": "cam-01",
                "timestamp": "2026-04-22T10:00:00Z",
                "imageRef": "gs://mock-bucket/frame.jpg",
                "mockLabel": mock_label,
                "location": {"lat": 12.9717, "lng": 77.5947},
            }
        )
        fast_event = self.publisher.published[-2]["payload"]
        self.service.persist_fast_event(fast_event)

    def test_persist_is_idempotent_without_assignment(self):
        self.seed_responders(
            [
                {
                    "uid": "resp-a",
                    "role": "responder",
                    "availability": True,
                    "skills": ["cpr_certified"],
                    "lastKnownLocation": {"lat": 12.9716, "lng": 77.5946},
                }
            ]
        )
        self.ingest_and_persist("req-dup-1")
        fast_event = self.publisher.published[-2]["payload"]
        self.service.persist_fast_event(fast_event)

        incident = self.repo.get_incident("req-dup-1")
        self.assertIsNotNone(incident)
        self.assertEqual(incident["status"], "detected")
        self.assertEqual(incident["assignmentAttempt"], 0)
        self.assertEqual(len(self.scheduler.scheduled), 0)

    def test_initial_allocator_runs_once_with_processing_completed_guard(self):
        self.seed_responders(
            [
                {
                    "uid": "resp-a",
                    "role": "responder",
                    "availability": True,
                    "skills": ["cpr_certified"],
                    "lastKnownLocation": {"lat": 12.9716, "lng": 77.5946},
                },
                {
                    "uid": "resp-b",
                    "role": "responder",
                    "availability": True,
                    "skills": ["cpr_certified"],
                    "lastKnownLocation": {"lat": 12.9718, "lng": 77.5948},
                },
            ]
        )
        self.ingest_and_persist("req-init-1")

        first = self.service.allocate_initial_assignment(incident_id="req-init-1")
        second = self.service.allocate_initial_assignment(incident_id="req-init-1")

        self.assertEqual(first["status"], "assigned")
        self.assertEqual(first["allocation"]["status"], "completed")
        self.assertEqual(second["assignedResponderId"], first["assignedResponderId"])
        self.assertEqual(len(self.scheduler.scheduled), 1)

    def test_low_confidence_forces_general_skill(self):
        class LowConfidenceDetection(InMemoryDetectionClient):
            def detect(self, payload: dict[str, object]) -> dict[str, object]:
                return {
                    "label": "fire",
                    "confidence": 0.4,
                    "evidenceSummary": "Low confidence signal",
                }

        self.service.detector = LowConfidenceDetection()
        self.service.ingest_http(
            {
                "requestId": "req-low-conf",
                "cameraId": "cam-01",
                "timestamp": "2026-04-22T10:00:00Z",
                "imageRef": "gs://mock-bucket/frame.jpg",
                "mockLabel": "fire",
                "location": {"lat": 12.9717, "lng": 77.5947},
            }
        )

        fast_event = self.publisher.published[-2]["payload"]
        self.assertEqual(fast_event["requiredSkill"], "general")
        self.assertEqual(fast_event["severity"]["provisional"], "low")

    def test_missing_responder_location_rejected_reason(self):
        self.seed_responders(
            [
                {
                    "uid": "resp-a",
                    "role": "responder",
                    "availability": True,
                    "skills": ["cpr_certified"],
                }
            ]
        )
        self.ingest_and_persist("req-missing-loc")
        result = self.service.allocate_initial_assignment(incident_id="req-missing-loc")

        self.assertEqual(result["allocation"]["status"], "no_candidate")
        self.assertEqual(result["allocation"]["topCandidates"][0]["rejectedReason"], "missing_location")

    def test_fallback_and_no_candidate_paths(self):
        self.seed_responders(
            [
                {
                    "uid": "resp-no-skill",
                    "role": "responder",
                    "availability": True,
                    "skills": ["general"],
                    "lastKnownLocation": {"lat": 12.9716, "lng": 77.5946},
                }
            ]
        )
        self.ingest_and_persist("req-fallback", mock_label="fire")

        fallback_result = self.service.allocate_initial_assignment(incident_id="req-fallback")
        self.assertEqual(fallback_result["status"], "assigned")
        self.assertTrue(fallback_result["allocation"]["fallback"])

        self.repo._users = {}
        self.seed_responders(
            [
                {
                    "uid": "resp-offline",
                    "role": "responder",
                    "availability": False,
                    "skills": ["cpr_certified"],
                    "lastKnownLocation": {"lat": 12.9716, "lng": 77.5946},
                }
            ]
        )
        self.ingest_and_persist("req-no-candidate")
        no_candidate = self.service.allocate_initial_assignment(incident_id="req-no-candidate")

        self.assertEqual(no_candidate["allocation"]["status"], "no_candidate")
        self.assertEqual(no_candidate["assignmentPhase"], "retry")
        self.assertIsNotNone(no_candidate["retryEligibleAt"])

    def test_retry_engine_recovers_no_candidate(self):
        self.seed_responders(
            [
                {
                    "uid": "resp-offline",
                    "role": "responder",
                    "availability": False,
                    "skills": ["cpr_certified"],
                    "lastKnownLocation": {"lat": 12.9716, "lng": 77.5946},
                }
            ]
        )
        self.ingest_and_persist("req-recover")
        self.service.allocate_initial_assignment(incident_id="req-recover")

        self.repo._incidents["req-recover"]["retryEligibleAt"] = "2000-01-01T00:00:00Z"
        self.repo._users["resp-offline"]["availability"] = True

        recovered = self.service.check_ack_deadline(incident_id="req-recover", assignment_attempt=0)
        self.assertEqual(recovered["status"], "assigned")
        self.assertEqual(recovered["assignmentPhase"], "retry")

    def test_ack_stops_retry_loop(self):
        self.seed_responders(
            [
                {
                    "uid": "resp-a",
                    "role": "responder",
                    "availability": True,
                    "skills": ["cpr_certified"],
                    "lastKnownLocation": {"lat": 12.9716, "lng": 77.5946},
                }
            ]
        )
        self.ingest_and_persist("req-ack-1")
        incident = self.service.allocate_initial_assignment(incident_id="req-ack-1")

        acked = self.service.acknowledge(incident_id="req-ack-1", responder_id=incident["assignedResponderId"])
        self.assertIsNotNone(acked)
        self.assertEqual(acked["status"], "acknowledged")

        check = self.service.check_ack_deadline(incident_id="req-ack-1", assignment_attempt=1)
        self.assertEqual(check["status"], "already_acknowledged")


if __name__ == "__main__":
    unittest.main()
