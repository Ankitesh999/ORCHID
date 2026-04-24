"use client";

import { useEffect, useMemo, useState, useRef } from "react";
import {
  collection,
  doc,
  limit,
  onSnapshot,
  query,
  where,
} from "firebase/firestore";
import { User, onAuthStateChanged, signInWithEmailAndPassword, signOut } from "firebase/auth";

import { auth, db } from "../lib/firebase";
import { Incident } from "../lib/types";
import { RouteMap } from "./route-map";
import { enqueuePendingAck, flushPendingAcks, listPendingAcks } from "../lib/offline-ack-queue";

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

function haversineMeters(lat1: number, lng1: number, lat2: number, lng2: number) {
  const R = 6371e3;
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLng = (lng2 - lng1) * rad;
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(lat1 * rad) * Math.cos(lat2 * rad) *
            Math.sin(dLng / 2) * Math.sin(dLng / 2);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ─── ACK COUNTDOWN RING ─────────────────────────────────────────────────────

function AckCountdownRing({ ackDeadline }: { ackDeadline?: string | null }) {
  const TOTAL_SECONDS = 15;
  const [secondsLeft, setSecondsLeft] = useState<number | null>(null);

  useEffect(() => {
    if (!ackDeadline) { setSecondsLeft(null); return; }
    const deadline = new Date(ackDeadline).getTime();

    function tick() {
      const remaining = Math.max(0, (deadline - Date.now()) / 1000);
      setSecondsLeft(remaining);
    }

    tick();
    const id = setInterval(tick, 500);
    return () => clearInterval(id);
  }, [ackDeadline]);

  if (secondsLeft === null) return null;

  const pct = Math.min(1, secondsLeft / TOTAL_SECONDS);
  const radius = 44;
  const circumference = 2 * Math.PI * radius;
  const dashOffset = circumference * (1 - pct);

  const color =
    pct > 0.5 ? "#22c55e" :
    pct > 0.25 ? "#f59e0b" : "#ef4444";

  const isExpired = secondsLeft <= 0;

  return (
    <div className="ack-ring-wrapper">
      <svg className="ack-ring-svg" viewBox="0 0 100 100">
        {/* Track */}
        <circle
          cx="50" cy="50" r={radius}
          fill="none"
          stroke="rgba(255,255,255,0.08)"
          strokeWidth="7"
        />
        {/* Progress */}
        <circle
          cx="50" cy="50" r={radius}
          fill="none"
          stroke={color}
          strokeWidth="7"
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={dashOffset}
          style={{
            transform: "rotate(-90deg)",
            transformOrigin: "50% 50%",
            transition: "stroke-dashoffset 0.5s linear, stroke 0.5s ease",
            filter: `drop-shadow(0 0 6px ${color})`,
          }}
        />
        {/* Label */}
        <text x="50" y="44" textAnchor="middle" fill={color} fontSize="18" fontWeight="800" fontFamily="Inter,sans-serif">
          {isExpired ? "!" : Math.ceil(secondsLeft)}
        </text>
        <text x="50" y="59" textAnchor="middle" fill="rgba(255,255,255,0.4)" fontSize="8" fontFamily="Inter,sans-serif" letterSpacing="1">
          {isExpired ? "EXPIRED" : "SECONDS"}
        </text>
      </svg>
      <span className="ack-ring-label" style={{ color }}>
        {isExpired ? "DEADLINE PASSED" : "ACK WINDOW"}
      </span>
    </div>
  );
}

// ─── TACTICAL BRIEF CARD ────────────────────────────────────────────────────

const SEVERITY_COLORS: Record<string, string> = {
  critical: "#ef4444",
  high: "#f59e0b",
  medium: "#3b82f6",
  low: "#94a3b8",
};

function TacticalBriefCard({
  incident,
  ackInFlight,
  onAck,
}: {
  incident: Incident;
  ackInFlight: string | null;
  onAck: (id: string) => void;
}) {
  const severity = incident.severity?.enriched || incident.severity?.provisional || "medium";
  const classification = incident.classification?.enriched || incident.classification?.provisional || "-";
  const sevColor = SEVERITY_COLORS[severity] ?? "#94a3b8";
  const isAssigned = incident.status === "assigned";
  const isEscalated = incident.status === "unacked_escalation";

  return (
    <article className={`card responder-incident tactical-brief ${isEscalated ? "tactical-brief-escalated" : ""}`}>
      {/* Top bar */}
      <div className="tactical-brief-topbar">
        <div className="tactical-brief-id">
          <span className="tactical-brief-id-label">INCIDENT ID</span>
          <span className="tactical-brief-id-val">{incident.id}</span>
        </div>
        <div className="tactical-brief-status-group">
          <span className={`status status-${incident.status || "unknown"}`}>
            {incident.status || "unknown"}
          </span>
          <span className="tactical-sev-badge" style={{ background: `${sevColor}22`, color: sevColor, borderColor: `${sevColor}44` }}>
            {severity.toUpperCase()}
          </span>
        </div>
      </div>

      {/* Main content row */}
      <div className="tactical-brief-body">
        {/* Left: countdown ring */}
        <AckCountdownRing ackDeadline={incident.ackDeadline} />

        {/* Right: intel */}
        <div className="tactical-brief-intel">
          <div className="tactical-intel-row">
            <span className="tactical-intel-key">Classification</span>
            <span className="tactical-intel-val">{classification}</span>
          </div>
          <div className="tactical-intel-row">
            <span className="tactical-intel-key">Required Skill</span>
            <span className="tactical-intel-val">{incident.requiredSkill || "general"}</span>
          </div>
          <div className="tactical-intel-row">
            <span className="tactical-intel-key">Ack Deadline</span>
            <span className="tactical-intel-val">{formatTime(incident.ackDeadline)}</span>
          </div>
          {incident.aiDetection?.evidenceSummary && (
            <div className="tactical-intel-evidence">
              <span className="tactical-intel-key">Evidence</span>
              <span className="tactical-intel-evidence-text">{incident.aiDetection.evidenceSummary}</span>
            </div>
          )}
        </div>
      </div>

      {/* Tactical actions */}
      {(incident.tacticalReasoning?.priorityActions?.length ?? 0) > 0 && (
        <div className="tactical-actions-strip">
          <span className="tactical-actions-label">🎯 PRIORITY ACTIONS</span>
          <div className="tactical-actions-pills">
            {(incident.tacticalReasoning?.priorityActions ?? []).map((action: string, i: number) => (
              <span key={i} className="tactical-action-pill">{action}</span>
            ))}
          </div>
        </div>
      )}

      {/* Hazards */}
      {(incident.tacticalReasoning?.hazards?.length ?? 0) > 0 && (
        <div className="tactical-hazards-strip">
          <span className="tactical-actions-label">⚠ KNOWN HAZARDS</span>
          <div className="tactical-actions-pills">
            {(incident.tacticalReasoning?.hazards ?? []).map((h: string, i: number) => (
              <span key={i} className="tactical-hazard-pill">{h}</span>
            ))}
          </div>
        </div>
      )}

      {/* Safe approach */}
      {incident.tacticalReasoning?.safeApproach && (
        <div className="tactical-approach">
          <span className="tactical-intel-key">🟢 Safe Approach</span>
          <p className="tactical-approach-text">{incident.tacticalReasoning.safeApproach}</p>
        </div>
      )}

      {/* Accept button */}
      <button
        className="accept-button"
        onClick={() => onAck(incident.id)}
        disabled={!isAssigned || ackInFlight === incident.id}
      >
        {ackInFlight === incident.id ? (
          <>
            <span className="accept-spinner" />
            Transmitting Acceptance...
          </>
        ) : isAssigned ? (
          "✓ Accept & Dispatch"
        ) : (
          `Status: ${incident.status}`
        )}
      </button>
    </article>
  );
}

// ─── RESPONDER SHELL ────────────────────────────────────────────────────────

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
  const [hazards, setHazards] = useState<HazardPin[]>([]);
  const biddedIncidents = useRef<Set<string>>(new Set());

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (next) => {
      setUser(next);
      setLoading(false);
      if (!next) { setProfile(null); setIncidents([]); return; }
      const token = await next.getIdTokenResult(true).catch(() => null);
      const role = token?.claims?.role;
      if (role !== "responder" && role !== "admin") {
        setError("This account is not authorized for responder mode.");
      } else {
        setError(null);
      }
    });
    return () => unsubscribe();
  }, []);

  useEffect(() => {
    if (!user) return;
    const unsubProfile = onSnapshot(doc(db, "users", user.uid), (snap) => {
      if (!snap.exists()) { setProfile({ uid: user.uid, role: "responder" }); return; }
      const data = snap.data();
      setProfile({
        uid: user.uid,
        role: String(data.role || "responder"),
        displayName: data.displayName,
        email: data.email,
        lastKnownLocation: data.lastKnownLocation,
        skills: data.skills,
        availability: data.availability,
      });
    });

    const incidentQuery = query(collection(db, "incidents"), where("assignedResponderId", "==", user.uid), limit(20));
    const unsubIncidents = onSnapshot(
      incidentQuery,
      (snapshot) => {
        const rows: Incident[] = snapshot.docs
          .map((item) => ({ id: item.id, ...(item.data() as Omit<Incident, "id">) }))
          .sort((a, b) => Date.parse(String(b.createdAt || 0)) - Date.parse(String(a.createdAt || 0)));
        setIncidents(rows);
      },
      (err) => setError(`Failed to load assignments: ${err.message}`)
    );
    return () => { unsubProfile(); unsubIncidents(); };
  }, [user]);

  useEffect(() => {
    if (!user || !profile) return;
    const openQuery = query(collection(db, "incidents"), where("status", "==", "detected"), limit(10));
    const unsubOpen = onSnapshot(openQuery, (snapshot) => {
      snapshot.docs.forEach((docSnap) => {
        const incident = docSnap.data();
        if (incident.readyForAllocation && incident.assignmentPhase === "initial") {
          if (biddedIncidents.current.has(docSnap.id)) return;
          biddedIncidents.current.add(docSnap.id);
          import("firebase/firestore").then(({ setDoc, doc }) => {
            const bidRef = doc(db, "incidents", docSnap.id, "bids", user.uid);
            let score = 0, distance = Infinity;
            if (profile.lastKnownLocation && incident.location) {
              const lat1 = Number(profile.lastKnownLocation.lat);
              const lng1 = Number(profile.lastKnownLocation.lng);
              const lat2 = Number(incident.location.lat);
              const lng2 = Number(incident.location.lng);
              if (!Number.isNaN(lat1) && !Number.isNaN(lng1) && !Number.isNaN(lat2) && !Number.isNaN(lng2)) {
                distance = Math.max(1, haversineMeters(lat1, lng1, lat2, lng2));
                const requiredSkill = incident.requiredSkill || "general";
                const hasSkill = requiredSkill === "general" || (profile.skills && profile.skills.includes(requiredSkill));
                let severityWeight = 1.0;
                const sev = incident.severity?.provisional || "medium";
                if (sev === "critical") severityWeight = 2.0;
                else if (sev === "high") severityWeight = 1.5;
                else if (sev === "low") severityWeight = 0.7;
                const skillWeight = hasSkill ? 1.0 : 0.5;
                if (profile.availability !== false) score = (1.0 / distance) * severityWeight * skillWeight;
              }
            }
            setDoc(bidRef, {
              responderId: user.uid,
              timestamp: new Date().toISOString(),
              score, distance,
              bidderProfile: profile,
            }, { merge: true }).catch(console.error);
          });
        }
      });
    });
    return () => unsubOpen();
  }, [user, profile]);

  useEffect(() => {
    const hazardQuery = query(collection(db, "hazards"), limit(50));
    const unsubHazards = onSnapshot(hazardQuery, (snapshot) => {
      setHazards(snapshot.docs.map((doc) => ({ id: doc.id, ...(doc.data() as Omit<HazardPin, "id">) })));
    });
    return () => unsubHazards();
  }, []);

  useEffect(() => {
    const syncPendingCount = () => setPendingCount(listPendingAcks().length);
    syncPendingCount();
    const handleOnline = async () => {
      setIsOnline(true);
      const result = await flushPendingAcks(ACK_FUNCTION_URL);
      if (result.failed > 0) setError(`Synced ${result.flushed} queued actions, ${result.failed} still pending.`);
      else if (result.flushed > 0) setError(null);
      syncPendingCount();
    };
    const handleOffline = () => { setIsOnline(false); syncPendingCount(); };
    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
    };
  }, []);

  const activeIncident = useMemo(
    () => incidents.find((item) => item.status === "assigned") || incidents[0] || null,
    [incidents]
  );

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
      setError("Network unstable. Acceptance queued — will sync automatically.");
    } finally {
      setAckInFlight(null);
    }
  }

  if (loading) {
    return (
      <main className="responder-shell">
        <div className="responder-loading">
          <div className="responder-loading-ring" />
          <p>Connecting to ORCHID mesh...</p>
        </div>
      </main>
    );
  }

  if (!user) {
    return (
      <main className="responder-shell">
        <section className="card responder-auth-card">
          <h1>ORCHID Responder</h1>
          <p>Sign in using a responder account to receive real-time tasks.</p>
          <form onSubmit={onSignIn}>
            <label>Email <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required /></label>
            <label>Password <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required /></label>
            <button type="submit">Sign In</button>
          </form>
          {error && <p className="error">{error}</p>}
        </section>
      </main>
    );
  }

  const origin =
    profile?.lastKnownLocation?.lat !== undefined && profile?.lastKnownLocation?.lng !== undefined
      ? { lat: Number(profile.lastKnownLocation.lat), lng: Number(profile.lastKnownLocation.lng) }
      : null;

  const destination =
    activeIncident?.location?.lat !== undefined && activeIncident?.location?.lng !== undefined
      ? { lat: Number(activeIncident.location.lat), lng: Number(activeIncident.location.lng) }
      : null;

  return (
    <main className="responder-shell">
      {/* Offline mesh banner */}
      {!isOnline && (
        <div className="responder-offline-banner">
          <span className="responder-offline-icon">⚡</span>
          MESH MODE — Actions queued locally. Will sync when signal is restored.
          {pendingCount > 0 && <span className="responder-offline-queue">{pendingCount} pending</span>}
        </div>
      )}

      <header className="responder-topbar card">
        <div>
          <h1>ORCHID Responder</h1>
          <p>{profile?.displayName || user.email}</p>
        </div>
        <button onClick={() => signOut(auth)}>Sign Out</button>
      </header>

      {/* Status pill bar */}
      <section className="responder-status-bar card">
        <div className={`responder-status-pill ${isOnline ? "rsp-online" : "rsp-offline"}`}>
          <span className="rsp-dot" />
          {isOnline ? "ONLINE" : "OFFLINE"}
        </div>
        <div className="responder-status-pill rsp-neutral">
          <span>📋</span>
          {incidents.length} TASK{incidents.length !== 1 ? "S" : ""}
        </div>
        <div className={`responder-status-pill ${pendingCount > 0 ? "rsp-warning" : "rsp-neutral"}`}>
          <span>⏳</span>
          {pendingCount} QUEUED
        </div>
        <div className="responder-status-pill rsp-neutral">
          <span>📍</span>
          {origin ? `${origin.lat.toFixed(4)}, ${origin.lng.toFixed(4)}` : "NO GPS"}
        </div>
      </section>

      {error && <p className="error inline">{error}</p>}

      {activeIncident ? (
        <TacticalBriefCard
          incident={activeIncident}
          ackInFlight={ackInFlight}
          onAck={acknowledge}
        />
      ) : (
        <article className="card responder-incident">
          <div className="responder-standby">
            <div className="responder-standby-pulse" />
            <div>
              <p className="responder-standby-title">STANDBY</p>
              <p className="responder-standby-sub">Monitoring for incident assignments...</p>
            </div>
          </div>
        </article>
      )}

      <RouteMap
        className="card"
        origin={origin}
        destination={destination}
        hazards={hazards}
        indoorNote="Indoor path is mocked for this MVP. Follow nearest building entry after campus route ends."
      />
    </main>
  );
}
