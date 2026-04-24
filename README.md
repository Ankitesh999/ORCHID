# ORCHID Local Development

This README is focused on local setup and demo flow only.

## Prerequisites

- Node.js 20+
- Python 3.11+
- Firebase CLI (`npm install -g firebase-tools`)
- gcloud CLI (for cloud-backed API calls and scripts)

## 1) Install dependencies

Dashboard:

```powershell
cd dashboard
npm ci
```

Functions:

```powershell
cd ..\functions
python -m pip install -r requirements.txt
```

## 2) Configure local env

Create `dashboard/.env.local` from the example:

```powershell
cd ..\dashboard
copy .env.example .env.local
```

Fill in all `NEXT_PUBLIC_*` values in `dashboard/.env.local`.

## 3) Start Firestore emulator (rules + realtime local testing)

From repo root:

```powershell
cd ..
firebase emulators:start --only firestore
```

## 4) Start dashboard

In a new terminal:

```powershell
cd dashboard
npm run dev
```

App routes:

- Admin dashboard: `/`
- Responder app: `/responder`

## 5) Run backend tests

In a new terminal:

```powershell
cd functions
python -m unittest discover -s tests -p "test_*.py"
```

## 6) Seed users and roles

```powershell
python scripts/seed_users_and_claims.py --project-id YOUR_PROJECT_ID --users-json scripts/seed_users.sample.json
```

## 7) Send demo incidents

Use the mock camera script against your deployed ingest endpoint:

```powershell
python scripts/mock_camera.py --ingest-url "https://ingest-incident-e5hgposbrq-uc.a.run.app"
python scripts/mock_edge_node.py --sensor=vitals --ingest-url "https://ingest-incident-e5hgposbrq-uc.a.run.app"

```

## Demo checklist

1. Open admin view (`/`) and responder view (`/responder`) in separate sessions.
2. Trigger incidents with `scripts/mock_camera.py`.
3. Confirm assignment appears in responder view.
4. Simulate offline in responder browser, accept task, then reconnect.
5. Verify acknowledgment replay and final incident state in admin view.

Email	Role	UID
admin@orchid.local	admin	tDpDzgEVdzW1akTuEp0geVs5P1c2
responder.a@orchid.local	responder	sfzu4EBJrIUYbiwgvuKe0PlVVXK2
responder.b@orchid.local	responder	2oBrmazm0LQcR6Y4CglNdWJ7nv32
