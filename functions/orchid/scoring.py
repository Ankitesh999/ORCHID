from __future__ import annotations

import math
from typing import Any

from .models import AssignmentCandidate


SEVERITY_WEIGHT = {
    "critical": 3.0,
    "high": 2.0,
    "medium": 1.5,
    "low": 1.0,
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
        return "general_response"

    normalized = label.lower()
    if "fire" in normalized or "smoke" in normalized:
        return "fire_safety"
    if "medical" in normalized or "collapse" in normalized or "seizure" in normalized:
        return "first_aid"
    return "general_response"


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
) -> AssignmentCandidate:
    uid = str(responder.get("uid", ""))
    availability = bool(responder.get("availability", False))
    skills = responder.get("skills", []) or []
    skill_match = required_skill == "general_response" or required_skill in skills

    if not availability or not skill_match:
        return AssignmentCandidate(
            uid=uid,
            score=0.0,
            distance_m=float("inf"),
            skill_match=skill_match,
            available=availability,
            reason="disqualified",
        )

    responder_loc = responder.get("lastKnownLocation") or {}
    if not incident_location:
        return AssignmentCandidate(
            uid=uid,
            score=0.0,
            distance_m=float("inf"),
            skill_match=skill_match,
            available=availability,
            reason="missing_incident_location",
        )

    if "lat" not in responder_loc or "lng" not in responder_loc:
        return AssignmentCandidate(
            uid=uid,
            score=0.0,
            distance_m=float("inf"),
            skill_match=skill_match,
            available=availability,
            reason="missing_responder_location",
        )

    distance_m = haversine_meters(
        float(responder_loc["lat"]),
        float(responder_loc["lng"]),
        float(incident_location["lat"]),
        float(incident_location["lng"]),
    )
    effective_distance = max(distance_m, 1.0)
    weight = severity_weight(severity)
    score = (1.0 / effective_distance) * weight
    return AssignmentCandidate(
        uid=uid,
        score=score,
        distance_m=distance_m,
        skill_match=skill_match,
        available=availability,
        reason="ok",
    )
