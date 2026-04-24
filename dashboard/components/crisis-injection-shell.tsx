"use client";

import { useState, useRef } from "react";
import { onAuthStateChanged, signInWithEmailAndPassword, signOut, User } from "firebase/auth";
import { useEffect } from "react";
import { auth } from "../lib/firebase";

const INGEST_URL = process.env.NEXT_PUBLIC_INGEST_FUNCTION_URL ?? "";

type SensorType = "camera" | "acoustic" | "vitals";
type IncidentType = "medical" | "fire" | "intrusion" | "structural" | "chemical";
type Severity = "low" | "medium" | "high" | "critical";

interface SensorConfig {
  label: string;
  icon: string;
  color: string;
  defaultCameraId: string;
  defaultLabel: string;
}

interface IncidentConfig {
  label: string;
  icon: string;
  mockLabel: string;
  defaultSeverity: Severity;
  location: { lat: number; lng: number };
}

const SENSOR_CONFIGS: Record<SensorType, SensorConfig> = {
  camera: {
    label: "Camera",
    icon: "📷",
    color: "#3b82f6",
    defaultCameraId: "cam-lobby-01",
    defaultLabel: "possible_medical_distress",
  },
  acoustic: {
    label: "Acoustic",
    icon: "🎙️",
    color: "#8b5cf6",
    defaultCameraId: "mic-hallway-02",
    defaultLabel: "acoustic_distress_vocalization",
  },
  vitals: {
    label: "Vitals",
    icon: "❤️",
    color: "#ef4444",
    defaultCameraId: "wearable-user-09",
    defaultLabel: "vitals_heart_rate_drop",
  },
};

const INCIDENT_CONFIGS: Record<IncidentType, IncidentConfig> = {
  medical: {
    label: "Medical Emergency",
    icon: "🩺",
    mockLabel: "possible_medical_distress",
    defaultSeverity: "high",
    location: { lat: 12.9717, lng: 77.5947 },
  },
  fire: {
    label: "Fire Detected",
    icon: "🔥",
    mockLabel: "fire_detected",
    defaultSeverity: "critical",
    location: { lat: 12.9722, lng: 77.5952 },
  },
  intrusion: {
    label: "Intrusion Alert",
    icon: "🚨",
    mockLabel: "unauthorized_access_detected",
    defaultSeverity: "high",
    location: { lat: 12.9710, lng: 77.5940 },
  },
  structural: {
    label: "Structural Threat",
    icon: "🏗️",
    mockLabel: "structural_anomaly_detected",
    defaultSeverity: "medium",
    location: { lat: 12.9725, lng: 77.5935 },
  },
  chemical: {
    label: "Chemical Spill",
    icon: "☢️",
    mockLabel: "chemical_spill_detected",
    defaultSeverity: "critical",
    location: { lat: 12.9708, lng: 77.5960 },
  },
};

const SEVERITY_ORDER: Severity[] = ["low", "medium", "high", "critical"];
const SEVERITY_COLORS: Record<Severity, string> = {
  low: "#94a3b8",
  medium: "#60a5fa",
  high: "#f59e0b",
  critical: "#ef4444",
};

type LogEntry = {
  id: string;
  ts: string;
  type: "info" | "success" | "error" | "send";
  msg: string;
};

function iso_now() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

function makeId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function DEFAULT_IMAGE_BASE64() {
  return "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAIUlEQVR4nGP8z0AaYCJRPcOoBmIAE1GqkMCoBmIAyaEEAEAuAR9UPEsJAAAAAElFTkSuQmCC";
}

export function CrisisInjectionShell() {
  const [user, setUser] = useState<User | null>(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [authError, setAuthError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const [sensorType, setSensorType] = useState<SensorType>("camera");
  const [incidentType, setIncidentType] = useState<IncidentType>("medical");
  const [severity, setSeverity] = useState<Severity>("high");
  const [firing, setFiring] = useState(false);
  const [log, setLog] = useState<LogEntry[]>([]);
  const [shotCount, setShotCount] = useState(0);
  const logEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    return onAuthStateChanged(auth, (next) => {
      setUser(next);
      setLoading(false);
    });
  }, []);

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [log]);

  // Auto-set severity from incident config when incident type changes
  useEffect(() => {
    setSeverity(INCIDENT_CONFIGS[incidentType].defaultSeverity);
  }, [incidentType]);

  function appendLog(type: LogEntry["type"], msg: string) {
    setLog((prev) => [
      ...prev,
      { id: makeId(), ts: new Date().toLocaleTimeString("en-US", { hour12: false }), type, msg },
    ]);
  }

  async function onSignIn(event: React.FormEvent) {
    event.preventDefault();
    setAuthError(null);
    try {
      await signInWithEmailAndPassword(auth, email, password);
    } catch (err) {
      setAuthError(err instanceof Error ? err.message : "Login failed.");
    }
  }

  async function fireEvent() {
    if (!INGEST_URL) {
      appendLog("error", "NEXT_PUBLIC_INGEST_FUNCTION_URL is not configured in .env.local");
      return;
    }
    const sensor = SENSOR_CONFIGS[sensorType];
    const incident = INCIDENT_CONFIGS[incidentType];
    const cameraId = sensor.defaultCameraId;
    const requestId = `${cameraId}-${Math.floor(Date.now() / 1000)}-${Math.random().toString(36).slice(2, 10)}`;

    const payload = {
      requestId,
      cameraId,
      timestamp: iso_now(),
      mockLabel: incident.mockLabel,
      imageBase64: DEFAULT_IMAGE_BASE64(),
      imageMimeType: "image/png",
      location: incident.location,
      severityHint: severity,
    };

    setFiring(true);
    appendLog("send", `→ POST ${INGEST_URL.slice(0, 55)}...`);
    appendLog("info", `  sensor=${sensorType} | incident=${incidentType} | severity=${severity}`);
    appendLog("info", `  cameraId=${cameraId} | requestId=${requestId}`);
    appendLog("info", `  mockLabel=${incident.mockLabel}`);

    try {
      const response = await fetch(INGEST_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        appendLog("error", `✗ HTTP ${response.status}: ${data.message || data.error || "Unknown error"}`);
      } else {
        const incidentId = data.incidentId || data.id || "(see Firestore)";
        appendLog("success", `✓ HTTP ${response.status} — Incident created`);
        appendLog("success", `  incidentId: ${incidentId}`);
        appendLog("info", `  status: ${data.status || "detected"} | enrichment: queued`);
        setShotCount((c) => c + 1);
      }
    } catch (err) {
      appendLog("error", `✗ Network error: ${err instanceof Error ? err.message : "fetch failed"}`);
    } finally {
      setFiring(false);
    }
  }

  function clearLog() {
    setLog([]);
  }

  if (loading) {
    return (
      <main className="inject-shell">
        <div className="inject-loading">
          <div className="inject-spinner" />
          <p>Initialising ORCHID...</p>
        </div>
      </main>
    );
  }

  if (!user) {
    return (
      <main className="inject-shell">
        <header className="inject-topbar">
          <div className="inject-topbar-brand">
            <span className="inject-logo">⚡</span>
            <div>
              <h1>ORCHID Crisis Injector</h1>
              <p>Sensor fusion event simulator</p>
            </div>
          </div>
          <a href="/" className="inject-nav-link">← SOC Dashboard</a>
        </header>
        <section className="card inject-auth-card">
          <h2>Admin Sign In</h2>
          <p style={{ color: "var(--muted)", fontSize: "13px", margin: "0 0 16px" }}>
            Sign in with an admin account to fire crisis events.
          </p>
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
          {authError && <p className="error">{authError}</p>}
        </section>
      </main>
    );
  }

  const currentSensor = SENSOR_CONFIGS[sensorType];
  const currentIncident = INCIDENT_CONFIGS[incidentType];

  return (
    <main className="inject-shell">
      <header className="inject-topbar">
        <div className="inject-topbar-brand">
          <span className="inject-logo">⚡</span>
          <div>
            <h1>ORCHID Crisis Injector</h1>
            <p>Sensor fusion event simulator — fire real incidents into Firestore</p>
          </div>
        </div>
        <div className="inject-topbar-right">
          {shotCount > 0 && (
            <span className="inject-shot-badge">{shotCount} fired</span>
          )}
          <span className="inject-user">{user.email}</span>
          <button className="button-subtle" style={{ fontSize: "12px", padding: "7px 14px" }} onClick={() => signOut(auth)}>
            Sign Out
          </button>
          <a href="/" className="inject-nav-link">← SOC Dashboard</a>
        </div>
      </header>

      <div className="inject-layout">

        {/* ===== LEFT PANEL: CONTROLS ===== */}
        <div className="inject-controls-panel">

          {/* SENSOR TYPE */}
          <section className="card inject-section">
            <h3 className="inject-section-title">
              <span className="inject-section-num">01</span>
              Sensor Type
            </h3>
            <p className="inject-section-sub">Which edge device is reporting the anomaly?</p>
            <div className="sensor-selector">
              {(Object.entries(SENSOR_CONFIGS) as [SensorType, SensorConfig][]).map(([key, cfg]) => (
                <button
                  key={key}
                  type="button"
                  className={`sensor-option ${sensorType === key ? "sensor-option-active" : ""}`}
                  style={{ "--sensor-color": cfg.color } as React.CSSProperties}
                  onClick={() => setSensorType(key)}
                >
                  <span className="sensor-option-icon">{cfg.icon}</span>
                  <span className="sensor-option-label">{cfg.label}</span>
                  <span className="sensor-option-id">{cfg.defaultCameraId}</span>
                </button>
              ))}
            </div>
          </section>

          {/* INCIDENT TYPE */}
          <section className="card inject-section">
            <h3 className="inject-section-title">
              <span className="inject-section-num">02</span>
              Incident Type
            </h3>
            <p className="inject-section-sub">What crisis is the sensor reporting?</p>
            <div className="incident-selector">
              {(Object.entries(INCIDENT_CONFIGS) as [IncidentType, IncidentConfig][]).map(([key, cfg]) => (
                <button
                  key={key}
                  type="button"
                  className={`incident-option ${incidentType === key ? "incident-option-active" : ""}`}
                  onClick={() => setIncidentType(key)}
                >
                  <span className="incident-option-icon">{cfg.icon}</span>
                  <span className="incident-option-label">{cfg.label}</span>
                </button>
              ))}
            </div>
          </section>

          {/* SEVERITY */}
          <section className="card inject-section">
            <h3 className="inject-section-title">
              <span className="inject-section-num">03</span>
              Severity Override
            </h3>
            <p className="inject-section-sub">Override the AI-assigned provisional severity.</p>
            <div className="severity-selector">
              {SEVERITY_ORDER.map((sev) => (
                <button
                  key={sev}
                  type="button"
                  className={`severity-option ${severity === sev ? "severity-option-active" : ""}`}
                  style={{ "--sev-color": SEVERITY_COLORS[sev] } as React.CSSProperties}
                  onClick={() => setSeverity(sev)}
                >
                  {sev.toUpperCase()}
                </button>
              ))}
            </div>
            <div className="severity-track">
              <div
                className="severity-fill"
                style={{
                  width: `${((SEVERITY_ORDER.indexOf(severity) + 1) / SEVERITY_ORDER.length) * 100}%`,
                  background: SEVERITY_COLORS[severity],
                }}
              />
            </div>
          </section>

          {/* SUMMARY + FIRE BUTTON */}
          <section className="card inject-section inject-summary-section">
            <h3 className="inject-section-title">
              <span className="inject-section-num">04</span>
              Event Summary
            </h3>
            <div className="inject-summary-grid">
              <div className="inject-summary-row">
                <span className="inject-summary-key">Sensor</span>
                <span className="inject-summary-val" style={{ color: currentSensor.color }}>
                  {currentSensor.icon} {currentSensor.label} — {currentSensor.defaultCameraId}
                </span>
              </div>
              <div className="inject-summary-row">
                <span className="inject-summary-key">Incident</span>
                <span className="inject-summary-val">{currentIncident.icon} {currentIncident.label}</span>
              </div>
              <div className="inject-summary-row">
                <span className="inject-summary-key">mockLabel</span>
                <span className="inject-summary-val inject-mono">{currentIncident.mockLabel}</span>
              </div>
              <div className="inject-summary-row">
                <span className="inject-summary-key">Severity</span>
                <span className="inject-summary-val" style={{ color: SEVERITY_COLORS[severity], fontWeight: 700 }}>
                  {severity.toUpperCase()}
                </span>
              </div>
              <div className="inject-summary-row">
                <span className="inject-summary-key">Location</span>
                <span className="inject-summary-val inject-mono">
                  {currentIncident.location.lat}, {currentIncident.location.lng}
                </span>
              </div>
              <div className="inject-summary-row">
                <span className="inject-summary-key">Endpoint</span>
                <span className="inject-summary-val inject-mono" style={{ fontSize: "11px", color: "var(--muted)" }}>
                  {INGEST_URL ? INGEST_URL.slice(0, 42) + "…" : "⚠ INGEST URL not set"}
                </span>
              </div>
            </div>

            <button
              className={`inject-fire-button ${firing ? "inject-fire-button-firing" : ""}`}
              onClick={fireEvent}
              disabled={firing || !INGEST_URL}
            >
              {firing ? (
                <>
                  <span className="inject-fire-spinner" />
                  Transmitting...
                </>
              ) : (
                <>
                  <span>{currentSensor.icon}</span>
                  Fire {currentIncident.icon} {currentIncident.label} Event
                </>
              )}
            </button>

            {!INGEST_URL && (
              <p className="inject-url-warning">
                ⚠ Set <code>NEXT_PUBLIC_INGEST_FUNCTION_URL</code> in <code>.env.local</code> to enable firing.
              </p>
            )}
          </section>
        </div>

        {/* ===== RIGHT PANEL: LIVE LOG ===== */}
        <div className="inject-log-panel">
          <div className="inject-log-header">
            <div>
              <h3>📟 Live Response Log</h3>
              <p>Cloud Function responses and incident lifecycle events</p>
            </div>
            <button className="button-subtle" style={{ fontSize: "12px", padding: "6px 12px" }} onClick={clearLog}>
              Clear
            </button>
          </div>

          <div className="inject-log-terminal">
            {log.length === 0 ? (
              <div className="inject-log-empty">
                <span className="inject-log-cursor">_</span>
                <span style={{ color: "var(--muted)", fontSize: "13px" }}>
                  Awaiting first event. Fire a crisis to begin.
                </span>
              </div>
            ) : (
              log.map((entry) => (
                <div key={entry.id} className={`inject-log-line inject-log-${entry.type}`}>
                  <span className="inject-log-ts">{entry.ts}</span>
                  <span className="inject-log-msg">{entry.msg}</span>
                </div>
              ))
            )}
            <div ref={logEndRef} />
          </div>

          {/* SENSOR FUSION LEGEND */}
          <div className="card inject-legend-card">
            <h4 className="inject-legend-title">Sensor Fusion Architecture</h4>
            <div className="inject-legend-grid">
              <div className="inject-legend-item">
                <span className="inject-legend-dot" style={{ background: "#3b82f6" }} />
                <div>
                  <div className="inject-legend-name">📷 Camera Edge Node</div>
                  <div className="inject-legend-desc">YOLOv11 visual anomaly detection · 16ms latency · cam-lobby-01, cam-entrance-03</div>
                </div>
              </div>
              <div className="inject-legend-item">
                <span className="inject-legend-dot" style={{ background: "#8b5cf6" }} />
                <div>
                  <div className="inject-legend-name">🎙️ Acoustic Mesh Node</div>
                  <div className="inject-legend-desc">Distress vocalization + glass-break classifier · mic-hallway-02</div>
                </div>
              </div>
              <div className="inject-legend-item">
                <span className="inject-legend-dot" style={{ background: "#ef4444" }} />
                <div>
                  <div className="inject-legend-name">❤️ Wearable Vitals Node</div>
                  <div className="inject-legend-desc">Heart-rate + SpO₂ anomaly via BLE gateway · wearable-user-09</div>
                </div>
              </div>
              <div className="inject-legend-item">
                <span className="inject-legend-dot" style={{ background: "#22c55e" }} />
                <div>
                  <div className="inject-legend-name">☁️ Gemini Enrichment</div>
                  <div className="inject-legend-desc">Multimodal scene reasoning · tactical brief generation · severity calibration</div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </main>
  );
}
