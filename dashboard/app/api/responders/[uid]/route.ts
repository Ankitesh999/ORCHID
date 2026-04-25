import { adminAuth, adminDb, assertAdminFromRequest } from "../../../../lib/firebase-admin";

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

type Params = { params: Promise<{ uid: string }> };

function cleanSkills(value: unknown) {
  if (!Array.isArray(value)) return undefined;
  const skills = value
    .map((item) => String(item).trim().toLowerCase().replace(/\s+/g, "_"))
    .filter((item) => ALLOWED_SKILLS.has(item));
  return skills.length ? Array.from(new Set(skills)) : ["general"];
}

function cleanLocation(value: unknown) {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const lat = Number(record.lat);
  const lng = Number(record.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return undefined;
  return { lat, lng };
}

export async function PATCH(request: Request, { params }: Params) {
  const admin = await assertAdminFromRequest(request);
  if (!admin.ok) return admin.response;

  const { uid } = await params;
  const body = await request.json().catch(() => null);
  if (!uid || !body || typeof body !== "object") {
    return Response.json({ error: "invalid_request" }, { status: 400 });
  }

  const record = body as Record<string, unknown>;
  const authUpdate: { email?: string; displayName?: string; disabled?: boolean } = {};
  const profileUpdate: Record<string, unknown> = {
    updatedAt: new Date().toISOString(),
    role: "responder",
  };

  if (typeof record.email === "string" && record.email.trim()) {
    authUpdate.email = record.email.trim().toLowerCase();
    profileUpdate.email = authUpdate.email;
  }
  if (typeof record.displayName === "string" && record.displayName.trim()) {
    authUpdate.displayName = record.displayName.trim();
    profileUpdate.displayName = authUpdate.displayName;
  }
  if (typeof record.availability === "boolean") {
    profileUpdate.availability = record.availability;
  }
  if (typeof record.disabled === "boolean") {
    authUpdate.disabled = record.disabled;
    profileUpdate.disabled = record.disabled;
  }

  const skills = cleanSkills(record.skills);
  if (skills) profileUpdate.skills = skills;
  const location = cleanLocation(record.lastKnownLocation);
  if (location) profileUpdate.lastKnownLocation = location;

  if (Object.keys(authUpdate).length > 0) {
    await adminAuth.updateUser(uid, authUpdate);
  }
  await adminAuth.setCustomUserClaims(uid, { role: "responder" });
  await adminDb.collection("users").doc(uid).set(profileUpdate, { merge: true });

  return Response.json({ ok: true });
}

export async function DELETE(request: Request, { params }: Params) {
  const admin = await assertAdminFromRequest(request);
  if (!admin.ok) return admin.response;

  const { uid } = await params;
  if (!uid) return Response.json({ error: "uid_required" }, { status: 400 });

  const now = new Date().toISOString();
  await adminAuth.updateUser(uid, { disabled: true });
  await adminDb.collection("users").doc(uid).set({
    availability: false,
    disabled: true,
    disabledAt: now,
    updatedAt: now,
    role: "responder",
  }, { merge: true });

  return Response.json({ ok: true });
}
