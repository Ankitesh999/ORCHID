import { adminDb, assertAdminFromRequest } from "../../../../lib/firebase-admin";

export const runtime = "nodejs";

async function purgeIncidentSubcollections(incidentId: string) {
  const incidentRef = adminDb.collection("incidents").doc(incidentId);
  const subcollections = await incidentRef.listCollections();
  for (const sub of subcollections) {
    while (true) {
      const snap = await sub.limit(250).get();
      if (snap.empty) break;
      const batch = adminDb.batch();
      snap.docs.forEach((docSnap) => batch.delete(docSnap.ref));
      await batch.commit();
      if (snap.size < 250) break;
    }
  }
}

export async function POST(request: Request) {
  const admin = await assertAdminFromRequest(request);
  if (!admin.ok) return admin.response;

  let deleted = 0;
  while (true) {
    const snapshot = await adminDb.collection("incidents").limit(100).get();
    if (snapshot.empty) break;

    for (const docSnap of snapshot.docs) {
      await purgeIncidentSubcollections(docSnap.id);
      await docSnap.ref.delete();
      deleted += 1;
    }
  }

  return Response.json({ ok: true, deleted });
}
