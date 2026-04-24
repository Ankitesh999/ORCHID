from __future__ import annotations

import os
from dataclasses import dataclass


def _env(name: str, default: str | None = None) -> str | None:
    value = os.getenv(name, default)
    return value


def _env_bool(name: str, default: bool = False) -> bool:
    value = os.getenv(name)
    if value is None:
        return default
    return value.lower() in {"1", "true", "yes", "on"}


def _env_int(name: str, default: int) -> int:
    value = os.getenv(name)
    if value is None:
        return default
    return int(value)


def _resolve_project_id() -> str:
    project_id = (
        _env("GCP_PROJECT")
        or _env("GOOGLE_CLOUD_PROJECT")
        or _env("GCLOUD_PROJECT")
        or _env("GOOGLE_PROJECT_ID")
        or ""
    )
    if project_id:
        return project_id

    try:
        import google.auth

        _, detected_project = google.auth.default()
        if detected_project:
            return detected_project
    except Exception:
        pass

    return "local-dev"


@dataclass(frozen=True)
class AppSettings:
    project_id: str
    region: str
    firestore_database: str
    fast_topic: str
    enrich_topic: str
    ack_timeout_seconds: int
    max_assignment_attempts: int
    no_candidate_retry_seconds: int
    ack_callback_url: str | None
    ack_queue_id: str
    ack_tasks_service_account_email: str | None
    vertex_detection_model: str
    vertex_detection_confidence_threshold: float
    enable_vertex_detection: bool
    gemini_model: str
    enable_gemini: bool
    enable_tactical_reasoning: bool
    gemini_location: str
    google_api_key: str | None


def load_settings() -> AppSettings:
    project_id = _resolve_project_id()

    return AppSettings(
        project_id=project_id,
        region=_env("FUNCTION_REGION", "us-central1") or "us-central1",
        firestore_database=_env("FIRESTORE_DATABASE", "(default)") or "(default)",
        fast_topic=_env("FAST_TOPIC_ID", "incident.fast.v1") or "incident.fast.v1",
        enrich_topic=_env("ENRICH_TOPIC_ID", "incident.enrich.request.v1") or "incident.enrich.request.v1",
        ack_timeout_seconds=_env_int("ACK_TIMEOUT_SECONDS", 15),
        max_assignment_attempts=_env_int("MAX_ASSIGNMENT_ATTEMPTS", 3),
        no_candidate_retry_seconds=_env_int("NO_CANDIDATE_RETRY_SECONDS", 30),
        ack_callback_url=_env("ACK_CALLBACK_URL"),
        ack_queue_id=_env("ACK_QUEUE_ID", "incident-ack-deadline") or "incident-ack-deadline",
        ack_tasks_service_account_email=_env("ACK_TASKS_SERVICE_ACCOUNT_EMAIL"),
        vertex_detection_model=_env("VERTEX_DETECTION_MODEL", "gemini-2.5-flash") or "gemini-2.5-flash",
        vertex_detection_confidence_threshold=float(
            _env("VERTEX_DETECTION_CONFIDENCE_THRESHOLD", "0.6") or "0.6"
        ),
        enable_vertex_detection=_env_bool("ENABLE_VERTEX_DETECTION", True),
        gemini_model=_env("GEMINI_MODEL", "gemini-2.5-flash") or "gemini-2.5-flash",
        enable_gemini=_env_bool("ENABLE_GEMINI", True),
        enable_tactical_reasoning=_env_bool("ENABLE_TACTICAL_REASONING", False),
        gemini_location=_env("GEMINI_LOCATION", "us-central1") or "us-central1",
        google_api_key=_env("GOOGLE_API_KEY"),
    )
