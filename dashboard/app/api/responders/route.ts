import { adminAuth, adminDb, assertAdminFromRequest } from "../../../lib/firebase-admin";
import { randomPointNearDemoCampus } from "../../../lib/geo";

export const runtime = "nodejs";

const ALLOWED_SKILLS = new Set([
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
]);

function cleanSkills(value: unknown) {
  if (!Array.isArray(value)) return ["general"];
  const skills = value
    .map((item) => String(item).trim().toLowerCase().replace(/\s+/g, "_"))
    .filter((item) => ALLOWED_SKILLS.has(item));
  return skills.length ? Array.from(new Set(skills)) : ["general"];
}

function cleanLocation(value: unknown) {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const lat = Number(record.lat);
  const lng = Number(record.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return { lat, lng };
}

export async function POST(request: Request) {
  const admin = await assertAdminFromRequest(request);
  if (!admin.ok) return admin.response;

  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return Response.json({ error: "invalid_body" }, { status: 400 });
  }

  const email = String((body as Record<string, unknown>).email || "").trim().toLowerCase();
  const password = String((body as Record<string, unknown>).password || "");
  const displayName = String((body as Record<string, unknown>).displayName || "").trim();
  const availability = Boolean((body as Record<string, unknown>).availability ?? true);
  const skills = cleanSkills((body as Record<string, unknown>).skills);
  const location = cleanLocation((body as Record<string, unknown>).lastKnownLocation) || randomPointNearDemoCampus();

  if (!email || !password || password.length < 6 || !displayName) {
    return Response.json({ error: "email_password_displayName_required" }, { status: 400 });
  }

  const createdAt = new Date().toISOString();
  const user = await adminAuth.createUser({ email, password, displayName, disabled: false });
  await adminAuth.setCustomUserClaims(user.uid, { role: "responder" });

  const profile = {
    uid: user.uid,
    email,
    displayName,
    role: "responder",
    skills,
    availability,
    disabled: false,
    createdAt,
    updatedAt: createdAt,
    lastKnownLocation: location,
  };

  await adminDb.collection("users").doc(user.uid).set(profile, { merge: true });
  return Response.json({ ok: true, responder: profile }, { status: 201 });
}
