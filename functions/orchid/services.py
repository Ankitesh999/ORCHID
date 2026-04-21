from __future__ import annotations

import re
from datetime import datetime, timedelta, timezone
from typing import Any

from .clients import AckScheduler, EnrichmentClient, EventPublisher, IncidentRepository
from .models import (
    ENRICHMENT_PENDING,
    INCIDENT_STATUS_ACKNOWLEDGED,
    INCIDENT_STATUS_ASSIGNED,
    INCIDENT_STATUS_DETECTED,
    INCIDENT_STATUS_UNACKED_ESCALATION,
    IngestPayload,
    isoformat_z,
    safe_get,
    utcnow,
)
from .scoring import required_skill_from_label, score_responder
from .settings import AppSettings


def _normalize_label(value: str | None) -> str:
    if not value:
        return "possible_medical_distress"
    return re.sub(r"\s+", "_", value.strip().lower())


def _provisional_severity(label: str) -> str:
    if "fire" in label or "explosion" in label:
        return "critical"
    if "medical" in label or "collapse" in label or "seizure" in label:
        return "high"
    if "fight" in label or "injury" in label:
        return "medium"
    return "medium"


class IncidentOrchestrator:
    def __init__(
        self,
        *,
        repo: IncidentRepository,
        publisher: EventPublisher,
        scheduler: AckScheduler,
        enricher: EnrichmentClient,
        settings: AppSettings,
    ):
        self.repo = repo
        self.publisher = publisher
        self.scheduler = scheduler
        self.enricher = enricher
        self.settings = settings

    def parse_ingest_payload(self, raw: dict[str, Any]) -> IngestPayload:
        request_id = str(raw.get("requestId", "")).strip()
        camera_id = str(raw.get("cameraId", "")).strip()
        timestamp = str(raw.get("timestamp", "")).strip()
        image_ref = raw.get("imageRef")
        image_base64 = raw.get("imageBase64")
        mock_label = raw.get("mockLabel")
        location = raw.get("location")

        if not request_id:
            raise ValueError("requestId is required")
        if not camera_id:
            raise ValueError("cameraId is required")
        if not timestamp:
            raise ValueError("timestamp is required")
        if not image_ref and not image_base64:
            raise ValueError("imageRef or imageBase64 is required")
        if location is not None and not isinstance(location, dict):
            raise ValueError("location must be an object with lat/lng")

        return IngestPayload(
            request_id=request_id,
            camera_id=camera_id,
            timestamp=timestamp,
            image_ref=image_ref,
            image_base64=image_base64,
            mock_label=mock_label,
            location=location,
        )

    def ingest_http(self, raw: dict[str, Any]) -> dict[str, Any]:
        payload = self.parse_ingest_payload(raw)
        label = _normalize_label(payload.mock_label)
        severity = _provisional_severity(label)
        now = utcnow()
        now_iso = isoformat_z(now)

        fast_event = {
            "requestId": payload.request_id,
            "cameraId": payload.camera_id,
            "timestamp": payload.timestamp,
            "source": "edge_mock_camera",
            "classification": {"provisional": label},
            "severity": {"provisional": severity},
            "confidence": 0.72,
            "location": payload.location,
        }
        enrich_event = {
            "requestId": payload.request_id,
            "cameraId": payload.camera_id,
            "timestamp": payload.timestamp,
            "imageRef": payload.image_ref,
            "imageBase64": payload.image_base64,
            "provisionalClassification": label,
            "provisionalSeverity": severity,
        }

        self.publisher.publish_json(self.settings.fast_topic, fast_event)
        self.publisher.publish_json(self.settings.enrich_topic, enrich_event)

        return {
            "requestId": payload.request_id,
            "acceptedAt": now_iso,
            "published": True,
            "classification": label,
            "severity": severity,
            "topics": [self.settings.fast_topic, self.settings.enrich_topic],
        }

    def persist_fast_event(self, event: dict[str, Any]) -> dict[str, Any]:
        request_id = str(event["requestId"])
        now_iso = isoformat_z(utcnow())
        incident, _ = self.repo.upsert_fast_incident(request_id, event, now_iso)

        if self._is_terminal(incident):
            return incident
        if incident.get("status") == INCIDENT_STATUS_ASSIGNED and incident.get("ackDeadline"):
            return incident
        if incident.get("status") == INCIDENT_STATUS_ACKNOWLEDGED:
            return incident
        if int(incident.get("assignmentAttempt") or 0) > 0:
            return incident

        return self._assign_or_escalate(incident_id=request_id, attempt=1)

    def handle_enrichment_event(self, event: dict[str, Any]) -> dict[str, Any]:
        request_id = str(event["requestId"])
        enrichment = self.enricher.enrich(event)
        updated = self.repo.apply_enrichment(request_id, enrichment, isoformat_z(utcnow()))
        return updated or {}

    def acknowledge(self, *, incident_id: str, responder_id: str | None) -> dict[str, Any] | None:
        return self.repo.mark_acknowledged(
            incident_id,
            responder_id=responder_id,
            now_iso=isoformat_z(utcnow()),
        )

    def check_ack_deadline(self, *, incident_id: str, assignment_attempt: int) -> dict[str, Any]:
        incident = self.repo.get_incident(incident_id)
        if not incident:
            return {"status": "missing", "incidentId": incident_id}
        if incident.get("status") == INCIDENT_STATUS_ACKNOWLEDGED:
            return {"status": "already_acknowledged", "incidentId": incident_id}
        if self._is_terminal(incident):
            return {"status": "terminal", "incidentId": incident_id}

        current_attempt = int(incident.get("assignmentAttempt") or 0)
        if current_attempt != assignment_attempt:
            return {
                "status": "stale_attempt",
                "incidentId": incident_id,
                "currentAttempt": current_attempt,
                "expectedAttempt": assignment_attempt,
            }

        ack_deadline_value = incident.get("ackDeadline")
        if ack_deadline_value:
            deadline = datetime.fromisoformat(str(ack_deadline_value).replace("Z", "+00:00")).astimezone(timezone.utc)
            if utcnow() < deadline:
                return {"status": "not_due", "incidentId": incident_id, "ackDeadline": ack_deadline_value}

        return self._assign_or_escalate(incident_id=incident_id, attempt=assignment_attempt + 1)

    def _assign_or_escalate(self, *, incident_id: str, attempt: int) -> dict[str, Any]:
        incident = self.repo.get_incident(incident_id)
        if not incident:
            return {"status": "missing", "incidentId": incident_id}
        if incident.get("status") == INCIDENT_STATUS_ACKNOWLEDGED:
            return incident

        max_attempts = self.settings.max_assignment_attempts
        if attempt > max_attempts:
            return self.repo.mark_unacked_escalation(
                incident_id,
                now_iso=isoformat_z(utcnow()),
                reason="max_attempts_reached",
            )

        candidate_queue = incident.get("candidateQueue") or self._build_candidate_queue(incident)
        if not candidate_queue:
            return self.repo.mark_unacked_escalation(
                incident_id,
                now_iso=isoformat_z(utcnow()),
                reason="no_eligible_responders",
            )

        if attempt > len(candidate_queue):
            return self.repo.mark_unacked_escalation(
                incident_id,
                now_iso=isoformat_z(utcnow()),
                reason="candidate_queue_exhausted",
            )

        assigned_responder_id = candidate_queue[attempt - 1]
        now = utcnow()
        ack_deadline = now + timedelta(seconds=self.settings.ack_timeout_seconds)
        updated = self.repo.record_assignment(
            incident_id=incident_id,
            assigned_responder_id=assigned_responder_id,
            candidate_queue=candidate_queue,
            assignment_attempt=attempt,
            ack_deadline_iso=isoformat_z(ack_deadline),
            now_iso=isoformat_z(now),
        )
        self.scheduler.schedule_ack_check(
            incident_id=incident_id,
            assignment_attempt=attempt,
            run_at=ack_deadline,
        )
        return updated

    def _build_candidate_queue(self, incident: dict[str, Any]) -> list[str]:
        responders = self.repo.list_available_responders()
        label = safe_get(incident, "classification", "enriched") or safe_get(
            incident, "classification", "provisional"
        )
        severity = safe_get(incident, "severity", "enriched") or safe_get(incident, "severity", "provisional")
        required_skill = required_skill_from_label(label)
        incident_location = incident.get("location")

        scored = [
            score_responder(
                responder=responder,
                incident_location=incident_location,
                required_skill=required_skill,
                severity=severity,
            )
            for responder in responders
        ]
        ranked = sorted([item for item in scored if item.score > 0], key=lambda item: item.score, reverse=True)
        return [item.uid for item in ranked]

    @staticmethod
    def _is_terminal(incident: dict[str, Any]) -> bool:
        return incident.get("status") in {INCIDENT_STATUS_ACKNOWLEDGED, INCIDENT_STATUS_UNACKED_ESCALATION}


def default_incident_doc_template() -> dict[str, Any]:
    return {
        "status": INCIDENT_STATUS_DETECTED,
        "enrichmentState": ENRICHMENT_PENDING,
        "assignmentAttempt": 0,
        "candidateQueue": [],
    }
