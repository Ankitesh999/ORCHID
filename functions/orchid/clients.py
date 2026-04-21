from __future__ import annotations

import base64
import json
import logging
import threading
from copy import deepcopy
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Protocol

from .models import (
    ENRICHMENT_COMPLETED,
    INCIDENT_STATUS_ACKNOWLEDGED,
    INCIDENT_STATUS_ASSIGNED,
    INCIDENT_STATUS_UNACKED_ESCALATION,
    isoformat_z,
)
from .settings import AppSettings

logger = logging.getLogger(__name__)


class IncidentRepository(Protocol):
    def upsert_fast_incident(self, request_id: str, payload: dict[str, Any], now_iso: str) -> tuple[dict[str, Any], bool]:
        ...

    def get_incident(self, incident_id: str) -> dict[str, Any] | None:
        ...

    def list_available_responders(self) -> list[dict[str, Any]]:
        ...

    def record_assignment(
        self,
        *,
        incident_id: str,
        assigned_responder_id: str,
        candidate_queue: list[str],
        assignment_attempt: int,
        ack_deadline_iso: str,
        now_iso: str,
    ) -> dict[str, Any]:
        ...

    def mark_unacked_escalation(self, incident_id: str, now_iso: str, reason: str) -> dict[str, Any]:
        ...

    def mark_acknowledged(
        self,
        incident_id: str,
        *,
        responder_id: str | None,
        now_iso: str,
    ) -> dict[str, Any] | None:
        ...

    def apply_enrichment(self, incident_id: str, enrichment: dict[str, Any], now_iso: str) -> dict[str, Any] | None:
        ...


class EventPublisher(Protocol):
    def publish_json(self, topic_id: str, payload: dict[str, Any]) -> None:
        ...


class AckScheduler(Protocol):
    def schedule_ack_check(self, *, incident_id: str, assignment_attempt: int, run_at: datetime) -> None:
        ...


class EnrichmentClient(Protocol):
    def enrich(self, payload: dict[str, Any]) -> dict[str, Any]:
        ...


def _merge_nested(target: dict[str, Any], updates: dict[str, Any]) -> dict[str, Any]:
    for key, value in updates.items():
        if "." in key:
            head, _, tail = key.partition(".")
            node = target.setdefault(head, {})
            if isinstance(node, dict):
                _merge_nested(node, {tail: value})
            continue

        if isinstance(value, dict) and isinstance(target.get(key), dict):
            _merge_nested(target[key], value)
        else:
            target[key] = value
    return target


class FirestoreIncidentRepository:
    def __init__(self, settings: AppSettings):
        from google.cloud import firestore

        self._firestore = firestore
        self._db = firestore.Client(project=settings.project_id, database=settings.firestore_database)

    def upsert_fast_incident(self, request_id: str, payload: dict[str, Any], now_iso: str) -> tuple[dict[str, Any], bool]:
        firestore = self._firestore
        doc_ref = self._db.collection("incidents").document(request_id)
        transaction = self._db.transaction()

        @firestore.transactional
        def _txn(txn):
            snapshot = doc_ref.get(transaction=txn)
            if snapshot.exists:
                current = snapshot.to_dict() or {}
                updates = {
                    "updatedAt": now_iso,
                    "cameraId": payload["cameraId"],
                    "source": payload.get("source", "edge_mock_camera"),
                    "classification.provisional": payload["classification"]["provisional"],
                    "severity.provisional": payload["severity"]["provisional"],
                    "enrichmentState": current.get("enrichmentState", "pending"),
                    "location": payload.get("location"),
                }
                txn.set(doc_ref, updates, merge=True)
                merged = deepcopy(current)
                _merge_nested(merged, updates)
                return merged, False

            doc = {
                "requestId": request_id,
                "status": "detected",
                "cameraId": payload["cameraId"],
                "source": payload.get("source", "edge_mock_camera"),
                "classification": {"provisional": payload["classification"]["provisional"], "enriched": None},
                "severity": {"provisional": payload["severity"]["provisional"], "enriched": None},
                "confidence": {"provisional": payload.get("confidence"), "enriched": None},
                "summary": None,
                "location": payload.get("location"),
                "candidateQueue": [],
                "assignmentAttempt": 0,
                "assignedResponderId": None,
                "ackDeadline": None,
                "acknowledgedAt": None,
                "enrichmentState": "pending",
                "createdAt": now_iso,
                "updatedAt": now_iso,
            }
            txn.set(doc_ref, doc, merge=False)
            return doc, True

        return _txn(transaction)

    def get_incident(self, incident_id: str) -> dict[str, Any] | None:
        snapshot = self._db.collection("incidents").document(incident_id).get()
        if not snapshot.exists:
            return None
        return snapshot.to_dict() or {}

    def list_available_responders(self) -> list[dict[str, Any]]:
        responders: list[dict[str, Any]] = []
        query = self._db.collection("users").where("role", "==", "responder").where("availability", "==", True)
        for snap in query.stream():
            data = snap.to_dict() or {}
            data["uid"] = snap.id
            responders.append(data)
        return responders

    def record_assignment(
        self,
        *,
        incident_id: str,
        assigned_responder_id: str,
        candidate_queue: list[str],
        assignment_attempt: int,
        ack_deadline_iso: str,
        now_iso: str,
    ) -> dict[str, Any]:
        doc_ref = self._db.collection("incidents").document(incident_id)
        updates = {
            "status": INCIDENT_STATUS_ASSIGNED,
            "assignedResponderId": assigned_responder_id,
            "candidateQueue": candidate_queue,
            "assignmentAttempt": assignment_attempt,
            "ackDeadline": ack_deadline_iso,
            "updatedAt": now_iso,
        }
        doc_ref.set(updates, merge=True)
        incident = self.get_incident(incident_id) or {}
        return incident

    def mark_unacked_escalation(self, incident_id: str, now_iso: str, reason: str) -> dict[str, Any]:
        updates = {
            "status": INCIDENT_STATUS_UNACKED_ESCALATION,
            "assignedResponderId": None,
            "ackDeadline": None,
            "updatedAt": now_iso,
            "unackedReason": reason,
        }
        self._db.collection("incidents").document(incident_id).set(updates, merge=True)
        return self.get_incident(incident_id) or {}

    def mark_acknowledged(
        self,
        incident_id: str,
        *,
        responder_id: str | None,
        now_iso: str,
    ) -> dict[str, Any] | None:
        firestore = self._firestore
        doc_ref = self._db.collection("incidents").document(incident_id)
        transaction = self._db.transaction()

        @firestore.transactional
        def _txn(txn):
            snap = doc_ref.get(transaction=txn)
            if not snap.exists:
                return None
            current = snap.to_dict() or {}
            if current.get("status") == INCIDENT_STATUS_ACKNOWLEDGED:
                return current
            assigned = current.get("assignedResponderId")
            if responder_id and assigned and responder_id != assigned:
                return current
            updates = {
                "status": INCIDENT_STATUS_ACKNOWLEDGED,
                "acknowledgedAt": now_iso,
                "ackDeadline": None,
                "updatedAt": now_iso,
            }
            txn.set(doc_ref, updates, merge=True)
            merged = deepcopy(current)
            _merge_nested(merged, updates)
            return merged

        return _txn(transaction)

    def apply_enrichment(self, incident_id: str, enrichment: dict[str, Any], now_iso: str) -> dict[str, Any] | None:
        doc_ref = self._db.collection("incidents").document(incident_id)
        if not doc_ref.get().exists:
            return None
        updates = {
            "classification.enriched": enrichment.get("classification"),
            "severity.enriched": enrichment.get("severity"),
            "confidence.enriched": enrichment.get("confidence"),
            "summary": enrichment.get("summary"),
            "enrichmentState": ENRICHMENT_COMPLETED if not enrichment.get("error") else "failed",
            "updatedAt": now_iso,
        }
        if enrichment.get("error"):
            updates["enrichmentError"] = enrichment["error"]
        doc_ref.set(updates, merge=True)
        return self.get_incident(incident_id)


class PubSubEventPublisher:
    def __init__(self, settings: AppSettings):
        from google.cloud import pubsub_v1

        self._project_id = settings.project_id
        self._client = pubsub_v1.PublisherClient()

    def publish_json(self, topic_id: str, payload: dict[str, Any]) -> None:
        topic_path = topic_id
        if not topic_id.startswith("projects/"):
            topic_path = self._client.topic_path(self._project_id, topic_id)
        body = json.dumps(payload).encode("utf-8")
        future = self._client.publish(topic_path, body, content_type="application/json")
        future.result(timeout=10)


class CloudTasksAckScheduler:
    def __init__(self, settings: AppSettings):
        from google.cloud import tasks_v2

        self._tasks_v2 = tasks_v2
        self._client = tasks_v2.CloudTasksClient()
        self._project_id = settings.project_id
        self._region = settings.region
        self._queue_id = settings.ack_queue_id
        self._callback_url = settings.ack_callback_url
        self._sa_email = settings.ack_tasks_service_account_email

    def schedule_ack_check(self, *, incident_id: str, assignment_attempt: int, run_at: datetime) -> None:
        if not self._callback_url:
            logger.warning("ACK_CALLBACK_URL is not configured; skipping deadline scheduling")
            return

        from google.protobuf import timestamp_pb2

        queue_path = self._client.queue_path(self._project_id, self._region, self._queue_id)
        payload = json.dumps({"incidentId": incident_id, "assignmentAttempt": assignment_attempt}).encode("utf-8")
        timestamp = timestamp_pb2.Timestamp()
        timestamp.FromDatetime(run_at)

        task: dict[str, Any] = {
            "schedule_time": timestamp,
            "http_request": {
                "http_method": self._tasks_v2.HttpMethod.POST,
                "url": self._callback_url,
                "headers": {"Content-Type": "application/json"},
                "body": payload,
            },
        }
        if self._sa_email:
            task["http_request"]["oidc_token"] = {"service_account_email": self._sa_email}

        self._client.create_task(parent=queue_path, task=task)


class GeminiEnrichmentClient:
    def __init__(self, settings: AppSettings):
        self._settings = settings

    def enrich(self, payload: dict[str, Any]) -> dict[str, Any]:
        provisional = payload.get("provisionalClassification") or "possible_incident"
        provisional_severity = payload.get("provisionalSeverity") or "medium"
        if not self._settings.enable_gemini:
            return {
                "classification": provisional,
                "severity": provisional_severity,
                "confidence": 0.5,
                "summary": "Gemini disabled; using provisional classification.",
            }

        try:
            from google import genai
        except Exception as exc:  # pragma: no cover - runtime guard
            return {
                "classification": provisional,
                "severity": provisional_severity,
                "confidence": 0.5,
                "summary": "Gemini SDK unavailable; fallback applied.",
                "error": f"sdk_unavailable:{exc}",
            }

        prompt = (
            "You are classifying a hospitality crisis image for emergency triage. "
            "Return strict JSON with keys classification, severity, confidence, summary. "
            "Severity must be one of critical/high/medium/low. "
            f"Provisional classification: {provisional}. Provisional severity: {provisional_severity}."
        )
        parts: list[Any] = [prompt]
        image_ref = payload.get("imageRef")
        image_base64 = payload.get("imageBase64")
        if image_ref:
            parts.append(genai.types.Part.from_uri(file_uri=image_ref, mime_type="image/jpeg"))
        elif image_base64:
            image_bytes = base64.b64decode(image_base64)
            parts.append(genai.types.Part.from_bytes(data=image_bytes, mime_type="image/jpeg"))

        try:
            client = genai.Client(vertexai=True, project=self._settings.project_id, location=self._settings.gemini_location)
            response = client.models.generate_content(model=self._settings.gemini_model, contents=parts)
            raw_text = (response.text or "").strip()
            parsed = json.loads(raw_text) if raw_text.startswith("{") else {}
            return {
                "classification": parsed.get("classification", provisional),
                "severity": parsed.get("severity", provisional_severity),
                "confidence": float(parsed.get("confidence", 0.5)),
                "summary": parsed.get("summary", "Gemini enrichment completed."),
            }
        except Exception as exc:  # pragma: no cover - runtime guard
            logger.exception("Gemini enrichment failed")
            return {
                "classification": provisional,
                "severity": provisional_severity,
                "confidence": 0.5,
                "summary": "Gemini request failed; fallback applied.",
                "error": str(exc),
            }


class InMemoryIncidentRepository:
    def __init__(self):
        self._incidents: dict[str, dict[str, Any]] = {}
        self._users: dict[str, dict[str, Any]] = {}
        self._lock = threading.Lock()

    def seed_users(self, users: list[dict[str, Any]]) -> None:
        with self._lock:
            for user in users:
                self._users[str(user["uid"])] = deepcopy(user)

    def upsert_fast_incident(self, request_id: str, payload: dict[str, Any], now_iso: str) -> tuple[dict[str, Any], bool]:
        with self._lock:
            if request_id in self._incidents:
                incident = self._incidents[request_id]
                incident["updatedAt"] = now_iso
                incident["classification"]["provisional"] = payload["classification"]["provisional"]
                incident["severity"]["provisional"] = payload["severity"]["provisional"]
                incident["location"] = payload.get("location")
                return deepcopy(incident), False

            doc = {
                "requestId": request_id,
                "status": "detected",
                "cameraId": payload["cameraId"],
                "source": payload.get("source", "edge_mock_camera"),
                "classification": {"provisional": payload["classification"]["provisional"], "enriched": None},
                "severity": {"provisional": payload["severity"]["provisional"], "enriched": None},
                "confidence": {"provisional": payload.get("confidence"), "enriched": None},
                "summary": None,
                "location": payload.get("location"),
                "candidateQueue": [],
                "assignmentAttempt": 0,
                "assignedResponderId": None,
                "ackDeadline": None,
                "acknowledgedAt": None,
                "enrichmentState": "pending",
                "createdAt": now_iso,
                "updatedAt": now_iso,
            }
            self._incidents[request_id] = doc
            return deepcopy(doc), True

    def get_incident(self, incident_id: str) -> dict[str, Any] | None:
        with self._lock:
            incident = self._incidents.get(incident_id)
            return deepcopy(incident) if incident else None

    def list_available_responders(self) -> list[dict[str, Any]]:
        with self._lock:
            responders = []
            for uid, user in self._users.items():
                if user.get("role") == "responder" and user.get("availability"):
                    item = deepcopy(user)
                    item["uid"] = uid
                    responders.append(item)
            return responders

    def record_assignment(
        self,
        *,
        incident_id: str,
        assigned_responder_id: str,
        candidate_queue: list[str],
        assignment_attempt: int,
        ack_deadline_iso: str,
        now_iso: str,
    ) -> dict[str, Any]:
        with self._lock:
            incident = self._incidents[incident_id]
            incident["status"] = INCIDENT_STATUS_ASSIGNED
            incident["assignedResponderId"] = assigned_responder_id
            incident["candidateQueue"] = deepcopy(candidate_queue)
            incident["assignmentAttempt"] = assignment_attempt
            incident["ackDeadline"] = ack_deadline_iso
            incident["updatedAt"] = now_iso
            return deepcopy(incident)

    def mark_unacked_escalation(self, incident_id: str, now_iso: str, reason: str) -> dict[str, Any]:
        with self._lock:
            incident = self._incidents[incident_id]
            incident["status"] = INCIDENT_STATUS_UNACKED_ESCALATION
            incident["assignedResponderId"] = None
            incident["ackDeadline"] = None
            incident["updatedAt"] = now_iso
            incident["unackedReason"] = reason
            return deepcopy(incident)

    def mark_acknowledged(
        self,
        incident_id: str,
        *,
        responder_id: str | None,
        now_iso: str,
    ) -> dict[str, Any] | None:
        with self._lock:
            incident = self._incidents.get(incident_id)
            if not incident:
                return None
            if incident.get("status") == INCIDENT_STATUS_ACKNOWLEDGED:
                return deepcopy(incident)
            assigned = incident.get("assignedResponderId")
            if responder_id and assigned and responder_id != assigned:
                return deepcopy(incident)
            incident["status"] = INCIDENT_STATUS_ACKNOWLEDGED
            incident["acknowledgedAt"] = now_iso
            incident["ackDeadline"] = None
            incident["updatedAt"] = now_iso
            return deepcopy(incident)

    def apply_enrichment(self, incident_id: str, enrichment: dict[str, Any], now_iso: str) -> dict[str, Any] | None:
        with self._lock:
            incident = self._incidents.get(incident_id)
            if not incident:
                return None
            incident["classification"]["enriched"] = enrichment.get("classification")
            incident["severity"]["enriched"] = enrichment.get("severity")
            incident["confidence"]["enriched"] = enrichment.get("confidence")
            incident["summary"] = enrichment.get("summary")
            incident["enrichmentState"] = ENRICHMENT_COMPLETED if not enrichment.get("error") else "failed"
            incident["updatedAt"] = now_iso
            if enrichment.get("error"):
                incident["enrichmentError"] = enrichment["error"]
            return deepcopy(incident)


class InMemoryPublisher:
    def __init__(self):
        self.published: list[dict[str, Any]] = []

    def publish_json(self, topic_id: str, payload: dict[str, Any]) -> None:
        self.published.append({"topic": topic_id, "payload": deepcopy(payload)})


@dataclass
class ScheduledAck:
    incident_id: str
    assignment_attempt: int
    run_at_iso: str


class InMemoryAckScheduler:
    def __init__(self):
        self.scheduled: list[ScheduledAck] = []

    def schedule_ack_check(self, *, incident_id: str, assignment_attempt: int, run_at: datetime) -> None:
        self.scheduled.append(
            ScheduledAck(
                incident_id=incident_id,
                assignment_attempt=assignment_attempt,
                run_at_iso=isoformat_z(run_at),
            )
        )


class InMemoryEnrichmentClient:
    def __init__(self):
        self.calls: list[dict[str, Any]] = []

    def enrich(self, payload: dict[str, Any]) -> dict[str, Any]:
        self.calls.append(deepcopy(payload))
        return {
            "classification": f"{payload.get('provisionalClassification', 'unknown')}_enriched",
            "severity": payload.get("provisionalSeverity", "medium"),
            "confidence": 0.83,
            "summary": "Async enrichment completed.",
        }
