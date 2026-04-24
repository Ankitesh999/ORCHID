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
    VertexDetectionClient,
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
        detector=VertexDetectionClient(settings),
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


def _incident_id_from_firestore_event(cloud_event) -> str | None:
    # Debug: log all CloudEvent attributes to diagnose Gen2 format
    logger.info(
        "Firestore event attrs: subject=%s source=%s type=%s id=%s data_type=%s",
        getattr(cloud_event, "subject", "N/A"),
        getattr(cloud_event, "source", "N/A"),
        getattr(cloud_event, "type", "N/A"),
        getattr(cloud_event, "id", "N/A"),
        type(cloud_event.data).__name__ if cloud_event.data is not None else "None",
    )

    # Strategy 1: CloudEvent subject (standard Eventarc Firestore format)
    # e.g. "documents/incidents/cam-lobby-01-1776997834-6ee5d3c4"
    subject = getattr(cloud_event, "subject", None) or ""
    if "incidents/" in subject:
        incident_id = str(subject).rsplit("/", 1)[-1]
        if incident_id:
            logger.info("Resolved incident ID from subject: %s", incident_id)
            return incident_id

    # Strategy 2: CloudEvent source may contain the document path
    source = getattr(cloud_event, "source", None) or ""
    if "incidents/" in source:
        incident_id = str(source).rsplit("/", 1)[-1]
        if incident_id:
            logger.info("Resolved incident ID from source: %s", incident_id)
            return incident_id

    # Strategy 3: Parse data — might be protobuf bytes wrapped in Pub/Sub
    data = cloud_event.data
    if isinstance(data, bytes):
        try:
            data = json.loads(data.decode("utf-8"))
        except (json.JSONDecodeError, UnicodeDecodeError):
            # Might be protobuf — try to extract from the raw bytes
            raw_str = data.decode("utf-8", errors="replace")
            logger.warning("Could not JSON-decode event data. Raw preview: %s", raw_str[:500])
            # Try to find incidents/ path in raw bytes
            match = re.search(r"incidents/([a-zA-Z0-9_-]+)", raw_str)
            if match:
                logger.info("Resolved incident ID from raw bytes regex: %s", match.group(1))
                return match.group(1)
            return None

    if isinstance(data, dict):
        # Gen2 via Pub/Sub: data might be {"message": {"data": base64, "attributes": {...}}}
        message = data.get("message", data)
        if isinstance(message, dict):
            # Check Pub/Sub attributes for document path
            attrs = message.get("attributes") or {}
            doc_attr = attrs.get("document") or ""
            if "incidents/" in doc_attr:
                incident_id = str(doc_attr).rsplit("/", 1)[-1]
                if incident_id:
                    logger.info("Resolved incident ID from message attributes: %s", incident_id)
                    return incident_id

            # Try base64-decoded message data
            raw_b64 = message.get("data")
            if raw_b64 and isinstance(raw_b64, str):
                try:
                    decoded = base64.b64decode(raw_b64).decode("utf-8", errors="replace")
                    match = re.search(r"incidents/([a-zA-Z0-9_-]+)", decoded)
                    if match:
                        logger.info("Resolved incident ID from b64 message: %s", match.group(1))
                        return match.group(1)
                except Exception:
                    pass

        # Original Gen1 format: data.value.name
        value = data.get("value") or {}
        name = value.get("name") or ""
        if "/documents/incidents/" in name:
            incident_id = str(name).rsplit("/", 1)[-1]
            if incident_id:
                logger.info("Resolved incident ID from value.name: %s", incident_id)
                return incident_id

    logger.warning("Could not resolve incident ID from cloud event")
    return None


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


@functions_framework.cloud_event
def allocate_initial_incident(cloud_event):
    incident_id = _incident_id_from_firestore_event(cloud_event)
    if not incident_id:
        logger.warning("allocate_initial_incident could not resolve incident id")
        return
    get_orchestrator().allocate_initial_assignment(incident_id=incident_id)
