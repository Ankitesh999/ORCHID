"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { collection, doc, limit, onSnapshot, query, setDoc, updateDoc, where } from "firebase/firestore";
import { User, onAuthStateChanged, signInWithEmailAndPassword, signOut } from "firebase/auth";

import { auth, db } from "../lib/firebase";
import { Incident } from "../lib/types";
import { RouteMap } from "./route-map";
import { enqueuePendingAck, flushPendingAcks, listPendingAcks } from "../lib/offline-ack-queue";
import { playSirenDebounced } from "../lib/siren";

const ACK_FUNCTION_URL = process.env.NEXT_PUBLIC_ACK_FUNCTION_URL ?? "";

type ResponderProfile = {
  uid: string;
  displayName?: string;
  email?: string;
  role?: string;
  lastKnownLocation?: {
    lat?: number;
    lng?: number;
  };
  skills?: string[];
  availability?: boolean;
  updatedAt?: string;
};

type HazardPin = {
  id: string;
  type: string;
  location: { lat: number; lng: number };
  createdAt: string;
};

function formatTime(value?: string | null) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleTimeString();
}

function displayValue(value?: string | null) {
  if (!value) return "-";
  return value.replaceAll("_", " ");
}

function haversineMeters(lat1: number, lng1: number, lat2: number, lng2: number) {
  const R = 6371e3;
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLng = (lng2 - lng1) * rad;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * rad) * Math.cos(lat2 * rad) *
    Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function AckCountdownRing({ ackDeadline }: { ackDeadline?: string | null }) {
  const totalSeconds = 15;
  const [secondsLeft, setSecondsLeft] = useState<number | null>(null);

  useEffect(() => {
    if (!ackDeadline) {
      setSecondsLeft(null);
      return;
    }
    const deadline = new Date(ackDeadline).getTime();
    function tick() {
      setSecondsLeft(Math.max(0, (deadline - Date.now()) / 1000));
    }
    tick();
    const id = setInterval(tick, 500);
    return () => clearInterval(id);
  }, [ackDeadline]);

  if (secondsLeft === null) return null;

  const pct = Math.min(1, secondsLeft / totalSeconds);
  const radius = 44;
  const circumference = 2 * Math.PI * radius;
  const dashOffset = circumference * (1 - pct);
  const color = pct > 0.5 ? "#22c55e" : pct > 0.25 ? "#f59e0b" : "#ef4444";

  return (
    <div className="ack-ring-wrapper" aria-label={`${Math.ceil(secondsLeft)} seconds left to acknowledge`}>
      <svg className="ack-ring-svg" viewBox="0 0 100 100">
        <circle cx="50" cy="50" r={radius} fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth="7" />
        <circle
          cx="50"
          cy="50"
          r={radius}
          fill="none"
          stroke={color}
          strokeWidth="7"
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={dashOffset}
          style={{ transform: "rotate(-90deg)", transformOrigin: "50% 50%" }}
        />
        <text x="50" y="47" textAnchor="middle" fill={color} fontSize="20" fontWeight="800">
          {secondsLeft <= 0 ? "0" : Math.ceil(secondsLeft)}
        </text>
        <text x="50" y="62" textAnchor="middle" fill="rgba(255,255,255,0.48)" fontSize="8">
          SEC
        </text>
      </svg>
    </div>
  );
}

function FieldTaskCard({
  incident,
  ackInFlight,
  resolveInFlight,
  distanceMeters,
  effectiveLocation,
  onAck,
  onResolve,
}: {
  incident: Incident;
  ackInFlight: string | null;
  resolveInFlight: string | null;
  distanceMeters: number | null;
  effectiveLocation: { lat: number; lng: number } | null;
  onAck: (id: string) => void;
  onResolve: (incident: Incident) => void;
}) {
  const severity = incident.severity?.enriched || incident.severity?.provisional || "medium";
  const classification = incident.classification?.enriched || incident.classification?.provisional || "Incident";
  const isAssigned = incident.status === "assigned";
  const canResolve = ["assigned", "acknowledged"].includes(String(incident.status)) && distanceMeters !== null && distanceMeters <= 50 && !!effectiveLocation;
  const etaMinutes = distanceMeters === null ? null : Math.max(1, Math.ceil(distanceMeters / 80));
  const progress = distanceMeters === null ? 0 : Math.max(0, Math.min(100, 100 - (distanceMeters / 500) * 100));

  return (
    <article className="card responder-incident field-task-card">
      <div className="field-task-header">
        <div>
          <span className="field-label">Current assignment</span>
          <h2>{displayValue(classification)}</h2>
          <p>{incident.id}</p>
        </div>
        <span className={`severity-badge severity-${severity}`}>{severity.toUpperCase()}</span>
      </div>

      <div className="field-task-body">
        <AckCountdownRing ackDeadline={incident.ackDeadline} />
        <div className="field-task-grid">
          <p><strong>Status</strong><span>{displayValue(incident.status)}</span></p>
          <p><strong>Required skill</strong><span>{displayValue(incident.requiredSkill || "general")}</span></p>
          <p><strong>Ack deadline</strong><span>{formatTime(incident.ackDeadline)}</span></p>
          <p><strong>AI state</strong><span>{displayValue(incident.aiState || "completed")}</span></p>
          <p><strong>Distance</strong><span>{distanceMeters === null ? "Waiting for GPS" : `${Math.round(distanceMeters)} m`}</span></p>
          <p><strong>ETA</strong><span>{etaMinutes === null ? "-" : `${etaMinutes} min`}</span></p>
        </div>
      </div>

      <div className="eta-panel">
        <div className="eta-track">
          <span style={{ width: `${progress}%` }} />
        </div>
        <small>{distanceMeters !== null && distanceMeters <= 50 ? "Arrival geofence reached" : "Move within 50 m to resolve"}</small>
      </div>

      {incident.aiDetection?.evidenceSummary && (
        <div className="field-brief">
          <strong>Evidence</strong>
          <p>{incident.aiDetection.evidenceSummary}</p>
        </div>
      )}

      {(incident.tacticalReasoning?.priorityActions?.length ?? 0) > 0 && (
        <div className="field-brief">
          <strong>Priority actions</strong>
          <div className="tactical-actions-pills">
            {(incident.tacticalReasoning?.priorityActions ?? []).map((action) => (
              <span key={action} className="tactical-action-pill">{action}</span>
            ))}
          </div>
        </div>
      )}

      {incident.tacticalReasoning?.safeApproach && (
        <div className="field-brief">
          <strong>Approach</strong>
          <p>{incident.tacticalReasoning.safeApproach}</p>
        </div>
      )}

      <button
        className="accept-button"
        onClick={() => onAck(incident.id)}
        disabled={!isAssigned || ackInFlight === incident.id}
      >
        {ackInFlight === incident.id ? "Sending acceptance..." : isAssigned ? "Accept Assignment" : `Status: ${displayValue(incident.status)}`}
      </button>
      <button
        className="resolve-button"
        onClick={() => onResolve(incident)}
        disabled={!canResolve || resolveInFlight === incident.id}
      >
        {resolveInFlight === incident.id ? "Resolving..." : canResolve ? "Mark Resolved" : "Resolve Locked"}
      </button>
    </article>
  );
}

function IncidentReportForm({
  incident,
  user,
  onError,
}: {
  incident: Incident;
  user: User;
  onError: (message: string | null) => void;
}) {
  const [situation, setSituation] = useState("");
  const [actionsTaken, setActionsTaken] = useState("");
  const [additionalResourcesNeeded, setAdditionalResourcesNeeded] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  async function submitReport(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true);
    onError(null);
    try {
      const now = new Date().toISOString();
      await setDoc(doc(db, "incidents", incident.id, "reports", user.uid), {
        responderId: user.uid,
        situation,
        actionsTaken,
        additionalResourcesNeeded,
        createdAt: now,
        updatedAt: now,
      }, { merge: true });
      setSaved(true);
    } catch (err) {
      onError(err instanceof Error ? err.message : "Report save failed.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="card incident-report-card">
      <div className="panel-heading">
        <div>
          <h2>Post-Arrival Report</h2>
          <p>{incident.id}</p>
        </div>
        {saved && <span className="admin-status admin-status-online">Saved</span>}
      </div>
      <form onSubmit={submitReport}>
        <label>Actual situation <textarea value={situation} onChange={(event) => setSituation(event.target.value)} required /></label>
        <label>Actions taken <textarea value={actionsTaken} onChange={(event) => setActionsTaken(event.target.value)} required /></label>
        <label>Additional resources needed <textarea value={additionalResourcesNeeded} onChange={(event) => setAdditionalResourcesNeeded(event.target.value)} /></label>
        <button type="submit" disabled={saving}>{saving ? "Saving..." : "Submit Report"}</button>
      </form>
    </section>
  );
}

export function ResponderShell() {
  const [user, setUser] = useState<User | null>(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [profile, setProfile] = useState<ResponderProfile | null>(null);
  const [ackInFlight, setAckInFlight] = useState<string | null>(null);
  const [isOnline, setIsOnline] = useState<boolean>(typeof navigator === "undefined" ? true : navigator.onLine);
  const [pendingCount, setPendingCount] = useState(0);
  const [currentLocation, setCurrentLocation] = useState<{ lat: number; lng: number } | null>(null);
  const [geoError, setGeoError] = useState<string | null>(null);
  const [resolveInFlight, setResolveInFlight] = useState<string | null>(null);
  const [hazards, setHazards] = useState<HazardPin[]>([]);
  const [crisisActive, setCrisisActive] = useState(false);
  const [crisisLabel, setCrisisLabel] = useState("");
  const biddedIncidents = useRef<Set<string>>(new Set());
  const seenAssignedRef = useRef<Set<string>>(new Set());
  const crisisTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastPresenceWriteRef = useRef(0);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (next) => {
      setUser(next);
      setLoading(false);
      if (!next) {
        setProfile(null);
        setIncidents([]);
        return;
      }
      const token = await next.getIdTokenResult(true).catch(() => null);
      const role = token?.claims?.role;
      setError(role !== "responder" && role !== "admin" ? "This account is not authorized for responder mode." : null);
    });
    return () => unsubscribe();
  }, []);

  useEffect(() => {
    if (!user) return;
    const unsubProfile = onSnapshot(doc(db, "users", user.uid), (snap) => {
      if (!snap.exists()) {
        setProfile({ uid: user.uid, role: "responder" });
        return;
      }
      const data = snap.data();
      setProfile({
        uid: user.uid,
        role: String(data.role || "responder"),
        displayName: data.displayName,
        email: data.email,
        lastKnownLocation: data.lastKnownLocation,
        skills: data.skills,
        availability: data.availability,
        updatedAt: data.updatedAt,
      });
    });

    const incidentQuery = query(collection(db, "incidents"), where("assignedResponderId", "==", user.uid), limit(20));
    const unsubIncidents = onSnapshot(
      incidentQuery,
      (snapshot) => {
        const rows: Incident[] = snapshot.docs
          .map((item) => ({ id: item.id, ...(item.data() as Omit<Incident, "id">) }))
          .sort((a, b) => Date.parse(String(b.createdAt || 0)) - Date.parse(String(a.createdAt || 0)));
        // Detect new assignments for alert
        for (const row of rows) {
          if (row.status === "assigned" && !seenAssignedRef.current.has(row.id)) {
            const label = row.classification?.enriched || row.classification?.provisional || "New Assignment";
            setCrisisActive(true);
            setCrisisLabel(label.replaceAll("_", " ").toUpperCase());
            playSirenDebounced();
            if (crisisTimerRef.current) clearTimeout(crisisTimerRef.current);
            crisisTimerRef.current = setTimeout(() => setCrisisActive(false), 8000);
            break;
          }
        }
        seenAssignedRef.current = new Set(rows.map((r) => r.id));
        setIncidents(rows);
      },
      (err) => setError(`Failed to load assignments: ${err.message}`)
    );
    return () => {
      unsubProfile();
      unsubIncidents();
    };
  }, [user]);

  useEffect(() => {
    if (!user || typeof navigator === "undefined" || !navigator.geolocation) {
      if (user) setGeoError("Geolocation is not available on this device.");
      return;
    }

    const watchId = navigator.geolocation.watchPosition(
      (position) => {
        const next = {
          lat: position.coords.latitude,
          lng: position.coords.longitude,
        };
        setCurrentLocation(next);
        setGeoError(null);

        const now = Date.now();
        if (now - lastPresenceWriteRef.current < 5000) return;
        lastPresenceWriteRef.current = now;
        setDoc(doc(db, "users", user.uid), {
          lastKnownLocation: next,
          availability: true,
          updatedAt: new Date(now).toISOString(),
        }, { merge: true }).catch((err) => setGeoError(err.message));
      },
      (err) => setGeoError(err.message),
      { enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 }
    );

    return () => navigator.geolocation.clearWatch(watchId);
  }, [user]);

  useEffect(() => {
    if (!user || !profile) return;
    const openQuery = query(collection(db, "incidents"), where("status", "==", "detected"), limit(10));
    const unsubOpen = onSnapshot(openQuery, (snapshot) => {
      snapshot.docs.forEach((docSnap) => {
        const incident = docSnap.data();
        if (!incident.readyForAllocation || incident.assignmentPhase !== "initial") return;
        if (biddedIncidents.current.has(docSnap.id)) return;
        biddedIncidents.current.add(docSnap.id);

        let score = 0;
        let distance = 0;
        if (profile.lastKnownLocation && incident.location) {
          const lat1 = Number(profile.lastKnownLocation.lat);
          const lng1 = Number(profile.lastKnownLocation.lng);
          const lat2 = Number(incident.location.lat);
          const lng2 = Number(incident.location.lng);
          if (!Number.isNaN(lat1) && !Number.isNaN(lng1) && !Number.isNaN(lat2) && !Number.isNaN(lng2)) {
            distance = Math.max(1, haversineMeters(lat1, lng1, lat2, lng2));
            const requiredSkill = incident.requiredSkill || "general";
            const hasSkill = requiredSkill === "general" || (profile.skills || []).includes(requiredSkill);
            const severity = incident.severity?.provisional || "medium";
            const severityWeight = severity === "critical" ? 2.0 : severity === "high" ? 1.5 : severity === "low" ? 0.7 : 1.0;
            const skillWeight = hasSkill ? 1.0 : 0.5;
            if (profile.availability !== false) score = (1.0 / distance) * severityWeight * skillWeight;
          }
        }

        const bidRef = doc(db, "incidents", docSnap.id, "bids", user.uid);
        setDoc(bidRef, {
          responderId: user.uid,
          timestamp: new Date().toISOString(),
          score,
          distance: Number.isFinite(distance) ? distance : 0,
        }, { merge: true }).catch(console.error);
      });
    });
    return () => unsubOpen();
  }, [user, profile]);

  useEffect(() => {
    const hazardQuery = query(collection(db, "hazards"), limit(50));
    const unsubHazards = onSnapshot(hazardQuery, (snapshot) => {
      setHazards(snapshot.docs.map((entry) => ({ id: entry.id, ...(entry.data() as Omit<HazardPin, "id">) })));
    });
    return () => unsubHazards();
  }, []);

  useEffect(() => {
    const syncPendingCount = () => setPendingCount(listPendingAcks().length);
    syncPendingCount();
    const handleOnline = async () => {
      setIsOnline(true);
      const result = await flushPendingAcks(ACK_FUNCTION_URL);
      if (result.failed > 0) setError(`Synced ${result.flushed} queued actions; ${result.failed} still pending.`);
      else if (result.flushed > 0) setError(null);
      syncPendingCount();
    };
    const handleOffline = () => {
      setIsOnline(false);
      syncPendingCount();
    };
    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
    };
  }, []);

  const activeIncident = useMemo(
    () => incidents.find((item) => item.status === "assigned") || incidents.find((item) => item.status === "acknowledged") || incidents[0] || null,
    [incidents]
  );

  const effectiveLocation = useMemo(() => {
    if (currentLocation) return currentLocation;
    const lat = Number(profile?.lastKnownLocation?.lat);
    const lng = Number(profile?.lastKnownLocation?.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    return { lat, lng };
  }, [currentLocation, profile?.lastKnownLocation?.lat, profile?.lastKnownLocation?.lng]);

  const activeDistanceMeters = useMemo(() => {
    if (!activeIncident?.location || !effectiveLocation) return null;
    const lat2 = Number(activeIncident.location.lat);
    const lng2 = Number(activeIncident.location.lng);
    if (!Number.isFinite(lat2) || !Number.isFinite(lng2)) return null;
    return haversineMeters(effectiveLocation.lat, effectiveLocation.lng, lat2, lng2);
  }, [activeIncident, effectiveLocation]);

  async function onSignIn(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    try {
      await signInWithEmailAndPassword(auth, email, password);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Login failed.");
    }
  }

  async function acknowledge(incidentId: string) {
    if (!user) return;
    setAckInFlight(incidentId);
    setError(null);
    if (!ACK_FUNCTION_URL) {
      setError("NEXT_PUBLIC_ACK_FUNCTION_URL is not configured.");
      setAckInFlight(null);
      return;
    }
    if (!navigator.onLine) {
      enqueuePendingAck(incidentId, user.uid);
      setPendingCount(listPendingAcks().length);
      setAckInFlight(null);
      return;
    }
    try {
      const response = await fetch(ACK_FUNCTION_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ incidentId, responderId: user.uid }),
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(payload.message || `Ack failed (${response.status})`);
      }
    } catch {
      enqueuePendingAck(incidentId, user.uid);
      setPendingCount(listPendingAcks().length);
      setError("Network unstable. Acceptance queued and will sync automatically.");
    } finally {
      setAckInFlight(null);
    }
  }

  async function resolveIncident(incident: Incident) {
    if (!user || !effectiveLocation || activeDistanceMeters === null) return;
    setResolveInFlight(incident.id);
    setError(null);
    try {
      const now = new Date().toISOString();
      await updateDoc(doc(db, "incidents", incident.id), {
        status: "resolved",
        resolvedAt: now,
        resolvedBy: user.uid,
        resolution: {
          distanceMeters: Math.round(activeDistanceMeters),
          location: effectiveLocation,
        },
        updatedAt: now,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Resolution failed.");
    } finally {
      setResolveInFlight(null);
    }
  }

  if (loading) {
    return (
      <main className="responder-shell">
        <div className="responder-loading">
          <div className="responder-loading-ring" />
          <p>Connecting to ORCHID...</p>
        </div>
      </main>
    );
  }

  if (!user) {
    return (
      <main className="responder-shell">
        <section className="card responder-auth-card">
          <h1>ORCHID Responder</h1>
          <p>Sign in using a responder account to receive assignments.</p>
          <form onSubmit={onSignIn}>
            <label>Email <input type="email" value={email} onChange={(event) => setEmail(event.target.value)} required /></label>
            <label>Password <input type="password" value={password} onChange={(event) => setPassword(event.target.value)} required /></label>
            <button type="submit">Sign In</button>
          </form>
          {error && <p className="error">{error}</p>}
        </section>
      </main>
    );
  }

  const origin = effectiveLocation;

  const destination =
    activeIncident?.location?.lat !== undefined && activeIncident?.location?.lng !== undefined
      ? { lat: Number(activeIncident.location.lat), lng: Number(activeIncident.location.lng) }
      : null;

  return (
    <main className="responder-shell" role="main" aria-label="ORCHID Responder Dashboard">
      {/* Crisis flash overlay and banner */}
      <div className={`crisis-overlay ${crisisActive ? "active" : ""}`} />
      {crisisActive && (
        <div className="crisis-banner" onClick={() => setCrisisActive(false)}>
          <span className="crisis-icon">🚨</span>
          NEW ASSIGNMENT — {crisisLabel}
          <span className="crisis-icon">🚨</span>
          <button className="crisis-dismiss" onClick={() => setCrisisActive(false)}>DISMISS</button>
        </div>
      )}

      {!isOnline && (
        <div className="responder-offline-banner" role="status">
          Offline mode. Actions are queued locally and will sync on reconnect.
          {pendingCount > 0 && <span className="responder-offline-queue">{pendingCount} pending</span>}
        </div>
      )}

      <header className="responder-topbar card" role="banner">
        <div>
          <h1>ORCHID Responder</h1>
          <p>{profile?.displayName || user.email}</p>
        </div>
        <button onClick={() => signOut(auth)}>Sign Out</button>
      </header>

      <section className="responder-status-bar card" aria-label="Responder status overview">
        <div className={`responder-status-pill ${isOnline ? "rsp-online" : "rsp-offline"}`}>
          <span className="rsp-dot" />
          {isOnline ? "Online" : "Offline"}
        </div>
        <div className="responder-status-pill rsp-neutral">{incidents.length} tasks</div>
        <div className={`responder-status-pill ${pendingCount > 0 ? "rsp-warning" : "rsp-neutral"}`}>{pendingCount} queued</div>
        <div className="responder-status-pill rsp-neutral">{currentLocation ? `${currentLocation.lat.toFixed(4)}, ${currentLocation.lng.toFixed(4)}` : origin ? `${origin.lat.toFixed(4)}, ${origin.lng.toFixed(4)}` : "No GPS"}</div>
      </section>

      {error && <p className="error inline">{error}</p>}
      {geoError && <p className="error inline">{geoError}</p>}

      {activeIncident ? (
        <>
          <FieldTaskCard
            incident={activeIncident}
            ackInFlight={ackInFlight}
            resolveInFlight={resolveInFlight}
            distanceMeters={activeDistanceMeters}
            effectiveLocation={effectiveLocation}
            onAck={acknowledge}
            onResolve={resolveIncident}
          />
          {activeIncident.status === "resolved" && <IncidentReportForm incident={activeIncident} user={user} onError={setError} />}
        </>
      ) : (
        <article className="card responder-incident">
          <div className="responder-standby">
            <div>
              <p className="responder-standby-title">Standby</p>
              <p className="responder-standby-sub">Monitoring for incident assignments.</p>
            </div>
          </div>
        </article>
      )}

      <RouteMap
        className="card"
        origin={origin}
        destination={destination}
        hazards={hazards}
        indoorNote="Indoor path is estimated for this MVP. Follow site safety protocol after arrival."
      />
    </main>
  );
}
