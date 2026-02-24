from __future__ import annotations

import hashlib
import hmac
from datetime import datetime, timedelta, timezone
from typing import Any
from uuid import uuid4

import jwt
from argon2 import PasswordHasher
from argon2.exceptions import VerifyMismatchError
from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pymongo.errors import DuplicateKeyError

from .config import (
    ACCESS_TOKEN_TTL_MINUTES,
    JWT_ALGORITHM,
    JWT_AUDIENCE,
    JWT_ISSUER,
    JWT_SECRET_KEY,
    REFRESH_TOKEN_HASH_SECRET,
    REFRESH_TOKEN_TTL_DAYS,
)
from .db import now_iso, sessions_collection, users_collection

password_hasher = PasswordHasher()
security = HTTPBearer(auto_error=False)


class AuthError(Exception):
    pass


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _parse_iso_datetime(value: Any) -> datetime | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        return datetime.fromisoformat(value)
    except ValueError:
        return None


def _require_jwt_secret() -> str:
    if not JWT_SECRET_KEY:
        raise AuthError("JWT_SECRET_KEY is missing")
    return JWT_SECRET_KEY


def _token_hash_secret() -> bytes:
    secret = REFRESH_TOKEN_HASH_SECRET or JWT_SECRET_KEY
    if not secret:
        raise AuthError("Set JWT_SECRET_KEY or REFRESH_TOKEN_HASH_SECRET")
    return secret.encode("utf-8")


def hash_password(password: str) -> str:
    return password_hasher.hash(password)


def verify_password(password: str, password_hash: str) -> bool:
    try:
        return password_hasher.verify(password_hash, password)
    except VerifyMismatchError:
        return False
    except Exception:
        return False


def hash_refresh_token(token: str) -> str:
    digest = hmac.new(_token_hash_secret(), token.encode("utf-8"), hashlib.sha256)
    return digest.hexdigest()


def _create_token(payload: dict[str, Any], expires_delta: timedelta) -> str:
    now = _utc_now()
    claims = {
        **payload,
        "iss": JWT_ISSUER,
        "aud": JWT_AUDIENCE,
        "iat": int(now.timestamp()),
        "nbf": int(now.timestamp()),
        "exp": int((now + expires_delta).timestamp()),
    }
    return jwt.encode(claims, _require_jwt_secret(), algorithm=JWT_ALGORITHM)


def create_access_token(user: dict[str, Any]) -> str:
    return _create_token(
        {
            "sub": str(user.get("id") or ""),
            "email": str(user.get("email") or ""),
            "type": "access",
        },
        timedelta(minutes=ACCESS_TOKEN_TTL_MINUTES),
    )


def create_refresh_token(session_id: str, user_id: str) -> str:
    return _create_token(
        {
            "sub": user_id,
            "sid": session_id,
            "type": "refresh",
            "jti": str(uuid4()),
        },
        timedelta(days=REFRESH_TOKEN_TTL_DAYS),
    )


def decode_token(token: str, expected_type: str) -> dict[str, Any]:
    try:
        payload = jwt.decode(
            token,
            _require_jwt_secret(),
            algorithms=[JWT_ALGORITHM],
            audience=JWT_AUDIENCE,
            issuer=JWT_ISSUER,
        )
    except jwt.InvalidTokenError as exc:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token") from exc

    token_type = payload.get("type")
    if token_type != expected_type:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token type")
    return payload


def create_session(user: dict[str, Any], user_agent: str | None = None, ip_address: str | None = None) -> dict[str, Any]:
    user_id = str(user.get("id") or "")
    session_id = str(uuid4())
    refresh_token = create_refresh_token(session_id, user_id)
    now = _utc_now()
    expires_at = now + timedelta(days=REFRESH_TOKEN_TTL_DAYS)

    sessions_collection().insert_one(
        {
            "id": session_id,
            "user_id": user_id,
            "refresh_token_hash": hash_refresh_token(refresh_token),
            "user_agent": (user_agent or "").strip() or None,
            "ip_address": (ip_address or "").strip() or None,
            "created_at": now_iso(),
            "updated_at": now_iso(),
            "expires_at": expires_at.isoformat(),
            "revoked_at": None,
            "replaced_by": None,
        }
    )

    access_token = create_access_token(user)
    return {
        "access_token": access_token,
        "refresh_token": refresh_token,
        "token_type": "bearer",
        "access_token_expires_in": ACCESS_TOKEN_TTL_MINUTES * 60,
        "refresh_token_expires_in": REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60,
    }


def _sanitize_user(user: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": str(user.get("id") or ""),
        "email": str(user.get("email") or ""),
        "name": str(user.get("name") or ""),
        "created_at": str(user.get("created_at") or ""),
        "updated_at": str(user.get("updated_at") or ""),
    }


def authenticate_user(email: str, password: str) -> dict[str, Any] | None:
    normalized = email.strip().lower()
    user = users_collection().find_one({"email": normalized}, {"_id": 0})
    if not user:
        return None
    if not verify_password(password, str(user.get("password_hash") or "")):
        return None
    return user


def register_user(email: str, password: str, name: str = "") -> dict[str, Any]:
    normalized_email = email.strip().lower()
    clean_name = name.strip()
    if "@" not in normalized_email or "." not in normalized_email.split("@")[-1]:
        raise HTTPException(status_code=400, detail="Invalid email")
    if len(password) < 10:
        raise HTTPException(status_code=400, detail="Password must be at least 10 characters")

    existing = users_collection().find_one({"email": normalized_email}, {"_id": 1})
    if existing:
        raise HTTPException(status_code=409, detail="Email already registered")

    now = now_iso()
    user = {
        "id": str(uuid4()),
        "email": normalized_email,
        "name": clean_name,
        "password_hash": hash_password(password),
        "created_at": now,
        "updated_at": now,
    }
    try:
        users_collection().insert_one(user)
    except DuplicateKeyError as exc:
        raise HTTPException(status_code=409, detail="Email already registered") from exc
    return user


def get_session_from_refresh_token(refresh_token: str) -> tuple[dict[str, Any], dict[str, Any]]:
    payload = decode_token(refresh_token, expected_type="refresh")
    user_id = str(payload.get("sub") or "")
    session_id = str(payload.get("sid") or "")
    if not user_id or not session_id:
        raise HTTPException(status_code=401, detail="Invalid refresh token payload")

    token_hash = hash_refresh_token(refresh_token)
    session = sessions_collection().find_one({"id": session_id, "user_id": user_id}, {"_id": 0})
    if not session:
        raise HTTPException(status_code=401, detail="Session not found")
    if session.get("revoked_at"):
        raise HTTPException(status_code=401, detail="Session revoked")
    if session.get("refresh_token_hash") != token_hash:
        raise HTTPException(status_code=401, detail="Refresh token mismatch")
    expires_at = _parse_iso_datetime(session.get("expires_at"))
    if expires_at and expires_at < _utc_now():
        raise HTTPException(status_code=401, detail="Session expired")

    user = users_collection().find_one({"id": user_id}, {"_id": 0})
    if not user:
        raise HTTPException(status_code=401, detail="User not found")

    return user, session


def rotate_refresh_token(refresh_token: str, user_agent: str | None = None, ip_address: str | None = None) -> dict[str, Any]:
    user, session = get_session_from_refresh_token(refresh_token)
    now = now_iso()
    replacement_session_id = str(uuid4())
    new_refresh_token = create_refresh_token(replacement_session_id, str(user.get("id") or ""))

    sessions_collection().update_one(
        {"id": str(session.get("id") or "")},
        {"$set": {"revoked_at": now, "replaced_by": replacement_session_id, "updated_at": now}},
    )

    sessions_collection().insert_one(
        {
            "id": replacement_session_id,
            "user_id": str(user.get("id") or ""),
            "refresh_token_hash": hash_refresh_token(new_refresh_token),
            "user_agent": (user_agent or "").strip() or session.get("user_agent"),
            "ip_address": (ip_address or "").strip() or session.get("ip_address"),
            "created_at": now,
            "updated_at": now,
            "expires_at": (_utc_now() + timedelta(days=REFRESH_TOKEN_TTL_DAYS)).isoformat(),
            "revoked_at": None,
            "replaced_by": None,
        }
    )

    return {
        "access_token": create_access_token(user),
        "refresh_token": new_refresh_token,
        "token_type": "bearer",
        "access_token_expires_in": ACCESS_TOKEN_TTL_MINUTES * 60,
        "refresh_token_expires_in": REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60,
    }


def revoke_session(refresh_token: str) -> None:
    payload = decode_token(refresh_token, expected_type="refresh")
    user_id = str(payload.get("sub") or "")
    session_id = str(payload.get("sid") or "")
    if not user_id or not session_id:
        return

    token_hash = hash_refresh_token(refresh_token)
    sessions_collection().update_one(
        {
            "id": session_id,
            "user_id": user_id,
            "refresh_token_hash": token_hash,
            "revoked_at": None,
        },
        {"$set": {"revoked_at": now_iso(), "updated_at": now_iso()}},
    )


def get_current_user(credentials: HTTPAuthorizationCredentials | None = Depends(security)) -> dict[str, Any]:
    if credentials is None or credentials.scheme.lower() != "bearer":
        raise HTTPException(status_code=401, detail="Missing bearer token")

    payload = decode_token(credentials.credentials, expected_type="access")
    user_id = str(payload.get("sub") or "")
    if not user_id:
        raise HTTPException(status_code=401, detail="Invalid access token payload")

    user = users_collection().find_one({"id": user_id}, {"_id": 0})
    if not user:
        raise HTTPException(status_code=401, detail="User not found")

    return user


def public_user(user: dict[str, Any]) -> dict[str, Any]:
    return _sanitize_user(user)
