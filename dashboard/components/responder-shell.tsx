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
  if (!value) {
    return "-";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
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
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
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
  const [hazards, setHazards] = useState<HazardPin[]>([]);
  const biddedIncidents = useRef<Set<string>>(new Set());

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
      if (role !== "responder" && role !== "admin") {
        setError("This account is not authorized for responder mode.");
      } else {
        setError(null);
      }
    });

    return () => unsubscribe();
  }, []);

  useEffect(() => {
    if (!user) {
      return;
    }
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
      });
    });

    const incidentQuery = query(collection(db, "incidents"), where("assignedResponderId", "==", user.uid), limit(20));
    const unsubIncidents = onSnapshot(
      incidentQuery,
      (snapshot) => {
        const rows: Incident[] = snapshot.docs
          .map((item) => ({ id: item.id, ...(item.data() as Omit<Incident, "id">) }))
          .sort((a, b) => {
            const left = Date.parse(String(a.createdAt || 0));
            const right = Date.parse(String(b.createdAt || 0));
            return right - left;
          });
        setIncidents(rows);
      },
      (err) => {
        setError(`Failed to load assignments: ${err.message}`);
      }
    );

    return () => {
      unsubProfile();
      unsubIncidents();
    };
  }, [user]);

  useEffect(() => {
    if (!user || !profile) return;
    const openQuery = query(collection(db, "incidents"), where("status", "==", "detected"), limit(10));
    const unsubOpen = onSnapshot(openQuery, (snapshot) => {
      snapshot.docs.forEach((docSnap) => {
        const incident = docSnap.data();
        if (incident.readyForAllocation && incident.assignmentPhase === "initial") {
          if (biddedIncidents.current.has(docSnap.id)) {
            return;
          }
          biddedIncidents.current.add(docSnap.id);

          import("firebase/firestore").then(({ setDoc, doc }) => {
            const bidRef = doc(db, "incidents", docSnap.id, "bids", user.uid);
            let score = 0;
            let distance = Infinity;
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
                const severity = incident.severity?.provisional || "medium";
                if (severity === "critical") severityWeight = 2.0;
                else if (severity === "high") severityWeight = 1.5;
                else if (severity === "low") severityWeight = 0.7;

                const skillWeight = hasSkill ? 1.0 : 0.5;
                const weight = severityWeight * skillWeight;
                
                if (profile.availability !== false) {
                  score = (1.0 / distance) * weight;
                }
              }
            }

            setDoc(bidRef, {
              responderId: user.uid,
              timestamp: new Date().toISOString(),
              score,
              distance,
              bidderProfile: profile,
            }, { merge: true }).catch(console.error);
          });
        }
      });
    });

    return () => {
      unsubOpen();
    };
  }, [user, profile]);

  useEffect(() => {
    const hazardQuery = query(collection(db, "hazards"), limit(50));
    const unsubHazards = onSnapshot(hazardQuery, (snapshot) => {
      const rows: HazardPin[] = snapshot.docs.map((doc) => ({
        id: doc.id,
        ...(doc.data() as Omit<HazardPin, "id">),
      }));
      setHazards(rows);
    });

    return () => {
      unsubHazards();
    };
  }, []);

  useEffect(() => {
    const syncPendingCount = () => setPendingCount(listPendingAcks().length);
    syncPendingCount();

    const handleOnline = async () => {
      setIsOnline(true);
      const result = await flushPendingAcks(ACK_FUNCTION_URL);
      if (result.failed > 0) {
        setError(`Synced ${result.flushed} queued actions, ${result.failed} still pending.`);
      } else if (result.flushed > 0) {
        setError(null);
      }
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

  const activeIncident = useMemo(() => {
    return incidents.find((item) => item.status === "assigned") || incidents[0] || null;
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

  async function acknowledge(incidentId: string) {
    if (!user) {
      return;
    }
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
      setError("Network unstable. Your acceptance was queued and will sync automatically.");
    } finally {
      setAckInFlight(null);
    }
  }

  if (loading) {
    return <main className="responder-shell"><p>Loading responder mode...</p></main>;
  }

  if (!user) {
    return (
      <main className="responder-shell">
        <section className="card responder-auth-card">
          <h1>Responder App</h1>
          <p>Sign in using a responder account to receive real-time tasks.</p>
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

  const origin = profile?.lastKnownLocation?.lat !== undefined && profile?.lastKnownLocation?.lng !== undefined
    ? { lat: Number(profile.lastKnownLocation.lat), lng: Number(profile.lastKnownLocation.lng) }
    : null;

  const destination = activeIncident?.location?.lat !== undefined && activeIncident?.location?.lng !== undefined
    ? { lat: Number(activeIncident.location.lat), lng: Number(activeIncident.location.lng) }
    : null;

  return (
    <main className="responder-shell">
      <header className="responder-topbar card">
        <div>
          <h1>ORCHID Responder</h1>
          <p>{profile?.displayName || user.email}</p>
        </div>
        <button onClick={() => signOut(auth)}>Sign Out</button>
      </header>

      <section className="card responder-meta">
        <p><strong>Network:</strong> {isOnline ? "online" : "offline"}</p>
        <p><strong>Queued Actions:</strong> {pendingCount}</p>
        <p><strong>Active Task:</strong> {activeIncident?.id || "none"}</p>
      </section>

      {error ? <p className="error inline">{error}</p> : null}

      {activeIncident ? (
        <article className="card responder-incident">
          <div className="responder-incident-head">
            <h2>{activeIncident.id}</h2>
            <span className={`status status-${activeIncident.status || "unknown"}`}>{activeIncident.status || "unknown"}</span>
          </div>
          <p><strong>Classification:</strong> {activeIncident.classification?.enriched || activeIncident.classification?.provisional || "-"}</p>
          <p><strong>Severity:</strong> {activeIncident.severity?.enriched || activeIncident.severity?.provisional || "-"}</p>
          <p><strong>Required Skill:</strong> {activeIncident.requiredSkill || "-"}</p>
          <p><strong>Ack Deadline:</strong> {formatTime(activeIncident.ackDeadline)}</p>
          <p><strong>Evidence:</strong> {activeIncident.aiDetection?.evidenceSummary || "-"}</p>
          {activeIncident.tacticalReasoning?.priorityActions?.length ? (
            <p><strong>Tactical Actions:</strong> {activeIncident.tacticalReasoning.priorityActions.join(", ")}</p>
          ) : null}
          <button
            className="accept-button"
            onClick={() => acknowledge(activeIncident.id)}
            disabled={activeIncident.status !== "assigned" || ackInFlight === activeIncident.id}
          >
            {ackInFlight === activeIncident.id ? "Accepting..." : "Accept Task"}
          </button>
        </article>
      ) : (
        <article className="card responder-incident"><p>No active assignments yet.</p></article>
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
