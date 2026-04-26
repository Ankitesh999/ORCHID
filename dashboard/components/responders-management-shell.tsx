"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import { onAuthStateChanged, signInWithEmailAndPassword, signOut, User } from "firebase/auth";
import { collection, onSnapshot, query, where } from "firebase/firestore";

import { auth, db } from "../lib/firebase";
import { DEMO_CENTER, randomPointNearDemoCampus } from "../lib/geo";

type ResponderProfile = {
  id: string;
  uid?: string;
  email?: string;
  displayName?: string;
  role?: string;
  skills?: string[];
  availability?: boolean;
  disabled?: boolean;
  updatedAt?: string;
  lastKnownLocation?: {
    lat?: number;
    lng?: number;
  };
};

type Draft = {
  email: string;
  password: string;
  displayName: string;
  skills: string[];
  availability: boolean;
  lat: string;
  lng: string;
};

const SKILLS = [
  "patrol",
  "security",
  "first_aid",
  "medical",
  "triage",
  "fire_response",
  "cpr_certified",
  "maintenance",
  "iot",
  "evacuation",
  "general",
];

function createEmptyDraft(): Draft {
  const seed = randomPointNearDemoCampus();
  return {
    email: "",
    password: "",
    displayName: "",
    skills: ["general"],
    availability: true,
    lat: seed.lat.toString(),
    lng: seed.lng.toString(),
  };
}

function displayValue(value?: string) {
  return (value || "general").replaceAll("_", " ");
}

function locationFromDraft(draft: Pick<Draft, "lat" | "lng">) {
  const lat = Number(draft.lat);
  const lng = Number(draft.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return undefined;
  return { lat, lng };
}

async function apiFetch(user: User, path: string, init: RequestInit) {
  const token = await user.getIdToken();
  const response = await fetch(path, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      ...(init.headers || {}),
    },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const errorCode = typeof payload.error === "string" ? payload.error : "";
    const errorMessage = typeof payload.message === "string" ? payload.message : "";
    if (response.status === 401 || errorCode === "missing_auth" || errorCode === "invalid_auth") {
      throw new Error("Authentication failed. Sign in again and retry.");
    }
    if (response.status === 403 || errorCode === "forbidden") {
      throw new Error("Admin role is required for responder management actions.");
    }
    if (errorCode === "invalid_location") {
      throw new Error(errorMessage || "Location must include numeric latitude and longitude.");
    }
    throw new Error(errorMessage || errorCode || `Request failed (${response.status})`);
  }
  return payload;
}

export function RespondersManagementShell() {
  const [user, setUser] = useState<User | null>(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [authError, setAuthError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [responders, setResponders] = useState<ResponderProfile[]>([]);
  const [draft, setDraft] = useState<Draft>(() => createEmptyDraft());
  const [editing, setEditing] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    return onAuthStateChanged(auth, (next) => {
      setUser(next);
      setLoading(false);
    });
  }, []);

  useEffect(() => {
    if (!user) {
      setResponders([]);
      return;
    }
    const responderQuery = query(collection(db, "users"), where("role", "==", "responder"));
    return onSnapshot(
      responderQuery,
      (snapshot) => {
        const rows = snapshot.docs
          .map((entry) => ({ id: entry.id, ...(entry.data() as Omit<ResponderProfile, "id">) }))
          .sort((a, b) => String(a.displayName || a.email || a.id).localeCompare(String(b.displayName || b.email || b.id)));
        setResponders(rows);
      },
      (err) => setError(`Failed to load responders: ${err.message}`)
    );
  }, [user]);

  const activeCount = useMemo(
    () => responders.filter((item) => item.availability !== false && !item.disabled).length,
    [responders]
  );

  async function onSignIn(event: FormEvent) {
    event.preventDefault();
    setAuthError(null);
    try {
      await signInWithEmailAndPassword(auth, email, password);
    } catch (err) {
      setAuthError(err instanceof Error ? err.message : "Login failed.");
    }
  }

  function toggleSkill(skill: string) {
    setDraft((current) => {
      const next = current.skills.includes(skill)
        ? current.skills.filter((item) => item !== skill)
        : [...current.skills, skill];
      return { ...current, skills: next.length ? next : ["general"] };
    });
  }

  function startEdit(responder: ResponderProfile) {
    setEditing(responder.id);
    setDraft({
      email: responder.email || "",
      password: "",
      displayName: responder.displayName || "",
      skills: responder.skills?.length ? responder.skills : ["general"],
      availability: responder.availability !== false,
      lat: responder.lastKnownLocation?.lat?.toString() || DEMO_CENTER.lat.toString(),
      lng: responder.lastKnownLocation?.lng?.toString() || DEMO_CENTER.lng.toString(),
    });
    setError(null);
    setNotice(null);
  }

  function resetDraft() {
    setEditing(null);
    setDraft(createEmptyDraft());
  }

  async function saveResponder(event: FormEvent) {
    event.preventDefault();
    if (!user) return;
    const location = locationFromDraft(draft);
    if (!location) {
      setError("Latitude and longitude must be valid numbers.");
      setNotice(null);
      return;
    }
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const payload = {
        email: draft.email,
        password: draft.password,
        displayName: draft.displayName,
        skills: draft.skills,
        availability: draft.availability,
        lastKnownLocation: location,
      };
      if (editing) {
        await apiFetch(user, `/api/responders/${editing}`, {
          method: "PATCH",
          body: JSON.stringify({
            email: payload.email,
            displayName: payload.displayName,
            skills: payload.skills,
            availability: payload.availability,
            lastKnownLocation: payload.lastKnownLocation,
          }),
        });
        setNotice("Responder updated.");
      } else {
        await apiFetch(user, "/api/responders", {
          method: "POST",
          body: JSON.stringify(payload),
        });
        setNotice("Responder created.");
      }
      resetDraft();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Responder save failed.");
    } finally {
      setSaving(false);
    }
  }

  async function toggleResponderState(responder: ResponderProfile) {
    if (!user) return;
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const willDisable = !responder.disabled;
      await apiFetch(user, `/api/responders/${responder.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          disabled: willDisable,
          availability: willDisable ? false : true,
        }),
      });
      setNotice(willDisable ? "Responder disabled." : "Responder enabled.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Responder state update failed.");
    } finally {
      setSaving(false);
    }
  }

  async function deleteResponder(uid: string) {
    if (!user) return;
    const confirmed = typeof window !== "undefined" ? window.confirm("Permanently delete this responder account? This cannot be undone.") : true;
    if (!confirmed) return;
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      await apiFetch(user, `/api/responders/${uid}`, { method: "DELETE" });
      setNotice("Responder permanently deleted.");
      if (editing === uid) resetDraft();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Responder delete failed.");
    } finally {
      setSaving(false);
    }
  }

  async function resetIncidents() {
    if (!user) return;
    const confirmed = typeof window !== "undefined" ? window.confirm("Delete all incidents for a fresh demo run?") : true;
    if (!confirmed) return;
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const payload = await apiFetch(user, "/api/incidents/reset", { method: "POST" });
      const deleted = Number(payload.deleted || 0);
      setNotice(`Incident reset completed. Deleted ${deleted} incident(s).`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Incident reset failed.");
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return <main className="admin-shell"><p>Loading...</p></main>;
  }

  if (!user) {
    return (
      <main className="admin-shell">
        <header className="admin-topbar">
          <div>
            <h1>Responder Admin</h1>
            <p>Manage field responder accounts and readiness.</p>
          </div>
          <a href="/" className="inject-nav-link">SOC Dashboard</a>
        </header>
        <section className="card auth-card">
          <h2>Admin Sign In</h2>
          <form onSubmit={onSignIn}>
            <label>Email <input type="email" value={email} onChange={(event) => setEmail(event.target.value)} required /></label>
            <label>Password <input type="password" value={password} onChange={(event) => setPassword(event.target.value)} required /></label>
            <button type="submit">Sign In</button>
          </form>
          {authError && <p className="error">{authError}</p>}
        </section>
      </main>
    );
  }

  return (
    <main className="admin-shell">
      <header className="admin-topbar">
        <div>
          <h1>Responder Admin</h1>
          <p>{activeCount} active of {responders.length} registered responders</p>
        </div>
        <div className="topbar-actions">
          <a href="/" className="inject-nav-link">SOC Dashboard</a>
          <button className="button-subtle danger-subtle" onClick={resetIncidents} disabled={saving}>Reset Incidents</button>
          <span>{user.email}</span>
          <button className="button-subtle" onClick={() => signOut(auth)}>Sign Out</button>
        </div>
      </header>

      {(error || notice) && (
        <p className={error ? "error inline" : "admin-notice"}>{error || notice}</p>
      )}

      <div className="admin-layout">
        <section className="card admin-form-card">
          <div className="panel-heading">
            <div>
              <h2>{editing ? "Edit Responder" : "Add Responder"}</h2>
              <p>{editing ? editing : "Create Auth account, role claim, and Firestore profile."}</p>
            </div>
            {editing && <button className="button-subtle" type="button" onClick={resetDraft}>Cancel</button>}
          </div>
          <form onSubmit={saveResponder}>
            <label>Email <input type="email" value={draft.email} onChange={(event) => setDraft((current) => ({ ...current, email: event.target.value }))} required /></label>
            {!editing && (
              <label>Password <input type="password" value={draft.password} onChange={(event) => setDraft((current) => ({ ...current, password: event.target.value }))} minLength={6} required /></label>
            )}
            <label>Display name <input value={draft.displayName} onChange={(event) => setDraft((current) => ({ ...current, displayName: event.target.value }))} required /></label>
            <div className="admin-skill-grid" aria-label="Responder skills">
              {SKILLS.map((skill) => (
                <button
                  key={skill}
                  type="button"
                  className={`skill-chip ${draft.skills.includes(skill) ? "skill-chip-active" : ""}`}
                  onClick={() => toggleSkill(skill)}
                >
                  {displayValue(skill)}
                </button>
              ))}
            </div>
            <label className="admin-toggle-row">
              <input
                type="checkbox"
                checked={draft.availability}
                onChange={(event) => setDraft((current) => ({ ...current, availability: event.target.checked }))}
              />
              Available for dispatch
            </label>
            <div className="admin-coord-grid">
              <label>Latitude <input value={draft.lat} onChange={(event) => setDraft((current) => ({ ...current, lat: event.target.value }))} /></label>
              <label>Longitude <input value={draft.lng} onChange={(event) => setDraft((current) => ({ ...current, lng: event.target.value }))} /></label>
            </div>
            <button type="submit" disabled={saving}>{saving ? "Saving..." : editing ? "Save Changes" : "Create Responder"}</button>
          </form>
        </section>

        <section className="card admin-table-card">
          <div className="panel-heading">
            <div>
              <h2>Responder Registry</h2>
              <p>Firestore-backed field accounts only.</p>
            </div>
          </div>
          <div className="admin-table">
            <div className="admin-table-head">
              <span>Name</span>
              <span>Skills</span>
              <span>Location</span>
              <span>Status</span>
              <span>Actions</span>
            </div>
            {responders.length === 0 ? (
              <p className="empty-state admin-empty">No responders registered.</p>
            ) : responders.map((responder) => (
              <div key={responder.id} className={`admin-table-row ${responder.disabled ? "admin-row-disabled" : ""}`}>
                <div>
                  <strong>{responder.displayName || responder.email || responder.id}</strong>
                  <small>{responder.email || responder.id}</small>
                </div>
                <span>{(responder.skills || ["general"]).map(displayValue).join(", ")}</span>
                <span>
                  {responder.lastKnownLocation?.lat !== undefined && responder.lastKnownLocation?.lng !== undefined
                    ? `${Number(responder.lastKnownLocation.lat).toFixed(4)}, ${Number(responder.lastKnownLocation.lng).toFixed(4)}`
                    : "No GPS"}
                </span>
                <span className={`admin-status ${responder.disabled ? "admin-status-disabled" : responder.availability === false ? "admin-status-offline" : "admin-status-online"}`}>
                  {responder.disabled ? "Disabled" : responder.availability === false ? "Unavailable" : "Available"}
                </span>
                <div className="admin-row-actions">
                  <button className="button-subtle" type="button" onClick={() => startEdit(responder)}>Edit</button>
                  <button
                    className="button-subtle"
                    type="button"
                    onClick={() => toggleResponderState(responder)}
                    disabled={saving}
                  >
                    {responder.disabled ? "Enable" : "Disable"}
                  </button>
                  <button
                    className="button-subtle danger-subtle"
                    type="button"
                    onClick={() => deleteResponder(responder.id)}
                    disabled={saving}
                  >
                    Delete
                  </button>
                </div>
              </div>
            ))}
          </div>
        </section>
      </div>
    </main>
  );
}
