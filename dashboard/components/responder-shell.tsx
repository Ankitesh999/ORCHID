"use client";

import { useEffect, useMemo, useState } from "react";
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
        indoorNote="Indoor path is mocked for this MVP. Follow nearest building entry after campus route ends."
      />
    </main>
  );
}
