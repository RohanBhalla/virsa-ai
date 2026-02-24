from __future__ import annotations

import unittest
from unittest.mock import patch

from fastapi.testclient import TestClient
from pymongo.errors import DuplicateKeyError

from app import auth, main


class FakeCollection:
    def __init__(self, unique_fields: list[str] | None = None):
        self._docs: list[dict] = []
        self._unique_fields = unique_fields or []

    def create_index(self, *args, **kwargs):
        return None

    def find_one(self, query: dict, projection: dict | None = None):
        for doc in self._docs:
            if self._matches(doc, query):
                if projection and projection.get("_id") == 0:
                    return {k: v for k, v in doc.items() if k != "_id"}
                return dict(doc)
        return None

    def insert_one(self, document: dict):
        for field in self._unique_fields:
            value = document.get(field)
            if value is None:
                continue
            for existing in self._docs:
                if existing.get(field) == value:
                    raise DuplicateKeyError(f"Duplicate value for {field}")
        self._docs.append(dict(document))
        return {"inserted_id": document.get("id")}

    def update_one(self, query: dict, update: dict, upsert: bool = False):
        for i, doc in enumerate(self._docs):
            if self._matches(doc, query):
                changed = dict(doc)
                for key, value in update.get("$set", {}).items():
                    changed[key] = value
                self._docs[i] = changed
                return {"matched_count": 1}

        if upsert:
            new_doc = dict(query)
            for key, value in update.get("$set", {}).items():
                new_doc[key] = value
            for key, value in update.get("$setOnInsert", {}).items():
                new_doc[key] = value
            self.insert_one(new_doc)
            return {"matched_count": 0, "upserted": 1}

        return {"matched_count": 0}

    @staticmethod
    def _matches(doc: dict, query: dict) -> bool:
        for key, value in query.items():
            if doc.get(key) != value:
                return False
        return True


class AuthApiTests(unittest.TestCase):
    def setUp(self):
        self.users = FakeCollection(unique_fields=["id", "email"])
        self.sessions = FakeCollection(unique_fields=["id"])

        self.patches = [
            patch.object(main, "init_db", lambda: None),
            patch.object(auth, "users_collection", lambda: self.users),
            patch.object(auth, "sessions_collection", lambda: self.sessions),
            patch.object(auth, "JWT_SECRET_KEY", "test-jwt-secret"),
            patch.object(auth, "JWT_ISSUER", "virsa-ai-test"),
            patch.object(auth, "JWT_AUDIENCE", "virsa-ai-test-users"),
            patch.object(auth, "REFRESH_TOKEN_HASH_SECRET", "test-refresh-hash-secret"),
        ]

        for p in self.patches:
            p.start()
        self.client = TestClient(main.app)

    def tearDown(self):
        self.client.close()
        for p in reversed(self.patches):
            p.stop()

    def test_register_success_and_password_hashing(self):
        res = self.client.post(
            "/api/auth/register",
            json={"email": "User@Example.com", "password": "StrongPass123!", "name": "User One"},
        )

        self.assertEqual(res.status_code, 200)
        body = res.json()
        self.assertEqual(body["token_type"], "bearer")
        self.assertTrue(body["access_token"])
        self.assertTrue(body["refresh_token"])
        self.assertEqual(body["user"]["email"], "user@example.com")
        self.assertNotIn("password_hash", body["user"])

        stored = self.users.find_one({"email": "user@example.com"})
        self.assertIsNotNone(stored)
        self.assertNotEqual(stored["password_hash"], "StrongPass123!")
        self.assertTrue(stored["password_hash"].startswith("$argon2"))

    def test_register_duplicate_email_returns_409(self):
        payload = {"email": "duplicate@example.com", "password": "StrongPass123!", "name": "Dup"}
        first = self.client.post("/api/auth/register", json=payload)
        second = self.client.post("/api/auth/register", json=payload)

        self.assertEqual(first.status_code, 200)
        self.assertEqual(second.status_code, 409)

    def test_login_and_me_flow(self):
        self.client.post(
            "/api/auth/register",
            json={"email": "login@example.com", "password": "StrongPass123!", "name": "Login User"},
        )

        login_res = self.client.post(
            "/api/auth/login",
            json={"email": "login@example.com", "password": "StrongPass123!"},
        )
        self.assertEqual(login_res.status_code, 200)

        access = login_res.json()["access_token"]
        me_res = self.client.get("/api/auth/me", headers={"Authorization": f"Bearer {access}"})

        self.assertEqual(me_res.status_code, 200)
        self.assertEqual(me_res.json()["user"]["email"], "login@example.com")

    def test_login_invalid_password_returns_401(self):
        self.client.post(
            "/api/auth/register",
            json={"email": "badpass@example.com", "password": "StrongPass123!", "name": "Bad Pass"},
        )

        login_res = self.client.post(
            "/api/auth/login",
            json={"email": "badpass@example.com", "password": "WrongPassword123!"},
        )

        self.assertEqual(login_res.status_code, 401)

    def test_refresh_rotates_and_old_refresh_token_becomes_invalid(self):
        register = self.client.post(
            "/api/auth/register",
            json={"email": "rotate@example.com", "password": "StrongPass123!", "name": "Rotate"},
        )
        self.assertEqual(register.status_code, 200)

        refresh_1 = register.json()["refresh_token"]
        rotate_res = self.client.post("/api/auth/refresh", json={"refresh_token": refresh_1})
        self.assertEqual(rotate_res.status_code, 200)

        refresh_2 = rotate_res.json()["refresh_token"]
        self.assertNotEqual(refresh_2, refresh_1)

        reused_old = self.client.post("/api/auth/refresh", json={"refresh_token": refresh_1})
        self.assertEqual(reused_old.status_code, 401)

    def test_logout_revokes_refresh_token(self):
        register = self.client.post(
            "/api/auth/register",
            json={"email": "logout@example.com", "password": "StrongPass123!", "name": "Logout"},
        )
        self.assertEqual(register.status_code, 200)

        refresh = register.json()["refresh_token"]
        logout_res = self.client.post("/api/auth/logout", json={"refresh_token": refresh})
        self.assertEqual(logout_res.status_code, 200)

        refresh_after_logout = self.client.post("/api/auth/refresh", json={"refresh_token": refresh})
        self.assertEqual(refresh_after_logout.status_code, 401)

    def test_me_without_token_returns_401(self):
        res = self.client.get("/api/auth/me")
        self.assertEqual(res.status_code, 401)


if __name__ == "__main__":
    unittest.main()
