# ORCHID MVP Phase 3 (Implemented)

This workspace includes the Phase 2 core orchestration plus Phase 3 demo-facing experiences:
- Vertex AI-backed detection at ingest, normalized through deterministic rule mapping.
- Transactional Firestore onCreate initial allocation with explicit allocation states.
- Retry engine ownership for reassignment and `no_candidate` recovery.
- Async Gemini enrichment that does not alter assignment-critical fields.
- Next.js admin dashboard diagnostics for AI evidence and allocation explainability.
- Mobile-first responder web route with real-time assigned tasks and one-tap acceptance.
- Google Maps campus routing in responder view with indoor guidance mock note.
- Dashboard drag-and-drop responder simulation pins for live coordination demo.
- Offline acceptance queue and replay for failover demonstration.
- Optional tactical reasoning field support (feature-flagged) in enrichment payload.

## Repo Layout

- `infra/` Terraform baseline for Firestore, Pub/Sub, Cloud Tasks, Firebase enablement.
- `functions/` Python 3.11 Cloud Functions (HTTP + Pub/Sub).
- `dashboard/` Next.js static-export dashboard for Firebase Hosting.
- `scripts/` local operators scripts (mock camera sender, user/claims seeder).

## Cloud Functions

Functions entrypoints are in `functions/main.py`.

- `ingest_incident` (HTTP `POST`)
  - Input: `requestId`, `cameraId`, `timestamp`, `imageRef|imageBase64`, optional `imageMimeType`, optional `mockLabel`, `location`
  - Runs Vertex detection and deterministic normalization for `requiredSkill` and `severity`
  - Publishes:
    - `incident.fast.v1`
    - `incident.enrich.request.v1`
- `persist_incident` (Pub/Sub)
  - Upserts `incidents/{requestId}` idempotently
- `allocate_initial_incident` (Firestore onCreate)
  - Initial assignment only when incident is allocator-eligible
  - Uses transaction state machine (`processing -> completed|no_candidate`)
- `enrich_incident` (Pub/Sub)
  - Calls Gemini asynchronously
  - Patches incident with enriched classification/severity/summary
  - Optionally writes `tacticalReasoning` object when `ENABLE_TACTICAL_REASONING=true`
- `check_ack_deadline` (HTTP `POST`)
  - Triggered by Cloud Tasks
  - Owns reassignment on missed ack up to 3 attempts, then escalates
  - Revisits `no_candidate` incidents after `retryEligibleAt`
- `ack_incident` (HTTP `POST`)
  - Acknowledges incident and closes retry loop

## Local Test (Python)

From `functions/`:

```powershell
python -m unittest discover -s tests -p "test_*.py"
```

## Terraform Bootstrap

From `infra/`:

```powershell
terraform init
terraform apply -var "project_id=YOUR_PROJECT_ID" -var "region=us-central1"
```

## Deploy Functions (example with gcloud)

Set env vars:
- `FAST_TOPIC_ID=incident.fast.v1`
- `ENRICH_TOPIC_ID=incident.enrich.request.v1`
- `ACK_TIMEOUT_SECONDS=15`
- `MAX_ASSIGNMENT_ATTEMPTS=3`
- `NO_CANDIDATE_RETRY_SECONDS=30`
- `ACK_QUEUE_ID=incident-ack-deadline`
- `ACK_CALLBACK_URL=<https URL of check_ack_deadline>`
- `ENABLE_VERTEX_DETECTION=true`
- `VERTEX_DETECTION_MODEL=gemini-2.5-flash`
- `VERTEX_DETECTION_CONFIDENCE_THRESHOLD=0.6`
- `ENABLE_GEMINI=true`
- `GEMINI_MODEL=gemini-2.5-flash`
- `ENABLE_TACTICAL_REASONING=false`

### Tactical reasoning flag

- `ENABLE_TACTICAL_REASONING=false` (default): only base enrichment fields are written.
- `ENABLE_TACTICAL_REASONING=true`: enrichment may include advisory tactical fields:
  - `safeApproach`
  - `hazards[]`
  - `victimCount`
  - `recommendedEquipment[]`
  - `priorityActions[]`

These fields are advisory and do not modify assignment-critical state.

Deploy commands:

```powershell
gcloud functions deploy ingest_incident --gen2 --runtime python311 --region us-central1 --source functions --entry-point ingest_incident --trigger-http --allow-unauthenticated
gcloud functions deploy ack_incident --gen2 --runtime python311 --region us-central1 --source functions --entry-point ack_incident --trigger-http --allow-unauthenticated
gcloud functions deploy check_ack_deadline --gen2 --runtime python311 --region us-central1 --source functions --entry-point check_ack_deadline --trigger-http --allow-unauthenticated
gcloud functions deploy persist_incident --gen2 --runtime python311 --region us-central1 --source functions --entry-point persist_incident --trigger-topic incident.fast.v1
gcloud functions deploy allocate_initial_incident --gen2 --runtime python311 --region us-central1 --source functions --entry-point allocate_initial_incident --trigger-event-filters="type=google.cloud.firestore.document.v1.created" --trigger-event-filters="database=(default)" --trigger-event-filters-path-pattern="document=incidents/{incidentId}"
gcloud functions deploy enrich_incident --gen2 --runtime python311 --region us-central1 --source functions --entry-point enrich_incident --trigger-topic incident.enrich.request.v1
```

## Seed Users and Roles

```powershell
python scripts/seed_users_and_claims.py --project-id YOUR_PROJECT_ID --users-json scripts/seed_users.sample.json
```

## Run Mock Camera

```powershell
python scripts/mock_camera.py --ingest-url "https://REGION-PROJECT.cloudfunctions.net/ingest_incident"
```
$INGEST_URL=$(gcloud functions describe ingest_incident --gen2 --region=$REGION --format="value(serviceConfig.uri)")
python scripts/mock_camera.py --ingest-url $INGEST_URL


## Dashboard Setup

From `dashboard/`:

```powershell
copy .env.example .env.local
npm.cmd install
npm.cmd run build
```

Set these variables in `dashboard/.env.local`:

```env
NEXT_PUBLIC_FIREBASE_API_KEY=...
NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=...
NEXT_PUBLIC_FIREBASE_PROJECT_ID=...
NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET=...
NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID=...
NEXT_PUBLIC_FIREBASE_APP_ID=...
NEXT_PUBLIC_ACK_FUNCTION_URL=https://REGION-PROJECT.cloudfunctions.net/ack_incident
NEXT_PUBLIC_GOOGLE_MAPS_API_KEY=...
```

### Routes

- Admin SOC dashboard: `/`
- Responder mobile app: `/responder`

### Firestore rules (Phase 3)

- Admin retains full write authority for `incidents`.
- Responders can update only their own presence fields in `users/{uid}`:
  - `lastKnownLocation`
  - `updatedAt`
  - `availability`

All other user mutations stay admin-only.

## Demo Runbook: Simulated Failover

1. Sign in to `/` as admin and open `/responder` as a responder user on another device/browser.
2. Trigger incidents with `scripts/mock_camera.py`.
3. Confirm assignment appears on responder page.
4. Disable network on responder device (DevTools Network -> Offline).
5. Press `Accept Task`; action is queued locally.
6. Re-enable network; queued acceptance replays to `ack_incident` automatically.
7. Verify incident state converges to `acknowledged` on both admin and responder views.

## Demo Runbook: Simulated Coordination

1. Open admin dashboard `/`.
2. Use `Start Edit Mode` in Responder Simulation panel.
3. Drag pins to represent staff movement.
4. Use `Reset Pins` to restore initial seeded locations.
5. Use `Clear Visuals` to remove selection/error highlights.

Deploy static export to Firebase Hosting:

```powershell
firebase deploy --only hosting,firestore:rules
```
