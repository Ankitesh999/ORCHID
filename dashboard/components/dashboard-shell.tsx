"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { onAuthStateChanged, signInWithEmailAndPassword, signOut, User } from "firebase/auth";
import { collection, doc, limit, onSnapshot, orderBy, query, updateDoc, where } from "firebase/firestore";

import { auth, db } from "../lib/firebase";
import { Incident } from "../lib/types";
import { playSirenDebounced } from "../lib/siren";
import { PerceptionTier } from "./perception-tier";

type ResponderPin = {
  id: string;
  displayName?: string;
  availability?: boolean;
  disabled?: boolean;
  updatedAt?: string;
  lastKnownLocation?: {
    lat?: number;
    lng?: number;
  };
  skills?: string[];
};

type TriageDraft = {
  classification: string;
  severity: "low" | "medium" | "high" | "critical";
  requiredSkill: string;
};

const CAMPUS_BOUNDS = {
  north: 12.9735,
  south: 12.9695,
  east: 77.5985,
  west: 77.591,
};

const ACTIVE_STATUSES = new Set(["detected", "assigned", "unacked_escalation", "triage_required"]);

function locationToPercent(location?: { lat?: number; lng?: number }) {
  const lat = Number(location?.lat);
  const lng = Number(location?.lng);
  if (Number.isNaN(lat) || Number.isNaN(lng)) {
    return { x: 50, y: 50 };
  }
  const x = ((lng - CAMPUS_BOUNDS.west) / (CAMPUS_BOUNDS.east - CAMPUS_BOUNDS.west)) * 100;
  const y = ((CAMPUS_BOUNDS.north - lat) / (CAMPUS_BOUNDS.north - CAMPUS_BOUNDS.south)) * 100;
  return {
    x: Math.min(98, Math.max(2, x)),
    y: Math.min(98, Math.max(2, y)),
  };
}

function formatTime(value?: string | null) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

function formatConfidence(value?: number) {
  if (value === undefined || value === null) return "-";
  return `${Math.round(value * 100)}%`;
}

function displayValue(value?: string | null) {
  if (!value) return "-";
  return value.replaceAll("_", " ");
}

function statusLabel(status?: string) {
  return displayValue(status || "unknown").toUpperCase();
}

function lastSeenLabel(value?: string) {
  if (!value) return "No GPS update";
  const ts = Date.parse(value);
  if (Number.isNaN(ts)) return value;
  const seconds = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  return `${minutes}m ago`;
}

function defaultTriageDraft(incident?: Incident | null): TriageDraft {
  return {
    classification: incident?.classification?.provisional || "medical_distress",
    severity: (incident?.severity?.provisional as TriageDraft["severity"]) || "high",
    requiredSkill: incident?.requiredSkill || "cpr_certified",
  };
}

function IncidentQueue({
  incidents,
  selectedId,
  onSelect,
}: {
  incidents: Incident[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  return (
    <section className="card soc-panel incident-queue" aria-label="Incident queue">
      <div className="panel-heading">
        <div>
          <h2>Incident Queue</h2>
          <p>Live Firestore incident stream</p>
        </div>
        <span className="panel-count">{incidents.length}</span>
      </div>
      <div className="queue-list">
        {incidents.length === 0 ? (
          <p className="empty-state">No incidents received.</p>
        ) : (
          incidents.map((incident) => {
            const severity = incident.severity?.enriched || incident.severity?.provisional || "medium";
            return (
              <button
                key={incident.id}
                type="button"
                className={`queue-item ${selectedId === incident.id ? "queue-item-active" : ""}`}
                onClick={() => onSelect(incident.id)}
              >
                <span className={`severity-dot severity-dot-${severity}`} />
                <span>
                  <strong>{displayValue(incident.classification?.enriched || incident.classification?.provisional || incident.id)}</strong>
                  <small>{incident.cameraId || "unknown source"} · {formatTime(incident.createdAt)}</small>
                </span>
                <em className={`status status-${incident.status || "unknown"}`}>{statusLabel(incident.status)}</em>
              </button>
            );
          })
        )}
      </div>
    </section>
  );
}

function TriagePanel({
  incident,
  user,
  onError,
}: {
  incident: Incident;
  user: User;
  onError: (message: string | null) => void;
}) {
  const [draft, setDraft] = useState<TriageDraft>(() => defaultTriageDraft(incident));
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setDraft(defaultTriageDraft(incident));
  }, [incident.id]);

  async function submitTriage(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true);
    onError(null);
    try {
      await updateDoc(doc(db, "incidents", incident.id), {
        status: "detected",
        aiState: "manual_triage",
        triageRequired: false,
        readyForAllocation: true,
        assignmentPhase: "initial",
        "classification.provisional": draft.classification.trim().toLowerCase().replace(/\s+/g, "_"),
        "severity.provisional": draft.severity,
        requiredSkill: draft.requiredSkill.trim().toLowerCase().replace(/\s+/g, "_") || "general",
        "triage.required": false,
        "triage.resolvedAt": new Date().toISOString(),
        "triage.resolvedBy": user.uid,
        "audit.classificationMode": "manual_triage",
        "audit.triagedAt": new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
    } catch (err) {
      onError(err instanceof Error ? err.message : "Manual triage failed.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className="triage-form" onSubmit={submitTriage}>
      <div className="panel-heading compact">
        <div>
          <h3>Manual Triage Required</h3>
          <p>{incident.triage?.safeError || "Live AI classification did not produce a dispatchable result."}</p>
        </div>
      </div>
      <label>
        Classification
        <input
          value={draft.classification}
          onChange={(event) => setDraft((current) => ({ ...current, classification: event.target.value }))}
          required
        />
      </label>
      <label>
        Severity
        <select
          value={draft.severity}
          onChange={(event) => setDraft((current) => ({ ...current, severity: event.target.value as TriageDraft["severity"] }))}
        >
          <option value="low">Low</option>
          <option value="medium">Medium</option>
          <option value="high">High</option>
          <option value="critical">Critical</option>
        </select>
      </label>
      <label>
        Required skill
        <input
          value={draft.requiredSkill}
          onChange={(event) => setDraft((current) => ({ ...current, requiredSkill: event.target.value }))}
          required
        />
      </label>
      <button type="submit" disabled={saving}>
        {saving ? "Saving triage..." : "Confirm Triage and Release"}
      </button>
    </form>
  );
}

function EvidencePanel({ incident }: { incident: Incident }) {
  const aiState = incident.aiState || (incident.triageRequired ? "failed" : "completed");
  return (
    <section className="card soc-panel evidence-panel">
      <div className="panel-heading">
        <div>
          <h2>Evidence and AI State</h2>
          <p>Minimized incident metadata</p>
        </div>
        <span className={`ai-state ai-state-${aiState}`}>{displayValue(aiState).toUpperCase()}</span>
      </div>
      <div className="evidence-grid">
        <p><strong>Source</strong><span>{incident.cameraId || "-"}</span></p>
        <p><strong>Source type</strong><span>{displayValue(incident.sourceType || incident.source)}</span></p>
        <p><strong>Classification</strong><span>{displayValue(incident.classification?.enriched || incident.classification?.provisional)}</span></p>
        <p><strong>Confidence</strong><span>{formatConfidence(incident.aiDetection?.confidence)}</span></p>
        <p><strong>Raw frame persisted</strong><span>{incident.audit?.rawImagePersisted ? "Yes" : "No"}</span></p>
        <p><strong>Privacy mode</strong><span>{displayValue(incident.audit?.privacyMode || "data_minimization")}</span></p>
      </div>
      {incident.aiDetection?.evidenceSummary && (
        <div className="evidence-summary">
          <strong>AI evidence summary</strong>
          <p>{incident.aiDetection.evidenceSummary}</p>
        </div>
      )}
      {incident.summary && (
        <div className="evidence-summary">
          <strong>Enrichment summary</strong>
          <p>{incident.summary}</p>
        </div>
      )}
    </section>
  );
}

function AssignmentPanel({
  incident,
}: {
  incident: Incident;
}) {
  return (
    <section className="card soc-panel">
      <div className="panel-heading">
        <div>
          <h2>Assignment</h2>
          <p>Responder selection and acknowledgement</p>
        </div>
        <span className={`status status-${incident.status || "unknown"}`}>{statusLabel(incident.status)}</span>
      </div>
      <div className="evidence-grid">
        <p><strong>Assigned responder</strong><span>{incident.assignedResponderId || "-"}</span></p>
        <p><strong>Attempt</strong><span>{incident.assignmentAttempt || 0} / 3</span></p>
        <p><strong>Required skill</strong><span>{displayValue(incident.requiredSkill || "general")}</span></p>
        <p><strong>Ack deadline</strong><span>{formatTime(incident.ackDeadline)}</span></p>
        <p><strong>Score reason</strong><span>{displayValue(incident.allocation?.scoreReason)}</span></p>
        <p><strong>Responders evaluated</strong><span>{incident.allocation?.inputSnapshot?.respondersEvaluated ?? "-"}</span></p>
      </div>
      {(incident.allocation?.topCandidates || []).length > 0 && (
        <div className="candidate-table">
          {(incident.allocation?.topCandidates || []).slice(0, 4).map((candidate) => (
            <div key={`${incident.id}-${candidate.id}`}>
              <span>{candidate.id}</span>
              <span>{candidate.distanceMeters ?? "-"} m</span>
              <span>{candidate.score?.toFixed(6) ?? "-"}</span>
              <span>{candidate.qualified ? "Qualified" : displayValue(candidate.rejectedReason)}</span>
            </div>
          ))}
        </div>
      )}
      <p className="assignment-note">Acknowledgement is completed from the assigned responder device.</p>
    </section>
  );
}

function TacticalMap({
  incidents,
  responders,
  simPositions
}: {
  incidents: Incident[];
  responders: ResponderPin[];
  simPositions: Record<string, { lat: number; lng: number }>;
}) {
  return (
    <section className="card soc-panel map-panel" aria-label="Tactical map">
      <div className="panel-heading">
        <div>
          <h2>Response Map</h2>
          <p>Responder proximity and active incident locations</p>
        </div>
      </div>
      <div className="simulation-board soc-map-board">
        <span className="sim-zone-label" style={{ left: "12%", top: "15%" }}>LOBBY</span>
        <span className="sim-zone-label" style={{ left: "52%", top: "15%" }}>EAST WING</span>
        <span className="sim-zone-label" style={{ left: "12%", top: "62%" }}>CORRIDOR A</span>
        <span className="sim-zone-label" style={{ left: "62%", top: "62%" }}>EXIT BLOCK</span>
        <span className="sim-zone-label" style={{ left: "40%", top: "85%", fontSize: '12px', opacity: 0.15 }}>PARKING NORTH</span>
        <span className="sim-zone-label" style={{ left: "80%", top: "35%", fontSize: '12px', opacity: 0.15 }}>SERVER ROOM</span>

        {incidents
          .filter((incident) => ACTIVE_STATUSES.has(String(incident.status)))
          .map((incident) => {
            const severity = incident.severity?.enriched || incident.severity?.provisional || "medium";
            const pos = incident.location?.lat ? incident.location : simPositions[`INC-${incident.id}`];
            if (!pos) return null;
            const point = locationToPercent(pos);
            return (
              <div
                key={`incident-${incident.id}`}
                className={`map-incident-pin map-incident-pin-${severity} ${incident.status === "triage_required" ? "map-incident-triage" : ""}`}
                style={{ left: `${point.x}%`, top: `${point.y}%` }}
                title={`${incident.id} (${severity})`}
              />
            );
          })}

        {responders.filter((responder) => !responder.disabled).map((responder) => {
          const simPos = simPositions[responder.id];
          const point = locationToPercent(simPos || responder.lastKnownLocation);
          const assigned = incidents.some((incident) => incident.assignedResponderId === responder.id && ["assigned", "acknowledged"].includes(String(incident.status)));
          const freshGps = responder.updatedAt ? Date.now() - Date.parse(responder.updatedAt) < 30000 : false;
          return (
            <div
              key={responder.id}
              className={`map-responder-pin ${responder.availability === false ? "map-pin-offline" : ""} ${assigned ? "map-pin-assigned" : ""} ${freshGps ? "map-pin-live" : ""}`}
              style={{ left: `${point.x}%`, top: `${point.y}%`, transition: 'all 0.5s linear' }}
              title={`${responder.displayName || responder.id} - last seen ${lastSeenLabel(responder.updatedAt)}`}
            >
              {(responder.displayName || responder.id).slice(0, 2).toUpperCase()}
            </div>
          );
        })}
      </div>
    </section>
  );
}

function ActivityTimeline({ incidents, responders }: { incidents: Incident[]; responders: ResponderPin[] }) {
  const events = useMemo(() => {
    const rows: Array<{ id: string; ts: string; label: string; tone: string }> = [];
    incidents.forEach((incident) => {
      const name = displayValue(incident.classification?.enriched || incident.classification?.provisional || "incident");
      if (incident.createdAt) rows.push({ id: `${incident.id}-created`, ts: incident.createdAt, label: `${incident.id} detected as ${name}`, tone: "info" });
      if (incident.allocation?.assignedAt && incident.assignedResponderId) rows.push({ id: `${incident.id}-assigned`, ts: incident.allocation.assignedAt, label: `${incident.assignedResponderId} assigned to ${incident.id}`, tone: "warn" });
      if (incident.acknowledgedAt) rows.push({ id: `${incident.id}-ack`, ts: incident.acknowledgedAt, label: `${incident.id} acknowledged`, tone: "ok" });
      if (incident.resolvedAt) rows.push({ id: `${incident.id}-resolved`, ts: incident.resolvedAt, label: `${incident.id} resolved by ${incident.resolvedBy || "responder"}`, tone: "ok" });
    });
    responders.forEach((responder) => {
      if (responder.updatedAt) rows.push({ id: `${responder.id}-gps`, ts: responder.updatedAt, label: `${responder.displayName || responder.id} GPS update`, tone: responder.availability === false ? "muted" : "info" });
    });
    return rows
      .filter((row) => !Number.isNaN(Date.parse(row.ts)))
      .sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts))
      .slice(0, 12);
  }, [incidents, responders]);

  return (
    <section className="card soc-panel activity-panel">
      <div className="panel-heading">
        <div>
          <h2>Activity Timeline</h2>
          <p>Incident and responder events</p>
        </div>
        <span className="panel-count">{events.length}</span>
      </div>
      <div className="activity-list">
        {events.length === 0 ? (
          <p className="empty-state">No activity yet.</p>
        ) : events.map((event) => (
          <div key={event.id} className={`activity-row activity-${event.tone}`}>
            <span className="activity-dot" />
            <div>
              <strong>{event.label}</strong>
              <small>{formatTime(event.ts)}</small>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

export function DashboardShell() {
  const [user, setUser] = useState<User | null>(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [responders, setResponders] = useState<ResponderPin[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedIncidentId, setSelectedIncidentId] = useState<string | null>(null);
  const [crisisActive, setCrisisActive] = useState(false);
  const [crisisLabel, setCrisisLabel] = useState("");
  const seenIdsRef = useRef<Set<string>>(new Set());
  const crisisTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Simulation State
  const [simPositions, setSimPositions] = useState<Record<string, { lat: number; lng: number }>>({});
  useEffect(() => {
    const interval = setInterval(() => {
      setSimPositions(prev => {
        const next = { ...prev };

        responders.filter((r) => !r.disabled).forEach(r => {
          // Initialize if missing
          if (!next[r.id]) {
            next[r.id] = r.lastKnownLocation?.lat ? { lat: r.lastKnownLocation.lat, lng: r.lastKnownLocation.lng! } : {
              lat: CAMPUS_BOUNDS.south + Math.random() * (CAMPUS_BOUNDS.north - CAMPUS_BOUNDS.south),
              lng: CAMPUS_BOUNDS.west + Math.random() * (CAMPUS_BOUNDS.east - CAMPUS_BOUNDS.west)
            };
          }

          // Check for active assignment
          const activeIncident = incidents.find(inc => inc.assignedResponderId === r.id && inc.status === "assigned");

          if (activeIncident && activeIncident.location?.lat && activeIncident.location?.lng) {
            // Move towards incident
            const target = activeIncident.location;
            const speed = 0.00018;
            const dLat = target.lat! - next[r.id].lat;
            const dLng = target.lng! - next[r.id].lng;
            const dist = Math.sqrt(dLat * dLat + dLng * dLng);

            if (dist > speed) {
              next[r.id] = {
                lat: next[r.id].lat + (dLat / dist) * speed,
                lng: next[r.id].lng + (dLng / dist) * speed
              };
            }
          } else {
            // Idle random walk
            const jitter = 0.00005;
            next[r.id] = {
              lat: Math.min(CAMPUS_BOUNDS.north, Math.max(CAMPUS_BOUNDS.south, next[r.id].lat + (Math.random() - 0.5) * jitter)),
              lng: Math.min(CAMPUS_BOUNDS.east, Math.max(CAMPUS_BOUNDS.west, next[r.id].lng + (Math.random() - 0.5) * jitter))
            };
          }
        });

        return next;
      });
    }, 500);

    return () => clearInterval(interval);
  }, [incidents, responders]);

  const triggerCrisisAlert = useCallback((label: string) => {
    setCrisisActive(true);
    setCrisisLabel(label);
    playSirenDebounced();
    if (crisisTimerRef.current) clearTimeout(crisisTimerRef.current);
    crisisTimerRef.current = setTimeout(() => setCrisisActive(false), 8000);
  }, []);

  useEffect(() => {
    return onAuthStateChanged(auth, (next) => {
      setUser(next);
      setLoading(false);
    });
  }, []);

  useEffect(() => {
    if (!user) {
      setIncidents([]);
      setResponders([]);
      return;
    }
    const incidentQuery = query(collection(db, "incidents"), orderBy("createdAt", "desc"), limit(50));
    const incidentUnsubscribe = onSnapshot(incidentQuery, (snapshot) => {
      const rows: Incident[] = snapshot.docs.map((entry) => ({ id: entry.id, ...(entry.data() as Omit<Incident, "id">) }));
      // Detect genuinely new incidents for alert
      const activeStatuses = new Set(["detected", "assigned", "triage_required"]);
      for (const row of rows) {
        if (!seenIdsRef.current.has(row.id) && activeStatuses.has(row.status || "")) {
          const label = row.classification?.enriched || row.classification?.provisional || "New Incident";
          triggerCrisisAlert(label.replaceAll("_", " ").toUpperCase());
          break;
        }
      }
      seenIdsRef.current = new Set(rows.map((r) => r.id));
      setIncidents(rows);
      setSelectedIncidentId((current) => (current && rows.some((row) => row.id === current) ? current : rows[0]?.id || null));
    });

    const responderQuery = query(collection(db, "users"), where("role", "==", "responder"));
    const responderUnsubscribe = onSnapshot(responderQuery, (snapshot) => {
      const rows: ResponderPin[] = snapshot.docs.map((entry) => ({
        id: entry.id,
        ...(entry.data() as Omit<ResponderPin, "id">),
      }));
      setResponders(rows);
    });

    return () => {
      incidentUnsubscribe();
      responderUnsubscribe();
    };
  }, [user]);

  // Patch missing incident locations randomly for demo
  useEffect(() => {
    setSimPositions(prev => {
      const next = { ...prev };
      let changed = false;
      incidents.forEach(inc => {
        const key = `INC-${inc.id}`;
        if (!inc.location?.lat && !next[key]) {
          next[key] = {
            lat: CAMPUS_BOUNDS.south + Math.random() * (CAMPUS_BOUNDS.north - CAMPUS_BOUNDS.south),
            lng: CAMPUS_BOUNDS.west + Math.random() * (CAMPUS_BOUNDS.east - CAMPUS_BOUNDS.west)
          };
          changed = true;
        }
      });
      return changed ? next : prev;
    });
  }, [incidents]);

  const counts = useMemo(() => {
    return {
      triage: incidents.filter((item) => item.status === "triage_required").length,
      detected: incidents.filter((item) => item.status === "detected").length,
      assigned: incidents.filter((item) => item.status === "assigned").length,
      acknowledged: incidents.filter((item) => item.status === "acknowledged").length,
      escalated: incidents.filter((item) => item.status === "unacked_escalation").length,
      resolved: incidents.filter((item) => item.status === "resolved").length,
    };
  }, [incidents]);

  const selectedIncident = incidents.find((incident) => incident.id === selectedIncidentId) || incidents[0] || null;

  async function onSignIn(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    try {
      await signInWithEmailAndPassword(auth, email, password);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Login failed.");
    }
  }

  if (loading) {
    return <main className="shell"><p>Loading...</p></main>;
  }

  if (!user) {
    return (
      <main className="shell">
        <section className="card auth-card">
          <h1>ORCHID SOC Console</h1>
          <p>Sign in with an admin account to monitor incidents and resolve triage.</p>
          <form onSubmit={onSignIn}>
            <label>
              Email
              <input type="email" value={email} onChange={(event) => setEmail(event.target.value)} required />
            </label>
            <label>
              Password
              <input type="password" value={password} onChange={(event) => setPassword(event.target.value)} required />
            </label>
            <button type="submit">Sign In</button>
          </form>
          {error ? <p className="error">{error}</p> : null}
        </section>
      </main>
    );
  }

  return (
    <main className={`shell soc-shell ${crisisActive ? "crisis-active" : ""}`} role="main" aria-label="ORCHID SOC Console">
      {/* Crisis flash overlay and banner */}
      <div className={`crisis-overlay ${crisisActive ? "active" : ""}`} />
      {crisisActive && (
        <div className="crisis-banner" onClick={() => setCrisisActive(false)}>
          <span className="crisis-icon">🚨</span>
          INCIDENT DETECTED — {crisisLabel}
          <span className="crisis-icon">🚨</span>
          <button className="crisis-dismiss" onClick={() => setCrisisActive(false)}>DISMISS</button>
        </div>
      )}

      <header className="topbar soc-topbar" role="banner">
        <div>
          <h1>ORCHID SOC Console</h1>
          <p>Live incident coordination, AI provenance, and responder dispatch.</p>
        </div>
        <div className="topbar-actions">
          <a href="/admin/responders" className="inject-nav-link">Responders</a>
          <a href="/inject" className="inject-nav-link">Live Intake</a>
          <span>{user.email}</span>
          <button onClick={() => signOut(auth)}>Sign Out</button>
        </div>
      </header>

      <section className="stats soc-stats" aria-label="Incident status summary">
        <article className="card stat-triage"><h2>Triage</h2><p>{counts.triage}</p></article>
        <article className="card stat-detected"><h2>Detected</h2><p>{counts.detected}</p></article>
        <article className="card stat-assigned"><h2>Assigned</h2><p>{counts.assigned}</p></article>
        <article className="card stat-acked"><h2>Acknowledged</h2><p>{counts.acknowledged}</p></article>
        <article className={`card ${counts.escalated > 0 ? "stat-escalated" : ""}`}><h2>Escalated</h2><p>{counts.escalated}</p></article>
        <article className="card stat-resolved"><h2>Resolved</h2><p>{counts.resolved}</p></article>
      </section>

      <PerceptionTier />

      {error ? <p className="error inline">{error}</p> : null}

      <div className="soc-layout">
        <IncidentQueue incidents={incidents} selectedId={selectedIncident?.id || null} onSelect={setSelectedIncidentId} />

        <div className="soc-main-column">
          {selectedIncident ? (
            <>
              <section className="card soc-panel incident-detail-panel">
                <div className="panel-heading">
                  <div>
                    <h2>{displayValue(selectedIncident.classification?.enriched || selectedIncident.classification?.provisional || "Unclassified incident")}</h2>
                    <p>{selectedIncident.id}</p>
                  </div>
                  <span className={`severity-badge severity-${selectedIncident.severity?.enriched || selectedIncident.severity?.provisional || "medium"}`}>
                    {(selectedIncident.severity?.enriched || selectedIncident.severity?.provisional || "medium").toUpperCase()}
                  </span>
                </div>
                <div className="incident-timeline">
                  <span>Created {formatTime(selectedIncident.createdAt)}</span>
                  <span>Updated {formatTime(selectedIncident.updatedAt)}</span>
                  <span>Enrichment {displayValue(selectedIncident.enrichmentState || "pending")}</span>
                </div>
              </section>

              {selectedIncident.status === "triage_required" || selectedIncident.triageRequired ? (
                <section className="card soc-panel">
                  <TriagePanel incident={selectedIncident} user={user} onError={setError} />
                </section>
              ) : null}

              <EvidencePanel incident={selectedIncident} />
              <AssignmentPanel incident={selectedIncident} />
            </>
          ) : (
            <section className="card soc-panel"><p className="empty-state">No incident selected.</p></section>
          )}
        </div>

        <aside className="soc-side-column">
          <TacticalMap incidents={incidents} responders={responders} simPositions={simPositions} />
          <section className="card soc-panel">
            <div className="panel-heading">
              <div>
                <h2>Responder Readiness</h2>
                <p>{responders.length} responders registered</p>
              </div>
            </div>
            <div className="responder-list">
              {responders.length === 0 ? <p className="empty-state">No Firestore responders registered.</p> : responders.map((responder) => (
                <div key={responder.id} className="responder-row">
                  <span className={`rsp-dot ${responder.availability === false || responder.disabled ? "offline" : ""}`} />
                  <div>
                    <strong>{responder.displayName || responder.id}</strong>
                    <small>{(responder.skills || ["general"]).map(displayValue).join(", ")} - {lastSeenLabel(responder.updatedAt)}</small>
                  </div>
                  <em>{responder.disabled ? "Disabled" : responder.availability === false ? "Unavailable" : "Available"}</em>
                </div>
              ))}
            </div>
          </section>
          <ActivityTimeline incidents={incidents} responders={responders} />
        </aside>
      </div>
    </main>
  );
}
