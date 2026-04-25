from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any


INCIDENT_STATUS_DETECTED = "detected"
INCIDENT_STATUS_AI_CLASSIFYING = "ai_classifying"
INCIDENT_STATUS_TRIAGE_REQUIRED = "triage_required"
INCIDENT_STATUS_ASSIGNED = "assigned"
INCIDENT_STATUS_ACKNOWLEDGED = "acknowledged"
INCIDENT_STATUS_UNACKED_ESCALATION = "unacked_escalation"

AI_STATE_CLASSIFYING = "classifying"
AI_STATE_COMPLETED = "completed"
AI_STATE_FAILED = "failed"
AI_STATE_MANUAL_TRIAGE = "manual_triage"

ASSIGNMENT_PHASE_INITIAL = "initial"
ASSIGNMENT_PHASE_RETRY = "retry"

ALLOCATION_STATUS_PROCESSING = "processing"
ALLOCATION_STATUS_COMPLETED = "completed"
ALLOCATION_STATUS_NO_CANDIDATE = "no_candidate"

ENRICHMENT_PENDING = "pending"
ENRICHMENT_COMPLETED = "completed"
ENRICHMENT_FAILED = "failed"


def utcnow() -> datetime:
    return datetime.now(tz=timezone.utc)


def isoformat_z(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


@dataclass(frozen=True)
class IngestPayload:
    request_id: str
    camera_id: str
    timestamp: str
    image_ref: str | None
    image_base64: str | None
    image_mime_type: str | None
    location: dict[str, float] | None


@dataclass(frozen=True)
class AssignmentCandidate:
    uid: str
    score: float
    distance_m: float
    skill_match: bool
    available: bool
    reason: str


def safe_get(dct: dict[str, Any], *path: str, default: Any = None) -> Any:
    node: Any = dct
    for part in path:
        if not isinstance(node, dict):
            return default
        node = node.get(part)
        if node is None:
            return default
    return node
