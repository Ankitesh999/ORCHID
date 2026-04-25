from __future__ import annotations

import os
import re
import time
from datetime import datetime, timedelta, timezone
from typing import Any

from .clients import AckScheduler, DetectionClient, EnrichmentClient, EventPublisher, IncidentRepository
from .models import (
    AI_STATE_COMPLETED,
    AI_STATE_FAILED,
    AI_STATE_MANUAL_TRIAGE,
    ALLOCATION_STATUS_NO_CANDIDATE,
    ASSIGNMENT_PHASE_INITIAL,
    ASSIGNMENT_PHASE_RETRY,
    ENRICHMENT_PENDING,
    INCIDENT_STATUS_ACKNOWLEDGED,
    INCIDENT_STATUS_ASSIGNED,
    INCIDENT_STATUS_DETECTED,
    INCIDENT_STATUS_TRIAGE_REQUIRED,
    INCIDENT_STATUS_UNACKED_ESCALATION,
    IngestPayload,
    isoformat_z,
    safe_get,
    utcnow,
)
from .scoring import normalize_detection_label, required_skill_from_detection, score_responder, severity_from_label
from .settings import AppSettings


def _normalize_label(value: str | None) -> str:
    if not value:
        return "unclassified_incident"
    return re.sub(r"\s+", "_", value.strip().lower())


def _safe_float(value: Any, default: float = 0.0) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def _severity_from_detection(label: str, confidence: float, threshold: float) -> str:
    if confidence < threshold:
        return "low"
    return severity_from_label(label)


def _parse_iso(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00")).astimezone(timezone.utc)
    except ValueError:
        return None


class IncidentOrchestrator:
    def __init__(
        self,
        *,
        repo: IncidentRepository,
        publisher: EventPublisher,
        scheduler: AckScheduler,
        enricher: EnrichmentClient,
        detector: DetectionClient,
        settings: AppSettings,
    ):
        self.repo = repo
        self.publisher = publisher
        self.scheduler = scheduler
        self.enricher = enricher
        self.detector = detector
        self.settings = settings

    def parse_ingest_payload(self, raw: dict[str, Any]) -> IngestPayload:
        request_id = str(raw.get("requestId", "")).strip()
        camera_id = str(raw.get("cameraId", "")).strip()
        timestamp = str(raw.get("timestamp", "")).strip()
        image_ref = raw.get("imageRef")
        image_base64 = raw.get("imageBase64")
        image_mime_type = raw.get("imageMimeType")
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
            image_mime_type=image_mime_type,
            location=location,
        )

    def ingest_http(self, raw: dict[str, Any]) -> dict[str, Any]:
        payload = self.parse_ingest_payload(raw)
        now = utcnow()
        now_iso = isoformat_z(now)
        detection = self.detector.detect(
            {
                "requestId": payload.request_id,
                "cameraId": payload.camera_id,
                "imageRef": payload.image_ref,
                "imageBase64": payload.image_base64,
                "imageMimeType": payload.image_mime_type,
            }
        )

        if detection.get("error") or not detection.get("label"):
            triage_event = {
                "requestId": payload.request_id,
                "cameraId": payload.camera_id,
                "timestamp": payload.timestamp,
                "source": "browser_camera_capture",
                "sourceType": "camera_capture",
                "status": INCIDENT_STATUS_TRIAGE_REQUIRED,
                "aiState": AI_STATE_FAILED,
                "triageRequired": True,
                "classification": {"provisional": "unclassified_incident"},
                "severity": {"provisional": "medium"},
                "requiredSkill": "general",
                "readyForAllocation": False,
                "assignmentPhase": ASSIGNMENT_PHASE_INITIAL,
                "aiDetection": {
                    "label": None,
                    "confidence": 0.0,
                    "evidenceSummary": "Live AI classification failed. Manual triage is required before dispatch.",
                },
                "confidence": 0.0,
                "location": payload.location,
                "audit": {
                    "rawImagePersisted": False,
                    "ingestedAt": now_iso,
                    "classificationMode": "live_ai",
                    "privacyMode": "data_minimization",
                },
                "triage": {
                    "required": True,
                    "reason": "ai_classification_failed",
                    "safeError": str(detection.get("error") or "missing_ai_label")[:240],
                },
            }
            self.publisher.publish_json(self.settings.fast_topic, triage_event)
            return {
                "requestId": payload.request_id,
                "acceptedAt": now_iso,
                "published": True,
                "status": INCIDENT_STATUS_TRIAGE_REQUIRED,
                "aiState": AI_STATE_FAILED,
                "triageRequired": True,
                "message": "Live AI classification failed; manual triage is required.",
                "topics": [self.settings.fast_topic],
            }

        detection_label = _normalize_label(str(detection.get("label")))
        confidence = _safe_float(detection.get("confidence"), default=0.0)
        required_skill = required_skill_from_detection(
            label=detection_label,
            confidence=confidence,
            threshold=self.settings.vertex_detection_confidence_threshold,
        )
        severity = _severity_from_detection(
            label=detection_label,
            confidence=confidence,
            threshold=self.settings.vertex_detection_confidence_threshold,
        )
        evidence_summary = str(detection.get("evidenceSummary") or "")

        fast_event = {
            "requestId": payload.request_id,
            "cameraId": payload.camera_id,
            "timestamp": payload.timestamp,
            "source": "browser_camera_capture",
            "sourceType": "camera_capture",
            "status": INCIDENT_STATUS_DETECTED,
            "aiState": AI_STATE_COMPLETED,
            "triageRequired": False,
            "classification": {"provisional": normalize_detection_label(detection_label)},
            "severity": {"provisional": severity},
            "requiredSkill": required_skill,
            "readyForAllocation": True,
            "assignmentPhase": ASSIGNMENT_PHASE_INITIAL,
            "aiDetection": {
                "label": normalize_detection_label(detection_label),
                "confidence": confidence,
                "evidenceSummary": evidence_summary,
            },
            "confidence": confidence,
            "location": payload.location,
            "audit": {
                "rawImagePersisted": False,
                "ingestedAt": now_iso,
                "classificationMode": "live_ai",
                "privacyMode": "data_minimization",
            },
        }
        enrich_event = {
            "requestId": payload.request_id,
            "cameraId": payload.camera_id,
            "timestamp": payload.timestamp,
            "imageRef": payload.image_ref,
            "imageBase64": payload.image_base64,
            "imageMimeType": payload.image_mime_type,
            "provisionalClassification": normalize_detection_label(detection_label),
            "provisionalSeverity": severity,
        }

        self.publisher.publish_json(self.settings.fast_topic, fast_event)
        self.publisher.publish_json(self.settings.enrich_topic, enrich_event)

        return {
            "requestId": payload.request_id,
            "acceptedAt": now_iso,
            "published": True,
            "classification": normalize_detection_label(detection_label),
            "severity": severity,
            "requiredSkill": required_skill,
            "confidence": confidence,
            "topics": [self.settings.fast_topic, self.settings.enrich_topic],
        }

    def persist_fast_event(self, event: dict[str, Any]) -> dict[str, Any]:
        request_id = str(event["requestId"])
        now_iso = isoformat_z(utcnow())
        incident, _ = self.repo.upsert_fast_incident(request_id, event, now_iso)
        return incident

    def allocate_initial_assignment(self, *, incident_id: str) -> dict[str, Any]:
        incident = self.repo.get_incident(incident_id)
        if not incident:
            return {"status": "missing", "incidentId": incident_id}
        if incident.get("assignedResponderId"):
            return incident
        if safe_get(incident, "allocation", "status") in {"processing", "completed"}:
            return incident
        if not bool(incident.get("readyForAllocation", False)):
            return incident
        if incident.get("status") != INCIDENT_STATUS_DETECTED:
            return incident
        if str(incident.get("assignmentPhase") or "") != ASSIGNMENT_PHASE_INITIAL:
            return incident

        """
        Allocate the initial responder to an incident.
        Uses a decentralized reverse auction: waits for responder apps to submit bids.
        BID_WAIT_SECONDS allows configuration of the auction duration.
        """
        bid_wait_seconds = float(os.environ.get("BID_WAIT_SECONDS", "3.0"))
        poll_interval = 0.5
        elapsed = 0.0
        
        valid_bids = []
        while elapsed < bid_wait_seconds:
            bids = self.repo.list_bids(incident_id)
            valid_bids = [b for b in bids if _safe_float(b.get("score"), 0.0) > 0]
            if len(valid_bids) >= 3:
                # Early exit if we have enough bids
                break
            time.sleep(poll_interval)
            elapsed += poll_interval

        required_skill = str(incident.get("requiredSkill") or "general")
        severity = safe_get(incident, "severity", "provisional") or "low"
        confidence = _safe_float(safe_get(incident, "aiDetection", "confidence"), default=0.0)
        evaluated_at = isoformat_z(utcnow())
        
        ranked_bids = sorted(valid_bids, key=lambda x: _safe_float(x.get("score"), 0.0), reverse=True)

        fallback = False
        selected_id: str | None = None
        candidate_queue: list[str] = []
        responders_evaluated = 0
        scored_qualified: list = []

        if ranked_bids:
            selected_id = str(ranked_bids[0].get("responderId"))
            candidate_queue = [str(b.get("responderId")) for b in ranked_bids]
            score_reason = "decentralized_auction_winner"
            responders_evaluated = len(valid_bids)
        else:
            # Fallback to central logic if no bids received
            responders = self.repo.list_responders()
            responders_evaluated = len(responders)
            scored_qualified = [
                score_responder(
                    responder=responder,
                    incident_location=incident.get("location"),
                    required_skill=required_skill,
                    severity=severity,
                    allow_fallback=True,
                )
                for responder in responders
            ]
            ranked_fallback = sorted([item for item in scored_qualified if item.score > 0], key=lambda item: item.score, reverse=True)
            if ranked_fallback:
                fallback = True
                selected_id = ranked_fallback[0].uid
                candidate_queue = [item.uid for item in ranked_fallback]
                score_reason = "fallback_nearest_available"
            else:
                score_reason = "no_available_responder"

        top_candidates = []
        if ranked_bids:
            for bid in ranked_bids[:3]:
                top_candidates.append({
                    "id": bid.get("responderId"),
                    "score": round(_safe_float(bid.get("score"), 0.0), 8),
                    "distanceMeters": round(_safe_float(bid.get("distance"), 0.0), 2),
                    "qualified": True,
                })
        elif scored_qualified:
            for item in sorted(scored_qualified, key=lambda item: item.score, reverse=True)[:3]:
                top_candidates.append({
                    "id": item.uid,
                    "score": round(item.score, 8),
                    "distanceMeters": None if item.distance_m == float("inf") else round(item.distance_m, 2),
                    "qualified": bool(item.skill_match),
                    "rejectedReason": item.reason if item.score <= 0 else None,
                })

        retry_eligible = None
        allocation_status = "completed" if selected_id else ALLOCATION_STATUS_NO_CANDIDATE
        now = utcnow()
        ack_deadline_iso = None
        if selected_id:
            ack_deadline_iso = isoformat_z(now + timedelta(seconds=self.settings.ack_timeout_seconds))
        if not selected_id:
            retry_eligible = isoformat_z(utcnow() + timedelta(seconds=self.settings.no_candidate_retry_seconds))

        result = self.repo.allocate_initial_assignment(
            incident_id=incident_id,
            selected_responder_id=selected_id,
            candidate_queue=candidate_queue,
            fallback=fallback,
            score_reason=score_reason,
            top_candidates=top_candidates,
            input_snapshot={
                "respondersEvaluated": responders_evaluated,
                "requiredSkill": required_skill,
                "severity": severity,
                "confidence": confidence,
                "evaluatedAt": evaluated_at,
            },
            now_iso=isoformat_z(now),
            ack_deadline_iso=ack_deadline_iso,
            retry_eligible_at_iso=retry_eligible,
            allocation_status=allocation_status,
        )
        if result.get("status") == INCIDENT_STATUS_ASSIGNED and ack_deadline_iso:
            run_at = _parse_iso(ack_deadline_iso) or utcnow()
            self.scheduler.schedule_ack_check(incident_id=incident_id, assignment_attempt=1, run_at=run_at)
        if result.get("allocation", {}).get("status") == ALLOCATION_STATUS_NO_CANDIDATE and retry_eligible:
            self.scheduler.schedule_ack_check(incident_id=incident_id, assignment_attempt=0, run_at=_parse_iso(retry_eligible) or utcnow())
        return result

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

    def apply_manual_triage(
        self,
        *,
        incident_id: str,
        classification: str,
        severity: str,
        required_skill: str,
        actor_id: str | None,
    ) -> dict[str, Any] | None:
        if hasattr(self.repo, "apply_manual_triage"):
            return self.repo.apply_manual_triage(
                incident_id,
                classification=normalize_detection_label(classification),
                severity=severity,
                required_skill=required_skill,
                actor_id=actor_id,
                now_iso=isoformat_z(utcnow()),
            )
        return None

    def check_ack_deadline(self, *, incident_id: str, assignment_attempt: int) -> dict[str, Any]:
        incident = self.repo.get_incident(incident_id)
        if not incident:
            return {"status": "missing", "incidentId": incident_id}
        if incident.get("status") == INCIDENT_STATUS_ACKNOWLEDGED:
            return {"status": "already_acknowledged", "incidentId": incident_id}
        if self._is_terminal(incident):
            return {"status": "terminal", "incidentId": incident_id}

        if safe_get(incident, "allocation", "status") == ALLOCATION_STATUS_NO_CANDIDATE:
            retry_at = _parse_iso(incident.get("retryEligibleAt"))
            if retry_at and utcnow() < retry_at:
                return {"status": "not_due", "incidentId": incident_id, "retryEligibleAt": incident.get("retryEligibleAt")}
            self.repo.mark_retry_phase(incident_id, now_iso=isoformat_z(utcnow()))
            current_attempt = int(incident.get("assignmentAttempt") or 0)
            return self._assign_or_escalate(incident_id=incident_id, attempt=max(1, current_attempt + 1))

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
            assignment_phase=ASSIGNMENT_PHASE_RETRY,
        )
        self.scheduler.schedule_ack_check(
            incident_id=incident_id,
            assignment_attempt=attempt,
            run_at=ack_deadline,
        )
        return updated

    def _build_candidate_queue(self, incident: dict[str, Any]) -> list[str]:
        responders = self.repo.list_responders()
        severity = safe_get(incident, "severity", "provisional") or "low"
        required_skill = str(incident.get("requiredSkill") or "general")
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
        if not ranked:
            fallback_scored = [
                score_responder(
                    responder=responder,
                    incident_location=incident_location,
                    required_skill=required_skill,
                    severity=severity,
                    allow_fallback=True,
                )
                for responder in responders
            ]
            ranked = sorted([item for item in fallback_scored if item.score > 0], key=lambda item: item.score, reverse=True)
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
