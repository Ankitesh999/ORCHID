"use client";

import { useEffect, useMemo, useState } from "react";
import { onAuthStateChanged, signInWithEmailAndPassword, signOut, User } from "firebase/auth";
import { collection, doc, limit, onSnapshot, orderBy, query, updateDoc, where } from "firebase/firestore";

import { auth, db } from "../lib/firebase";
import { Incident } from "../lib/types";

type HazardPin = {
  id: string;
  type: string;
  location: { lat: number; lng: number };
  createdAt: string;
};

const ACK_FUNCTION_URL = process.env.NEXT_PUBLIC_ACK_FUNCTION_URL ?? "";

type ResponderPin = {
  id: string;
  displayName?: string;
  availability?: boolean;
  lastKnownLocation?: {
    lat?: number;
    lng?: number;
  };
};

const CAMPUS_BOUNDS = {
  north: 12.9735,
  south: 12.9695,
  east: 77.5985,
  west: 77.591,
};

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

function percentToLocation(x: number, y: number) {
  const lng = CAMPUS_BOUNDS.west + (x / 100) * (CAMPUS_BOUNDS.east - CAMPUS_BOUNDS.west);
  const lat = CAMPUS_BOUNDS.north - (y / 100) * (CAMPUS_BOUNDS.north - CAMPUS_BOUNDS.south);
  return { lat: Number(lat.toFixed(6)), lng: Number(lng.toFixed(6)) };
}

function formatTime(value?: string | null) {
  if (!value) {
    return "-";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleString();
}

function formatConfidence(value?: number) {
  if (value === undefined || value === null) {
    return "-";
  }
  return value.toFixed(2);
}

export function DashboardShell() {
  const [user, setUser] = useState<User | null>(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [responders, setResponders] = useState<ResponderPin[]>([]);
  const [loading, setLoading] = useState(true);
  const [ackInFlight, setAckInFlight] = useState<string | null>(null);
  const [pinInFlight, setPinInFlight] = useState<string | null>(null);
  const [simulationEditMode, setSimulationEditMode] = useState(false);
  const [selectedResponderId, setSelectedResponderId] = useState<string | null>(null);
  const [baselinePositions, setBaselinePositions] = useState<Record<string, { lat: number; lng: number }>>({});
  const [hazards, setHazards] = useState<HazardPin[]>([]);

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
      const rows: Incident[] = snapshot.docs.map((doc) => ({ id: doc.id, ...(doc.data() as Omit<Incident, "id">) }));
      setIncidents(rows);
    });

    const responderQuery = query(collection(db, "users"), where("role", "==", "responder"));
    const responderUnsubscribe = onSnapshot(responderQuery, (snapshot) => {
      const rows: ResponderPin[] = snapshot.docs.map((entry) => ({
        id: entry.id,
        ...(entry.data() as Omit<ResponderPin, "id">),
      }));
      setResponders(rows);
    });

    const hazardQuery = query(collection(db, "hazards"), orderBy("createdAt", "desc"));
    const hazardUnsubscribe = onSnapshot(hazardQuery, (snapshot) => {
      const rows: HazardPin[] = snapshot.docs.map((doc) => ({
        id: doc.id,
        ...(doc.data() as Omit<HazardPin, "id">),
      }));
      setHazards(rows);
    });

    return () => {
      incidentUnsubscribe();
      responderUnsubscribe();
      hazardUnsubscribe();
    };
  }, [user]);

  useEffect(() => {
    if (!responders.length) {
      return;
    }
    setBaselinePositions((previous) => {
      const next = { ...previous };
      for (const responder of responders) {
        const lat = Number(responder.lastKnownLocation?.lat);
        const lng = Number(responder.lastKnownLocation?.lng);
        if (!Number.isNaN(lat) && !Number.isNaN(lng) && !next[responder.id]) {
          next[responder.id] = { lat, lng };
        }
      }
      return next;
    });
  }, [responders]);

  const counts = useMemo(() => {
    const detected = incidents.filter((item) => item.status === "detected").length;
    const assigned = incidents.filter((item) => item.status === "assigned").length;
    const acked = incidents.filter((item) => item.status === "acknowledged").length;
    const escalated = incidents.filter((item) => item.status === "unacked_escalation").length;
    return { detected, assigned, acked, escalated };
  }, [incidents]);

  async function onSignIn(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    try {
      await signInWithEmailAndPassword(auth, email, password);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Login failed.");
    }
  }

  async function onAcknowledge(incidentId: string) {
    if (!ACK_FUNCTION_URL) {
      setError("NEXT_PUBLIC_ACK_FUNCTION_URL is not configured.");
      return;
    }
    setError(null);
    setAckInFlight(incidentId);
    try {
      const response = await fetch(ACK_FUNCTION_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          incidentId,
          responderId: user?.uid
        })
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(payload.message || `Ack failed (${response.status})`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Ack failed.");
    } finally {
      setAckInFlight(null);
    }
  }

  async function onDropResponder(event: React.DragEvent<HTMLDivElement>) {
    event.preventDefault();
    if (!simulationEditMode) {
      return;
    }
    const responderId = event.dataTransfer.getData("text/responder-id");
    if (!responderId) {
      return;
    }

    const board = event.currentTarget.getBoundingClientRect();
    const x = ((event.clientX - board.left) / board.width) * 100;
    const y = ((event.clientY - board.top) / board.height) * 100;
    const nextLocation = percentToLocation(Math.min(100, Math.max(0, x)), Math.min(100, Math.max(0, y)));

    const hazardType = event.dataTransfer.getData("text/hazard-type");
    if (hazardType) {
      import("firebase/firestore").then(({ addDoc, collection }) => {
        addDoc(collection(db, "hazards"), {
          type: hazardType,
          location: nextLocation,
          createdAt: new Date().toISOString()
        }).catch(err => setError(err.message));
      });
      return;
    }

    const responderId = event.dataTransfer.getData("text/responder-id");
    if (!responderId) {
      return;
    }

    setPinInFlight(responderId);
    try {
      await updateDoc(doc(db, "users", responderId), {
        lastKnownLocation: nextLocation,
        updatedAt: new Date().toISOString(),
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update responder location.");
    } finally {
      setPinInFlight(null);
    }
  }

  async function onResetSimulation() {
    const updates = responders
      .map((responder) => ({
        responderId: responder.id,
        location: baselinePositions[responder.id],
      }))
      .filter((item) => item.location);

    if (!updates.length) {
      return;
    }

    setPinInFlight("resetting");
    try {
      await Promise.all(
        updates.map((item) =>
          updateDoc(doc(db, "users", item.responderId), {
            lastKnownLocation: item.location,
            updatedAt: new Date().toISOString(),
          })
        )
      );
      setSelectedResponderId(null);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to reset simulation positions.");
    } finally {
      setPinInFlight(null);
    }
  }

  function onClearVisualStatus() {
    setSelectedResponderId(null);
    setError(null);
  }

  if (loading) {
    return <main className="shell"><p>Loading...</p></main>;
  }

  if (!user) {
    return (
      <main className="shell">
        <section className="card auth-card">
          <h1>ORCHID Dashboard</h1>
          <p>Sign in with an admin account to view incidents.</p>
          <form onSubmit={onSignIn}>
            <label>
              Email
              <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
            </label>
            <label>
              Password
              <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required />
            </label>
            <button type="submit">Sign In</button>
          </form>
          {error ? <p className="error">{error}</p> : null}
        </section>
      </main>
    );
  }

  return (
    <main className="shell">
      <header className="topbar">
        <div>
          <h1>ORCHID SOC Dashboard</h1>
          <p>Realtime incident blackboard with async enrichment and retry loop.</p>
        </div>
        <div className="topbar-actions">
          <span>{user.email}</span>
          <button onClick={() => signOut(auth)}>Sign Out</button>
        </div>
      </header>

      <section className="stats">
        <article className="card"><h2>Detected</h2><p>{counts.detected}</p></article>
        <article className="card"><h2>Assigned</h2><p>{counts.assigned}</p></article>
        <article className="card"><h2>Acknowledged</h2><p>{counts.acked}</p></article>
        <article className="card"><h2>Escalated</h2><p>{counts.escalated}</p></article>
      </section>

      {error ? <p className="error inline">{error}</p> : null}

      <section className="card simulation-card">
        <div className="simulation-head">
          <div>
            <h2>Responder Simulation</h2>
            <p>Drag pins to simulate live staff movement. Drag hazards to create dynamic zones.</p>
          </div>
          <div className="simulation-controls">
            <div className="hazard-palette" style={{ display: simulationEditMode ? 'flex' : 'none', gap: '8px' }}>
              <div draggable onDragStart={(e) => e.dataTransfer.setData("text/hazard-type", "fire")} className="sim-pin sim-pin-hazard" title="Drag to add Fire Hazard">🔥</div>
              <div draggable onDragStart={(e) => e.dataTransfer.setData("text/hazard-type", "spill")} className="sim-pin sim-pin-hazard" title="Drag to add Spill Hazard">💧</div>
            </div>
            <button type="button" onClick={() => setSimulationEditMode((value) => !value)}>
              {simulationEditMode ? "Stop Edit Mode" : "Start Edit Mode"}
            </button>
            <button type="button" className="button-subtle" onClick={onResetSimulation}>
              Reset Pins
            </button>
            <button type="button" className="button-subtle" onClick={onClearVisualStatus}>
              Clear Visuals
            </button>
          </div>
        </div>
        <div className="simulation-board" onDragOver={(event) => event.preventDefault()} onDrop={onDropResponder}>
          {responders.map((responder) => {
            const point = locationToPercent(responder.lastKnownLocation);
            return (
              <button
                key={responder.id}
                className={`sim-pin ${responder.availability === false ? "sim-pin-offline" : ""} ${selectedResponderId === responder.id ? "sim-pin-selected" : ""}`}
                style={{ left: `${point.x}%`, top: `${point.y}%` }}
                draggable={simulationEditMode}
                onClick={() => setSelectedResponderId(responder.id)}
                onDragStart={(event) => event.dataTransfer.setData("text/responder-id", responder.id)}
                title={`${responder.displayName || responder.id} (${responder.id})`}
              >
                {responder.displayName?.slice(0, 2).toUpperCase() || responder.id.slice(0, 2).toUpperCase()}
              </button>
            );
          })}
          {hazards.map((hazard) => {
            const point = locationToPercent(hazard.location);
            return (
              <div
                key={hazard.id}
                className="sim-pin sim-pin-hazard-placed"
                style={{ left: `${point.x}%`, top: `${point.y}%` }}
                title={`Hazard: ${hazard.type}`}
                onClick={() => {
                  if (simulationEditMode) {
                    import("firebase/firestore").then(({ deleteDoc, doc }) => {
                      deleteDoc(doc(db, "hazards", hazard.id)).catch(console.error);
                    });
                  }
                }}
              >
                {hazard.type === "fire" ? "🔥" : "💧"}
              </div>
            )
          })}
        </div>
        {pinInFlight ? <p className="simulation-note">Updating {pinInFlight} position...</p> : null}
        {!simulationEditMode ? <p className="simulation-note">Edit mode is off. Enable it to move pins.</p> : null}
      </section>

      <section className="card video-feeds-card">
        <h2>Live Perception Tier (Edge Fusion)</h2>
        <p>Real-time mock camera feeds with YOLOv11 bounding boxes and 0.016s detection latency.</p>
        <div className="feeds-grid">
          {[1, 2, 3, 4].map((i) => {
            const isAlertFeed = i === 1;
            const activeIncident = incidents.find(inc => inc.status === "detected" || inc.status === "assigned" || inc.status === "unacked_escalation");
            const showAlert = isAlertFeed && activeIncident;
            return (
              <div key={i} className="video-feed">
                <div className="video-placeholder">Feed {i}</div>
                {showAlert && (
                  <div className="alert-overlay">
                    <div className="bounding-box"></div>
                    <span className="alert-text">DETECTED: {activeIncident.aiDetection?.label?.toUpperCase() || "MEDICAL DISTRESS"} (0.016s)</span>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </section>

      <section className="list">
        {incidents.length === 0 ? (
          <article className="card"><p>No incidents yet.</p></article>
        ) : (
          incidents.map((incident) => (
            <article key={incident.id} className="card incident">
              <div className="incident-head">
                <h3>{incident.id}</h3>
                <span className={`status status-${incident.status || "unknown"}`}>{incident.status || "unknown"}</span>
              </div>
              <p><strong>Camera:</strong> {incident.cameraId || "-"}</p>
              <p><strong>Provisional:</strong> {incident.classification?.provisional || "-"} ({incident.severity?.provisional || "-"})</p>
              <p><strong>Vertex Label:</strong> {incident.aiDetection?.label || "-"}</p>
              <p><strong>Vertex Confidence:</strong> {formatConfidence(incident.aiDetection?.confidence)}</p>
              <p><strong>Required Skill:</strong> {incident.requiredSkill || "-"}</p>
              <p><strong>Severity (Rule):</strong> {incident.severity?.provisional || "-"}</p>
              <p><strong>Enriched:</strong> {incident.classification?.enriched || "-"} ({incident.severity?.enriched || "-"})</p>
              <p><strong>Enrichment State:</strong> {incident.enrichmentState || "-"}</p>
              <p><strong>Evidence:</strong> {incident.aiDetection?.evidenceSummary || "-"}</p>
              <p><strong>Assigned:</strong> {incident.assignedResponderId || "-"}</p>
              <p><strong>Attempt:</strong> {incident.assignmentAttempt || 0} / 3</p>
              <p><strong>Assignment Phase:</strong> {incident.assignmentPhase || "-"}</p>
              <p><strong>Allocation State:</strong> {incident.allocation?.status || "-"}</p>
              <p><strong>Fallback Used:</strong> {incident.allocation?.fallback ? "yes" : "no"}</p>
              <p><strong>Score Reason:</strong> {incident.allocation?.scoreReason || "-"}</p>
              <p><strong>Ack Deadline:</strong> {formatTime(incident.ackDeadline)}</p>
              <p><strong>Acknowledged At:</strong> {formatTime(incident.acknowledgedAt)}</p>
              <p><strong>Retry Eligible At:</strong> {formatTime(incident.retryEligibleAt)}</p>
              <p><strong>Snapshot:</strong> {incident.allocation?.inputSnapshot?.respondersEvaluated ?? 0} responders, skill {incident.allocation?.inputSnapshot?.requiredSkill || "-"}, severity {incident.allocation?.inputSnapshot?.severity || "-"}, confidence {formatConfidence(incident.allocation?.inputSnapshot?.confidence)}</p>
              <p><strong>Snapshot Evaluated:</strong> {formatTime(incident.allocation?.inputSnapshot?.evaluatedAt)}</p>
              {(incident.allocation?.topCandidates || []).slice(0, 3).map((candidate) => (
                <p key={`${incident.id}-${candidate.id}`}>
                  <strong>Candidate:</strong> {candidate.id} | score {candidate.score.toFixed(6)} | distance {candidate.distanceMeters ?? "-"}m | qualified {candidate.qualified ? "yes" : "no"} | rejected {candidate.rejectedReason || "-"}
                </p>
              ))}
              <p><strong>Created:</strong> {formatTime(incident.createdAt)}</p>
              <p><strong>Updated:</strong> {formatTime(incident.updatedAt)}</p>
              {incident.summary ? <p><strong>Summary:</strong> {incident.summary}</p> : null}
              {incident.tacticalReasoning ? (
                <>
                  <p><strong>Tactical Approach:</strong> {incident.tacticalReasoning.safeApproach || "-"}</p>
                  <p><strong>Hazards:</strong> {(incident.tacticalReasoning.hazards || []).join(", ") || "-"}</p>
                  <p><strong>Priority Actions:</strong> {(incident.tacticalReasoning.priorityActions || []).join(", ") || "-"}</p>
                </>
              ) : null}
              <div className="incident-actions">
                <button
                  onClick={() => onAcknowledge(incident.id)}
                  disabled={incident.status !== "assigned" || ackInFlight === incident.id}
                >
                  {ackInFlight === incident.id ? "Acknowledging..." : "Acknowledge"}
                </button>
              </div>
            </article>
          ))
        )}
      </section>
    </main>
  );
}
