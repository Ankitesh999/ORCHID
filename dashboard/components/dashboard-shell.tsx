"use client";

import { useEffect, useMemo, useState } from "react";
import { onAuthStateChanged, signInWithEmailAndPassword, signOut, User } from "firebase/auth";
import { collection, limit, onSnapshot, orderBy, query } from "firebase/firestore";

import { auth, db } from "../lib/firebase";
import { Incident } from "../lib/types";

const ACK_FUNCTION_URL = process.env.NEXT_PUBLIC_ACK_FUNCTION_URL ?? "";

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

export function DashboardShell() {
  const [user, setUser] = useState<User | null>(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [loading, setLoading] = useState(true);
  const [ackInFlight, setAckInFlight] = useState<string | null>(null);

  useEffect(() => {
    return onAuthStateChanged(auth, (next) => {
      setUser(next);
      setLoading(false);
    });
  }, []);

  useEffect(() => {
    if (!user) {
      setIncidents([]);
      return;
    }
    const incidentQuery = query(collection(db, "incidents"), orderBy("createdAt", "desc"), limit(50));
    return onSnapshot(incidentQuery, (snapshot) => {
      const rows: Incident[] = snapshot.docs.map((doc) => ({ id: doc.id, ...(doc.data() as Omit<Incident, "id">) }));
      setIncidents(rows);
    });
  }, [user]);

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
              <p><strong>Enriched:</strong> {incident.classification?.enriched || "-"} ({incident.severity?.enriched || "-"})</p>
              <p><strong>Enrichment State:</strong> {incident.enrichmentState || "-"}</p>
              <p><strong>Assigned:</strong> {incident.assignedResponderId || "-"}</p>
              <p><strong>Attempt:</strong> {incident.assignmentAttempt || 0} / 3</p>
              <p><strong>Ack Deadline:</strong> {formatTime(incident.ackDeadline)}</p>
              <p><strong>Acknowledged At:</strong> {formatTime(incident.acknowledgedAt)}</p>
              <p><strong>Created:</strong> {formatTime(incident.createdAt)}</p>
              <p><strong>Updated:</strong> {formatTime(incident.updatedAt)}</p>
              {incident.summary ? <p><strong>Summary:</strong> {incident.summary}</p> : null}
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
