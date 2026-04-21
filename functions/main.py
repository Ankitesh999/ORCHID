from __future__ import annotations

import base64
import json
import logging
import re
from typing import Any

try:
    import functions_framework
except Exception:  # pragma: no cover
    class _NoopFramework:
        @staticmethod
        def http(fn):
            return fn

        @staticmethod
        def cloud_event(fn):
            return fn

    functions_framework = _NoopFramework()  # type: ignore[assignment]

from orchid.clients import (
    CloudTasksAckScheduler,
    FirestoreIncidentRepository,
    GeminiEnrichmentClient,
    PubSubEventPublisher,
)
from orchid.services import IncidentOrchestrator
from orchid.settings import load_settings

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

_orchestrator: IncidentOrchestrator | None = None


def _build_orchestrator() -> IncidentOrchestrator:
    settings = load_settings()
    return IncidentOrchestrator(
        repo=FirestoreIncidentRepository(settings),
        publisher=PubSubEventPublisher(settings),
        scheduler=CloudTasksAckScheduler(settings),
        enricher=GeminiEnrichmentClient(settings),
        settings=settings,
    )


def get_orchestrator() -> IncidentOrchestrator:
    global _orchestrator
    if _orchestrator is None:
        _orchestrator = _build_orchestrator()
    return _orchestrator


def _cors_headers() -> dict[str, str]:
    return {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
    }


def _json_response(payload: dict[str, Any], status_code: int = 200):
    return (json.dumps(payload), status_code, {"Content-Type": "application/json", **_cors_headers()})


def _decode_pubsub_event(cloud_event) -> dict[str, Any]:
    data = cloud_event.data or {}
    message = data.get("message", data)
    raw = message.get("data")
    if raw is None:
        return {}
    decoded = base64.b64decode(raw).decode("utf-8")
    return json.loads(decoded)


@functions_framework.http
def ingest_incident(request):
    if request.method == "OPTIONS":
        return ("", 204, _cors_headers())
    if request.method != "POST":
        return _json_response({"error": "method_not_allowed"}, 405)

    body = request.get_json(silent=True) or {}
    orchestrator = get_orchestrator()
    try:
        result = orchestrator.ingest_http(body)
    except ValueError as exc:
        return _json_response({"error": "validation_error", "message": str(exc)}, 400)
    except Exception as exc:  # pragma: no cover - runtime guard
        logger.exception("ingest_incident failed")
        return _json_response({"error": "internal_error", "message": str(exc)}, 500)
    return _json_response(result, 202)


@functions_framework.http
def ack_incident(request):
    if request.method == "OPTIONS":
        return ("", 204, _cors_headers())
    if request.method != "POST":
        return _json_response({"error": "method_not_allowed"}, 405)

    body = request.get_json(silent=True) or {}
    incident_id = body.get("incidentId")
    responder_id = body.get("responderId")
    if not incident_id:
        path = getattr(request, "path", "") or ""
        matched = re.search(r"/incidents/([^/]+)/ack$", path)
        if matched:
            incident_id = matched.group(1)

    if not incident_id:
        return _json_response({"error": "incidentId is required"}, 400)

    incident = get_orchestrator().acknowledge(incident_id=str(incident_id), responder_id=responder_id)
    if not incident:
        return _json_response({"error": "incident_not_found"}, 404)
    return _json_response({"ok": True, "incident": incident}, 200)


@functions_framework.http
def check_ack_deadline(request):
    if request.method == "OPTIONS":
        return ("", 204, _cors_headers())
    if request.method != "POST":
        return _json_response({"error": "method_not_allowed"}, 405)

    body = request.get_json(silent=True) or {}
    incident_id = body.get("incidentId")
    attempt = body.get("assignmentAttempt")
    if not incident_id or attempt is None:
        return _json_response({"error": "incidentId and assignmentAttempt are required"}, 400)

    result = get_orchestrator().check_ack_deadline(incident_id=str(incident_id), assignment_attempt=int(attempt))
    return _json_response({"ok": True, "result": result}, 200)


@functions_framework.cloud_event
def persist_incident(cloud_event):
    payload = _decode_pubsub_event(cloud_event)
    if not payload:
        logger.warning("persist_incident received empty payload")
        return
    get_orchestrator().persist_fast_event(payload)


@functions_framework.cloud_event
def enrich_incident(cloud_event):
    payload = _decode_pubsub_event(cloud_event)
    if not payload:
        logger.warning("enrich_incident received empty payload")
        return
    get_orchestrator().handle_enrichment_event(payload)
