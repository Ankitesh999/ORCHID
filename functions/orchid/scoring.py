from __future__ import annotations

import math
import re
from typing import Any

from .models import AssignmentCandidate


SEVERITY_WEIGHT = {
    "critical": 2.0,
    "high": 1.5,
    "medium": 1.0,
    "low": 0.7,
}


def _to_radians(value: float) -> float:
    return value * math.pi / 180.0


def haversine_meters(
    lat1: float,
    lng1: float,
    lat2: float,
    lng2: float,
) -> float:
    radius_m = 6_371_000.0
    dlat = _to_radians(lat2 - lat1)
    dlng = _to_radians(lng2 - lng1)
    a = (
        math.sin(dlat / 2) ** 2
        + math.cos(_to_radians(lat1)) * math.cos(_to_radians(lat2)) * math.sin(dlng / 2) ** 2
    )
    c = 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))
    return radius_m * c


def required_skill_from_label(label: str | None) -> str:
    if not label:
        return "general"

    normalized = normalize_detection_label(label)
    if normalized == "fire":
        return "fire_response"
    if normalized in {"medical_distress", "collapse", "seizure", "vitals_heart_rate_drop"}:
        return "cpr_certified"
    return "general"


def normalize_detection_label(label: str | None) -> str:
    if not label:
        return "general_incident"
    normalized = re.sub(r"\s+", "_", str(label).strip().lower())
    if "fire" in normalized or "smoke" in normalized:
        return "fire"
    if "medical" in normalized and "distress" in normalized:
        return "medical_distress"
    if "collapse" in normalized:
        return "collapse"
    if "seizure" in normalized:
        return "seizure"
    if "fight" in normalized:
        return "fight"
    if "injury" in normalized:
        return "injury"
    if "acoustic_distress_vocalization" in normalized:
        return "acoustic_distress_vocalization"
    if "vitals_heart_rate_drop" in normalized:
        return "vitals_heart_rate_drop"
    return normalized


def severity_from_label(label: str | None) -> str:
    normalized = normalize_detection_label(label)
    if normalized == "fire":
        return "critical"
    if normalized in {"medical_distress", "collapse", "seizure", "vitals_heart_rate_drop"}:
        return "high"
    if normalized in {"fight", "injury", "acoustic_distress_vocalization"}:
        return "medium"
    return "low"


def required_skill_from_detection(*, label: str | None, confidence: float, threshold: float) -> str:
    if confidence < threshold:
        return "general"
    return required_skill_from_label(label)


def severity_weight(severity: str | None) -> float:
    if not severity:
        return SEVERITY_WEIGHT["medium"]
    return SEVERITY_WEIGHT.get(severity.lower(), SEVERITY_WEIGHT["medium"])


def score_responder(
    *,
    responder: dict[str, Any],
    incident_location: dict[str, float] | None,
    required_skill: str,
    severity: str | None,
    allow_fallback: bool = False,
) -> AssignmentCandidate:
    uid = str(responder.get("uid", ""))
    availability = bool(responder.get("availability", False))
    skills = responder.get("skills", []) or []
    skill_match = required_skill == "general" or required_skill in skills

    if not availability:
        return AssignmentCandidate(
            uid=uid,
            score=0.0,
            distance_m=float("inf"),
            skill_match=skill_match,
            available=availability,
            reason="unavailable",
        )

    if not skill_match and not allow_fallback:
        return AssignmentCandidate(
            uid=uid,
            score=0.0,
            distance_m=float("inf"),
            skill_match=False,
            available=availability,
            reason=f"missing_{required_skill}",
        )

    responder_loc = responder.get("lastKnownLocation") or {}
    if not incident_location:
        return AssignmentCandidate(
            uid=uid,
            score=0.0,
            distance_m=float("inf"),
            skill_match=skill_match,
            available=availability,
            reason="missing_location",
        )

    if "lat" not in responder_loc or "lng" not in responder_loc:
        return AssignmentCandidate(
            uid=uid,
            score=0.0,
            distance_m=float("inf"),
            skill_match=skill_match,
            available=availability,
            reason="missing_location",
        )

    distance_m = haversine_meters(
        float(responder_loc["lat"]),
        float(responder_loc["lng"]),
        float(incident_location["lat"]),
        float(incident_location["lng"]),
    )
    effective_distance = max(distance_m, 1.0)
    skill_weight = 1.0 if skill_match else 0.5
    weight = severity_weight(severity) * skill_weight
    score = (1.0 / effective_distance) * weight
    return AssignmentCandidate(
        uid=uid,
        score=score,
        distance_m=distance_m,
        skill_match=skill_match,
        available=availability,
        reason="fallback" if allow_fallback and not skill_match else "ok",
    )
