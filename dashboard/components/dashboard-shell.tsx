"use client";

import { useEffect, useMemo, useRef, useState, useCallback } from "react";
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

// ─── PERCEPTION TIER ────────────────────────────────────────────────────────

type PerceptionFeedConfig = {
  id: string;
  cameraId: string;
  label: string;
  sensorType: "camera" | "acoustic" | "vitals" | "clear";
  sensorIcon: string;
  zone: string;
};

const FEEDS: PerceptionFeedConfig[] = [
  { id: "f1", cameraId: "cam-lobby-01",    label: "CAM-LOBBY-01",    sensorType: "camera",  sensorIcon: "📷", zone: "Lobby" },
  { id: "f2", cameraId: "mic-hallway-02",  label: "MIC-HALLWAY-02", sensorType: "acoustic", sensorIcon: "🎙️", zone: "Hallway" },
  { id: "f3", cameraId: "wearable-user-09",label: "WEARABLE-09",    sensorType: "vitals",  sensorIcon: "❤️", zone: "Floor 2" },
  { id: "f4", cameraId: "cam-entrance-03", label: "CAM-ENTRANCE-03",sensorType: "clear",   sensorIcon: "📷", zone: "Entrance" },
];

function useConfidenceMeter(isAlert: boolean) {
  const [confidence, setConfidence] = useState(Math.random() * 20 + 8);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (intervalRef.current) clearInterval(intervalRef.current);
    if (isAlert) {
      // Spike to high confidence
      setConfidence(Math.random() * 12 + 85);
      intervalRef.current = setInterval(() => {
        setConfidence(Math.random() * 12 + 85);
      }, 800);
    } else {
      setConfidence(Math.random() * 18 + 8);
      intervalRef.current = setInterval(() => {
        setConfidence((prev) => {
          const next = prev + (Math.random() - 0.5) * 6;
          return Math.min(35, Math.max(5, next));
        });
      }, 1200);
    }
    return () => { if (intervalRef.current) clearInterval(intervalRef.current); };
  }, [isAlert]);

  return confidence;
}

function CameraFeedAlert({ incident }: { incident: { aiDetection?: { label?: string; confidence?: number }; id: string } }) {
  return (
    <div className="alert-overlay">
      <div className="bounding-box" />
      <span className="alert-text">detected: {incident.aiDetection?.label?.toUpperCase() || "INCIDENT"}</span>
      <div className="feed-confidence-bar-active" style={{ width: `${((incident.aiDetection?.confidence ?? 0.9) * 100).toFixed(0)}%` }} />
    </div>
  );
}

function AcousticWaveform({ active }: { active: boolean }) {
  const bars = Array.from({ length: 20 }, (_, i) => i);
  return (
    <div className="acoustic-waveform">
      {bars.map((i) => (
        <div
          key={i}
          className={`waveform-bar ${active ? "waveform-bar-active" : ""}`}
          style={{
            animationDelay: `${i * 0.06}s`,
            animationDuration: active ? `${0.3 + Math.random() * 0.4}s` : `${1 + Math.random() * 1.5}s`,
          }}
        />
      ))}
    </div>
  );
}

function VitalsFeed({ active }: { active: boolean }) {
  return (
    <div className="vitals-feed">
      <svg viewBox="0 0 200 60" className={`vitals-svg ${active ? "vitals-svg-alert" : ""}`}>
        {active ? (
          <polyline
            className="vitals-line vitals-line-spike"
            points="0,30 20,30 30,30 40,5 50,55 60,30 80,30 100,30 110,30 120,8 130,52 140,30 160,30 180,30 200,30"
          />
        ) : (
          <>
            <polyline className="vitals-line" points="0,30 40,30 50,22 60,38 70,30 120,30 130,24 140,36 150,30 200,30" />
            <circle className="vitals-dot" cx="50" cy="22" r="2" />
          </>
        )}
      </svg>
      <span className={`vitals-label ${active ? "vitals-label-alert" : ""}`}>
        {active ? "⚠ ANOMALY" : "NOMINAL"}
      </span>
    </div>
  );
}

function PerceptionFeedCard({ feed, activeIncident }: {
  feed: PerceptionFeedConfig;
  activeIncident: Incident | undefined;
}) {
  const isAlert = !!activeIncident && feed.sensorType !== "clear";
  const confidence = useConfidenceMeter(isAlert);

  return (
    <div className={`video-feed pf-card ${isAlert ? "pf-card-alert" : ""}`}>
      {/* Header bar */}
      <div className="pf-header">
        <div className="pf-header-left">
          <span className="pf-live-dot" />
          <span className="pf-label">{feed.label}</span>
        </div>
        <div className="pf-header-right">
          <span className="pf-sensor-icon">{feed.sensorIcon}</span>
          <span className="pf-zone">{feed.zone}</span>
        </div>
      </div>

      {/* Feed body */}
      {feed.sensorType === "camera" && (
        <div className="video-placeholder pf-camera-bg">
          <div className="pf-scanlines" />
          {isAlert ? (
            <CameraFeedAlert incident={activeIncident!} />
          ) : (
            <span className="pf-idle-text">NO ANOMALY</span>
          )}
        </div>
      )}
      {feed.sensorType === "acoustic" && (
        <div className="video-placeholder pf-acoustic-bg">
          {isAlert && <div className="pf-alert-border" />}
          <AcousticWaveform active={isAlert} />
          {isAlert && <span className="alert-text" style={{ top: 'auto', bottom: 8 }}>ACOUSTIC DISTRESS</span>}
        </div>
      )}
      {feed.sensorType === "vitals" && (
        <div className="video-placeholder pf-vitals-bg">
          {isAlert && <div className="pf-alert-border" />}
          <VitalsFeed active={isAlert} />
          {isAlert && <span className="alert-text" style={{ top: 'auto', bottom: 8 }}>HR ANOMALY</span>}
        </div>
      )}
      {feed.sensorType === "clear" && (
        <div className="video-placeholder pf-clear-bg">
          <span className="pf-clear-label">✓ ALL CLEAR</span>
        </div>
      )}

      {/* Confidence meter footer */}
      <div className="pf-footer">
        <span className="pf-conf-label">CONF</span>
        <div className="pf-conf-track">
          <div
            className={`pf-conf-fill ${isAlert ? "pf-conf-fill-alert" : ""}`}
            style={{ width: `${confidence.toFixed(1)}%` }}
          />
        </div>
        <span className={`pf-conf-pct ${isAlert ? "pf-conf-pct-alert" : ""}`}>
          {confidence.toFixed(0)}%
        </span>
      </div>
    </div>
  );
}

function PerceptionTier({ incidents }: { incidents: Incident[] }) {
  const activeIncident = incidents.find(
    (inc) => inc.status === "detected" || inc.status === "assigned" || inc.status === "unacked_escalation"
  );

  return (
    <section className="card video-feeds-card">
      <div className="pf-section-head">
        <div>
          <h2>📡 Live Perception Tier <span className="pf-subtitle">Edge Fusion</span></h2>
          <p style={{ color: 'var(--muted)', fontSize: '13px', margin: '2px 0 0' }}>
            YOLOv11 · Acoustic classifier · BLE vitals gateway — 0.016s detection latency
          </p>
        </div>
        <div className="pf-status-pills">
          <span className="pf-pill pf-pill-green">📷 2 CAMERAS</span>
          <span className="pf-pill pf-pill-purple">🎙️ ACOUSTIC</span>
          <span className="pf-pill pf-pill-red">❤️ VITALS</span>
        </div>
      </div>
      <div className="feeds-grid">
        {FEEDS.map((feed) => (
          <PerceptionFeedCard key={feed.id} feed={feed} activeIncident={activeIncident} />
        ))}
      </div>
    </section>
  );
}

// ─── END PERCEPTION TIER ────────────────────────────────────────────────────

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

  const hasCrisis = incidents.some(
    (inc) => inc.status === "unacked_escalation" || inc.status === "detected" || inc.status === "assigned"
  );

  return (
    <main className={`shell ${hasCrisis ? "crisis-active" : ""}`}>
      {hasCrisis && (
        <>
          <div className="crisis-overlay active" />
          <div className="crisis-banner">
            <span className="crisis-icon">⚠</span>
            ACTIVE CRISIS — {counts.detected + counts.assigned + counts.escalated} INCIDENT{(counts.detected + counts.assigned + counts.escalated) !== 1 ? "S" : ""} REQUIRE ATTENTION
            <span className="crisis-icon">⚠</span>
          </div>
        </>
      )}

      <header className="topbar">
        <div>
          <h1>ORCHID SOC Dashboard</h1>
          <p>Realtime crisis command &amp; control with AI enrichment and decentralised response.</p>
        </div>
        <div className="topbar-actions">
          <a href="/inject" className="inject-pill-link">⚡ Crisis Injector</a>
          <span>{user.email}</span>
          <button onClick={() => signOut(auth)}>Sign Out</button>
        </div>
      </header>

      <section className="stats">
        <article className="card stat-detected"><h2>Detected</h2><p>{counts.detected}</p></article>
        <article className="card stat-assigned"><h2>Assigned</h2><p>{counts.assigned}</p></article>
        <article className="card stat-acked"><h2>Acknowledged</h2><p>{counts.acked}</p></article>
        <article className={`card ${counts.escalated > 0 ? "stat-escalated" : ""}`}><h2>Escalated</h2><p>{counts.escalated}</p></article>
      </section>

      {error ? <p className="error inline">{error}</p> : null}

      <section className="card simulation-card">
        <div className="simulation-head">
          <div>
            <h2>🗺️ Responder Simulation</h2>
            <p>Drag pins to simulate live staff movement. Drag hazards to create dynamic zones.</p>
          </div>
          <div className="simulation-controls">
            <div className="hazard-palette" style={{ display: simulationEditMode ? 'flex' : 'none', gap: '8px' }}>
              <div draggable onDragStart={(e) => { e.dataTransfer.setData("text/hazard-type", "fire"); e.dataTransfer.setData("text/responder-id", ""); }} className="sim-pin sim-pin-hazard" title="Drag to add Fire Hazard">🔥</div>
              <div draggable onDragStart={(e) => { e.dataTransfer.setData("text/hazard-type", "spill"); e.dataTransfer.setData("text/responder-id", ""); }} className="sim-pin sim-pin-hazard" title="Drag to add Spill Hazard">💧</div>
            </div>
            <button type="button" onClick={() => setSimulationEditMode((value) => !value)}>
              {simulationEditMode ? "🔒 Lock Map" : "✏️ Edit Mode"}
            </button>
            <button type="button" className="button-subtle" onClick={onResetSimulation}>
              Reset Pins
            </button>
            <button type="button" className="button-subtle" onClick={onClearVisualStatus}>
              Clear
            </button>
          </div>
        </div>
        <div className="simulation-board" onDragOver={(event) => event.preventDefault()} onDrop={onDropResponder}>
          {/* Zone labels */}
          <span className="sim-zone-label" style={{ left: '12%', top: '15%' }}>LOBBY</span>
          <span className="sim-zone-label" style={{ left: '52%', top: '15%' }}>EAST WING</span>
          <span className="sim-zone-label" style={{ left: '12%', top: '62%' }}>CORRIDOR A</span>
          <span className="sim-zone-label" style={{ left: '62%', top: '62%' }}>EXIT BLOCK</span>

          {/* Incident crosshair pins */}
          {incidents
            .filter(inc => inc.location?.lat && inc.location?.lng && (inc.status === 'detected' || inc.status === 'assigned' || inc.status === 'unacked_escalation'))
            .map(inc => {
              const pt = locationToPercent(inc.location as { lat: number; lng: number });
              return (
                <div
                  key={`crosshair-${inc.id}`}
                  className="sim-incident-crosshair"
                  style={{ left: `${pt.x}%`, top: `${pt.y}%` }}
                  title={`Active Incident: ${inc.id}`}
                >
                  <div className="sim-crosshair-ring" />
                  <div className="sim-crosshair-dot" />
                </div>
              );
            })}

          {/* Responder pins */}
          {responders.map((responder) => {
            const point = locationToPercent(responder.lastKnownLocation);
            const isAssignedToActive = incidents.some(
              inc => inc.assignedResponderId === responder.id &&
                (inc.status === 'assigned' || inc.status === 'unacked_escalation')
            );
            return (
              <button
                key={responder.id}
                className={`sim-pin ${
                  responder.availability === false ? "sim-pin-offline" :
                  isAssignedToActive ? "sim-pin-responding" : "sim-pin-available"
                } ${selectedResponderId === responder.id ? "sim-pin-selected" : ""}`}
                style={{ left: `${point.x}%`, top: `${point.y}%` }}
                draggable={simulationEditMode}
                onClick={() => setSelectedResponderId(responder.id)}
                onDragStart={(event) => event.dataTransfer.setData("text/responder-id", responder.id)}
                title={`${responder.displayName || responder.id}${isAssignedToActive ? ' — EN ROUTE' : ''}`}
              >
                {responder.displayName?.slice(0, 2).toUpperCase() || responder.id.slice(0, 2).toUpperCase()}
                {isAssignedToActive && <span className="sim-pin-pulse" />}
              </button>
            );
          })}

          {/* Hazard zones */}
          {hazards.map((hazard) => {
            const point = locationToPercent(hazard.location);
            return (
              <div
                key={hazard.id}
                className={`sim-pin sim-pin-hazard-placed ${hazard.type === 'fire' ? 'sim-hazard-fire' : 'sim-hazard-spill'}`}
                style={{ left: `${point.x}%`, top: `${point.y}%` }}
                title={`Hazard: ${hazard.type} — click to remove`}
                onClick={() => {
                  if (simulationEditMode) {
                    import("firebase/firestore").then(({ deleteDoc, doc }) => {
                      deleteDoc(doc(db, "hazards", hazard.id)).catch(console.error);
                    });
                  }
                }}
              >
                {hazard.type === "fire" ? "🔥" : "💧"}
                <div className="sim-hazard-zone" />
              </div>
            )
          })}
        </div>
        {pinInFlight ? <p className="simulation-note">Updating {pinInFlight} position...</p> : null}
        {!simulationEditMode ? <p className="simulation-note">⬆ Enable edit mode to drag pins and drop hazards.</p> : null}
      </section>

      <PerceptionTier incidents={incidents} />

      <section className="list">
        {incidents.length === 0 ? (
          <article className="card"><p style={{ color: 'var(--muted)' }}>No incidents yet. Trigger one with the edge node script.</p></article>
        ) : (
          incidents.map((incident) => {
            const severity = incident.severity?.provisional || "medium";
            const isEscalated = incident.status === "unacked_escalation";
            const summaryText = incident.summary || "";
            const isErrorSummary = summaryText.toLowerCase().includes("failed") || summaryText.toLowerCase().includes("error");
            return (
              <article key={incident.id} className="card incident" style={isEscalated ? { borderColor: 'rgba(239, 68, 68, 0.4)', boxShadow: '0 0 20px rgba(239, 68, 68, 0.1)' } : undefined}>
                <div className="incident-head">
                  <h3 title={incident.id}>{incident.id}</h3>
                  <span className={`status status-${incident.status || "unknown"}`}>{incident.status || "unknown"}</span>
                </div>

                <div className="incident-grid">
                  <p className="incident-field">
                    <strong>Severity</strong>
                    <span className={`severity-badge severity-${severity}`}>
                      {severity === "critical" ? "🔴" : severity === "high" ? "🟠" : severity === "medium" ? "🔵" : "⚪"} {severity}
                    </span>
                  </p>
                  <p className="incident-field">
                    <strong>Camera / Source</strong>
                    <span className="value">{incident.cameraId || "—"}</span>
                  </p>
                  <p className="incident-field">
                    <strong>Classification</strong>
                    <span className="value">{incident.classification?.provisional || "—"}</span>
                  </p>
                  <p className="incident-field">
                    <strong>Confidence</strong>
                    <span className="value">{formatConfidence(incident.aiDetection?.confidence)}</span>
                  </p>
                  <p className="incident-field">
                    <strong>Required Skill</strong>
                    <span className="value">{incident.requiredSkill || "general"}</span>
                  </p>
                  <p className="incident-field">
                    <strong>Enrichment</strong>
                    <span className="value">{incident.enrichmentState || "—"}</span>
                  </p>

                  {summaryText && (
                    <div className={`incident-summary ${isErrorSummary ? "error-summary" : ""}`}>
                      {isErrorSummary ? "⚠ " : "📋 "}{summaryText}
                    </div>
                  )}

                  {incident.tacticalReasoning && (
                    <div className="tactical-section">
                      <h4>🎯 Tactical Intel</h4>
                      {incident.tacticalReasoning.safeApproach && (
                        <p><strong style={{ color: 'var(--ink-secondary)' }}>Approach:</strong> {incident.tacticalReasoning.safeApproach}</p>
                      )}
                      {(incident.tacticalReasoning.hazards || []).length > 0 && (
                        <div>
                          <strong style={{ fontSize: '11px', color: 'var(--ink-secondary)' }}>Hazards:</strong>
                          <div className="tag-list">{(incident.tacticalReasoning.hazards ?? []).map((h: string, i: number) => <span key={i} className="tag">{h}</span>)}</div>
                        </div>
                      )}
                      {(incident.tacticalReasoning.priorityActions || []).length > 0 && (
                        <div style={{ marginTop: '6px' }}>
                          <strong style={{ fontSize: '11px', color: 'var(--ink-secondary)' }}>Priority Actions:</strong>
                          <div className="tag-list">{(incident.tacticalReasoning.priorityActions ?? []).map((a: string, i: number) => <span key={i} className="tag">{a}</span>)}</div>
                        </div>
                      )}
                    </div>
                  )}

                  <div className="incident-section-label">Assignment Details</div>
                  <p className="incident-field">
                    <strong>Assigned To</strong>
                    <span className="value">{incident.assignedResponderId || "—"}</span>
                  </p>
                  <p className="incident-field">
                    <strong>Phase</strong>
                    <span className="value">{incident.assignmentPhase || "—"}</span>
                  </p>
                  <p className="incident-field">
                    <strong>Attempt</strong>
                    <span className="value">{incident.assignmentAttempt || 0} / 3</span>
                  </p>
                  <p className="incident-field">
                    <strong>Score Reason</strong>
                    <span className="value">{incident.allocation?.scoreReason || "—"}</span>
                  </p>
                  <p className="incident-field">
                    <strong>Fallback</strong>
                    <span className="value">{incident.allocation?.fallback ? "Yes" : "No"}</span>
                  </p>
                  <p className="incident-field">
                    <strong>Evaluated</strong>
                    <span className="value">{incident.allocation?.inputSnapshot?.respondersEvaluated ?? "—"} bids/responders</span>
                  </p>

                  {(incident.allocation?.topCandidates || []).slice(0, 3).map((candidate: any) => (
                    <div key={`${incident.id}-${candidate.id}`} className="candidate-row">
                      <span>👤 {candidate.id?.slice(0, 12) || "—"}</span>
                      <span>Score: {candidate.score?.toFixed(6) ?? "—"}</span>
                      <span>Dist: {candidate.distanceMeters ?? "—"}m</span>
                      <span>{candidate.qualified ? "✅" : "❌"}</span>
                    </div>
                  ))}

                  <div className="incident-section-label">Timeline</div>
                  <p className="incident-field">
                    <strong>Created</strong>
                    <span className="value">{formatTime(incident.createdAt)}</span>
                  </p>
                  <p className="incident-field">
                    <strong>Updated</strong>
                    <span className="value">{formatTime(incident.updatedAt)}</span>
                  </p>
                  <p className="incident-field">
                    <strong>Ack Deadline</strong>
                    <span className="value">{formatTime(incident.ackDeadline)}</span>
                  </p>
                  <p className="incident-field">
                    <strong>Acknowledged</strong>
                    <span className="value">{formatTime(incident.acknowledgedAt)}</span>
                  </p>
                </div>

                <div className="incident-actions">
                  <button
                    onClick={() => onAcknowledge(incident.id)}
                    disabled={incident.status !== "assigned" || ackInFlight === incident.id}
                  >
                    {ackInFlight === incident.id ? "Acknowledging..." : "✓ Acknowledge"}
                  </button>
                </div>
              </article>
            );
          })
        )}
      </section>
    </main>
  );
}
