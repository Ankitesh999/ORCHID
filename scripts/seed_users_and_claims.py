from __future__ import annotations

import argparse
import json
from datetime import datetime, timezone
from pathlib import Path

import firebase_admin
from firebase_admin import auth, credentials
from google.cloud import firestore


def iso_now() -> str:
    return datetime.now(tz=timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def initialize_admin(project_id: str, service_account_json: str | None) -> firestore.Client:
    if service_account_json:
        cred = credentials.Certificate(service_account_json)
        firebase_admin.initialize_app(cred, {"projectId": project_id})
    else:
        firebase_admin.initialize_app(options={"projectId": project_id})
    return firestore.Client(project=project_id)


def ensure_user(email: str, password: str, display_name: str) -> auth.UserRecord:
    try:
        user = auth.get_user_by_email(email)
    except auth.UserNotFoundError:
        user = auth.create_user(email=email, password=password, display_name=display_name)
    return user


def main() -> None:
    parser = argparse.ArgumentParser(description="Seed ORCHID users and Firebase Auth custom claims")
    parser.add_argument("--project-id", required=True)
    parser.add_argument("--service-account-json", default=None)
    parser.add_argument("--users-json", required=True, help="Path to a JSON array of users to seed")
    args = parser.parse_args()

    db = initialize_admin(args.project_id, args.service_account_json)
    users = json.loads(Path(args.users_json).read_text(encoding="utf-8"))

    for item in users:
        email = item["email"]
        password = item.get("password", "Passw0rd!23")
        display_name = item.get("displayName", email.split("@")[0])
        role = item.get("role", "responder")
        skills = item.get("skills", [])
        availability = bool(item.get("availability", True))
        location = item.get("lastKnownLocation", {"lat": 12.9717, "lng": 77.5947})

        user = ensure_user(email=email, password=password, display_name=display_name)
        auth.set_custom_user_claims(user.uid, {"role": role})

        db.collection("users").document(user.uid).set(
            {
                "email": email,
                "displayName": display_name,
                "role": role,
                "skills": skills,
                "availability": availability,
                "lastKnownLocation": location,
                "createdAt": iso_now(),
                "updatedAt": iso_now(),
            },
            merge=True,
        )
        print(f"Seeded {email} ({role}) uid={user.uid}")


if __name__ == "__main__":
    main()
