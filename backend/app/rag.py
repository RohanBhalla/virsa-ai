from __future__ import annotations

import json
import math
import re
from collections import Counter
from datetime import datetime, timezone
from typing import Iterable

from .db import get_conn

WORD_RE = re.compile(r"[a-zA-Z']+")


def _tokenize(text: str) -> list[str]:
    return [w.lower() for w in WORD_RE.findall(text)]


def chunk_text(text: str, max_words: int = 80) -> list[str]:
    words = text.split()
    if not words:
        return []
    chunks: list[str] = []
    for i in range(0, len(words), max_words):
        chunks.append(" ".join(words[i : i + max_words]))
    return chunks


def _to_blob(counter: Counter[str]) -> str:
    return json.dumps(counter)


def _from_blob(blob: str) -> Counter[str]:
    data = json.loads(blob)
    return Counter({k: int(v) for k, v in data.items()})


def _cosine(a: Counter[str], b: Counter[str]) -> float:
    common = set(a) & set(b)
    numerator = sum(a[t] * b[t] for t in common)
    if numerator == 0:
        return 0.0
    a_norm = math.sqrt(sum(v * v for v in a.values()))
    b_norm = math.sqrt(sum(v * v for v in b.values()))
    if a_norm == 0 or b_norm == 0:
        return 0.0
    return numerator / (a_norm * b_norm)


def index_transcript(memory_id: str, transcript: str) -> int:
    chunks = chunk_text(transcript)
    now = datetime.now(timezone.utc).isoformat()
    with get_conn() as conn:
        conn.execute("DELETE FROM chunks WHERE memory_id = ?", (memory_id,))
        for idx, chunk in enumerate(chunks):
            tokens = Counter(_tokenize(chunk))
            conn.execute(
                """
                INSERT INTO chunks(memory_id, idx, content, token_blob, created_at)
                VALUES (?, ?, ?, ?, ?)
                """,
                (memory_id, idx, chunk, _to_blob(tokens), now),
            )
    return len(chunks)


def retrieve(memory_id: str, query: str, top_k: int = 4) -> list[str]:
    q_tokens = Counter(_tokenize(query))
    if not q_tokens:
        return []
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT content, token_blob FROM chunks WHERE memory_id = ?", (memory_id,)
        ).fetchall()
    scored: list[tuple[float, str]] = []
    for row in rows:
        score = _cosine(q_tokens, _from_blob(row["token_blob"]))
        if score > 0:
            scored.append((score, row["content"]))
    scored.sort(key=lambda item: item[0], reverse=True)
    return [c for _, c in scored[:top_k]]


def join_context(chunks: Iterable[str]) -> str:
    return "\n\n".join(chunks)
