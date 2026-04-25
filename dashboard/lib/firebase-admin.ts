import { cert, getApps, initializeApp, applicationDefault } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";

function parseServiceAccount() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_KEY;
  if (!raw) return null;

  const parsed = JSON.parse(raw);
  if (parsed.private_key && typeof parsed.private_key === "string") {
    parsed.private_key = parsed.private_key.replace(/\\n/g, "\n");
  }
  return parsed;
}

const serviceAccount = parseServiceAccount();
const adminApp = getApps().length
  ? getApps()[0]
  : initializeApp({
      credential: serviceAccount ? cert(serviceAccount) : applicationDefault(),
      projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT,
    });

export const adminAuth = getAuth(adminApp);
export const adminDb = getFirestore(adminApp);

export async function assertAdminFromRequest(request: Request) {
  const header = request.headers.get("authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
  if (!token) {
    return { ok: false as const, response: Response.json({ error: "missing_auth" }, { status: 401 }) };
  }

  try {
    const decoded = await adminAuth.verifyIdToken(token);
    if (decoded.role !== "admin") {
      return { ok: false as const, response: Response.json({ error: "forbidden" }, { status: 403 }) };
    }
    return { ok: true as const, uid: decoded.uid };
  } catch {
    return { ok: false as const, response: Response.json({ error: "invalid_auth" }, { status: 401 }) };
  }
}
