from __future__ import annotations

import sqlite3
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .config import DB_PATH


def _connect() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


@contextmanager
def get_conn() -> sqlite3.Connection:
    conn = _connect()
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


def init_db() -> None:
    Path(DB_PATH).parent.mkdir(parents=True, exist_ok=True)
    with get_conn() as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS memories (
                id TEXT PRIMARY KEY,
                title TEXT,
                audio_path TEXT NOT NULL,
                transcript TEXT DEFAULT '',
                story_short TEXT DEFAULT '',
                story_long TEXT DEFAULT '',
                cover_path TEXT DEFAULT '',
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS chunks (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                memory_id TEXT NOT NULL,
                idx INTEGER NOT NULL,
                content TEXT NOT NULL,
                token_blob TEXT NOT NULL,
                created_at TEXT NOT NULL,
                FOREIGN KEY(memory_id) REFERENCES memories(id)
            )
            """
        )


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def row_to_memory(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "id": row["id"],
        "title": row["title"],
        "audio_path": row["audio_path"],
        "transcript": row["transcript"],
        "story_short": row["story_short"],
        "story_long": row["story_long"],
        "cover_path": row["cover_path"],
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }
