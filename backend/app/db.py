from __future__ import annotations

from datetime import datetime, timezone
from functools import lru_cache
from typing import Any

import certifi
from pymongo import ASCENDING, DESCENDING, MongoClient
from pymongo.collection import Collection
from pymongo.database import Database

from .config import (
    MONGODB_DB_NAME,
    MONGODB_URI,
    MONGODB_CHUNKS_COLLECTION,
    MONGODB_MEMORIES_COLLECTION,
    MONGODB_PLAYBACK_COLLECTION,
    MONGODB_AUTH_SESSIONS_COLLECTION,
    MONGODB_USERS_COLLECTION,
    MONGODB_FAMILY_PEOPLE_COLLECTION,
    MONGODB_FAMILY_EDGES_COLLECTION,
)


@lru_cache(maxsize=1)
def get_client() -> MongoClient:
    return MongoClient(
        MONGODB_URI,
        appname="virsa-ai",
        tlsCAFile=certifi.where(),
    )


@lru_cache(maxsize=1)
def get_db() -> Database:
    return get_client()[MONGODB_DB_NAME]


def memories_collection() -> Collection:
    return get_db()[MONGODB_MEMORIES_COLLECTION]


def chunks_collection() -> Collection:
    return get_db()[MONGODB_CHUNKS_COLLECTION]


def playback_collection() -> Collection:
    return get_db()[MONGODB_PLAYBACK_COLLECTION]


def users_collection() -> Collection:
    return get_db()[MONGODB_USERS_COLLECTION]


def sessions_collection() -> Collection:
    return get_db()[MONGODB_AUTH_SESSIONS_COLLECTION]


def family_people_collection() -> Collection:
    return get_db()[MONGODB_FAMILY_PEOPLE_COLLECTION]


def family_edges_collection() -> Collection:
    return get_db()[MONGODB_FAMILY_EDGES_COLLECTION]


def init_db() -> None:
    memories_collection().create_index([("id", ASCENDING)], unique=True)
    memories_collection().create_index([("created_at", DESCENDING)])
    memories_collection().create_index([("user_id", ASCENDING)], sparse=True)

    chunks_collection().create_index([("memory_id", ASCENDING), ("idx", ASCENDING)], unique=True)
    chunks_collection().create_index([("memory_id", ASCENDING)])
    chunks_collection().create_index([("user_id", ASCENDING)], sparse=True)

    # One playback position per (memory + viewer key). Viewer key can map to a
    # future account user_id or current anonymous device_id.
    playback_collection().create_index([("memory_id", ASCENDING), ("viewer_key", ASCENDING)], unique=True)
    playback_collection().create_index([("updated_at", DESCENDING)])

    users_collection().create_index([("id", ASCENDING)], unique=True)
    users_collection().create_index([("email", ASCENDING)], unique=True, sparse=True)
    users_collection().create_index([("created_at", DESCENDING)])

    sessions_collection().create_index([("id", ASCENDING)], unique=True)
    sessions_collection().create_index([("user_id", ASCENDING), ("created_at", DESCENDING)])
    sessions_collection().create_index([("expires_at", ASCENDING)])

    family_people_collection().create_index([("id", ASCENDING)], unique=True)
    family_people_collection().create_index([("family_id", ASCENDING)])
    family_people_collection().create_index([("owner_user_id", ASCENDING), ("family_id", ASCENDING)])

    family_edges_collection().create_index([("id", ASCENDING)], unique=True)
    family_edges_collection().create_index([("family_id", ASCENDING)])
    family_edges_collection().create_index([("family_id", ASCENDING), ("from_person_id", ASCENDING)])
    family_edges_collection().create_index([("family_id", ASCENDING), ("to_person_id", ASCENDING)])


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _safe_str(value: Any) -> str:
    return value if isinstance(value, str) else ""


def _safe_list(value: Any) -> list[Any]:
    return value if isinstance(value, list) else []


def memory_to_response(memory: dict[str, Any]) -> dict[str, Any]:
    memory_id = _safe_str(memory.get("id"))

    transcript_timing = _safe_list(memory.get("transcript_timing"))
    mood_tag = _safe_str(memory.get("mood_tag"))
    themes = _safe_list(memory.get("themes"))
    ai_summary = _safe_str(memory.get("ai_summary"))
    ai_summary_status = _safe_str(memory.get("ai_summary_status"))

    # Keep existing response fields stable for frontend compatibility.
    return {
        "id": memory_id,
        "title": _safe_str(memory.get("title")),
        "speaker_tag": _safe_str(memory.get("speaker_tag")),
        "speaker_person_id": _safe_str(memory.get("speaker_person_id")),
        "family_id": _safe_str(memory.get("family_id")),
        "audio_path": f"/api/memories/{memory_id}/audio",
        "audio_url": f"/api/memories/{memory_id}/audio",
        "transcript": _safe_str(memory.get("transcript")),
        "transcript_timing": transcript_timing,
        "story_children": _safe_str(memory.get("story_children")),
        "story_narration": _safe_str(memory.get("story_narration")),
        "cover_path": _safe_str(memory.get("cover_path")),
        "cover_status": _safe_str(memory.get("cover_status")),
        "mood_tag": mood_tag,
        "themes": themes,
        "ai_summary": ai_summary,
        "ai_summary_status": ai_summary_status,
        "embedding_status": memory.get("embedding_status") or {
            "indexed": False,
            "chunk_count": 0,
            "model": "",
        },
        "created_at": _safe_str(memory.get("created_at")),
        "updated_at": _safe_str(memory.get("updated_at")),
        # Future account support. Null for now until auth exists.
        "user_id": memory.get("user_id"),
    }
