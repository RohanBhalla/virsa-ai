from __future__ import annotations

import hashlib
import logging
import subprocess
from datetime import datetime, timezone
from functools import lru_cache
from typing import Iterable

logger = logging.getLogger(__name__)

import httpx
from pymongo.errors import OperationFailure

from .config import (
    EMBEDDING_DIM,
    EMBEDDING_PROVIDER,
    GEMINI_API_KEY,
    GEMINI_EMBEDDING_BASE_URL,
    GEMINI_EMBEDDING_MODEL,
    MONGODB_VECTOR_INDEX,
    VERTEX_ACCESS_TOKEN,
    VERTEX_API_KEY,
    VERTEX_EMBEDDING_BASE_URL,
    VERTEX_EMBEDDING_MODEL,
    VERTEX_LOCATION,
    VERTEX_PROJECT_ID,
)
from .db import chunks_collection, memories_collection


def chunk_text(text: str, max_words: int = 80) -> list[str]:
    words = text.split()
    if not words:
        return []
    chunks: list[str] = []
    for i in range(0, len(words), max_words):
        chunks.append(" ".join(words[i : i + max_words]))
    return chunks


def _hash_embedding(text: str, dim: int = EMBEDDING_DIM) -> list[float]:
    # Deterministic local fallback when no embedding provider is configured.
    vec = [0.0] * dim
    for i in range(dim):
        digest = hashlib.sha256(f"{i}:{text}".encode("utf-8")).digest()
        val = int.from_bytes(digest[:4], "big", signed=False)
        vec[i] = ((val % 2000) / 1000.0) - 1.0
    norm = sum(v * v for v in vec) ** 0.5
    if norm == 0:
        return vec
    return [v / norm for v in vec]


def _gemini_embeddings(texts: list[str]) -> list[list[float]]:
    if not GEMINI_API_KEY:
        raise RuntimeError("GEMINI_API_KEY is missing")

    model_name = GEMINI_EMBEDDING_MODEL
    model_ref = model_name if model_name.startswith("models/") else f"models/{model_name}"
    endpoint = f"{GEMINI_EMBEDDING_BASE_URL}/models/{GEMINI_EMBEDDING_MODEL}:embedContent"

    vectors: list[list[float]] = []
    with httpx.Client(timeout=45) as client:
        for text in texts:
            payload = {
                "model": model_ref,
                "content": {"parts": [{"text": text}]},
                "outputDimensionality": EMBEDDING_DIM,
            }
            headers = {"x-goog-api-key": GEMINI_API_KEY, "Content-Type": "application/json"}
            res = client.post(endpoint, params={"key": GEMINI_API_KEY}, headers=headers, json=payload)
            res.raise_for_status()
            body = res.json()
            embedding = body.get("embedding")
            values = embedding.get("values") if isinstance(embedding, dict) else None
            if not isinstance(values, list):
                raise RuntimeError("Missing Gemini embedding vector in response")
            vectors.append([float(x) for x in values])
    return vectors


@lru_cache(maxsize=1)
def _vertex_adc_access_token() -> str:
    try:
        proc = subprocess.run(
            ["gcloud", "auth", "application-default", "print-access-token"],
            capture_output=True,
            text=True,
            check=True,
        )
        return proc.stdout.strip()
    except Exception:
        return ""


def _vertex_embeddings(texts: list[str]) -> list[list[float]]:
    if not VERTEX_PROJECT_ID:
        raise RuntimeError("VERTEX_PROJECT_ID is missing")

    if VERTEX_EMBEDDING_BASE_URL:
        endpoint = VERTEX_EMBEDDING_BASE_URL.rstrip("/")
    else:
        endpoint = f"https://{VERTEX_LOCATION}-aiplatform.googleapis.com"

    model = VERTEX_EMBEDDING_MODEL
    if model.startswith("publishers/google/models/"):
        model_path = model
    else:
        model_path = f"publishers/google/models/{model}"
    url = f"{endpoint}/v1/projects/{VERTEX_PROJECT_ID}/locations/{VERTEX_LOCATION}/{model_path}:predict"

    access_token = VERTEX_ACCESS_TOKEN.strip() or _vertex_adc_access_token()
    headers = {"Content-Type": "application/json"}
    params: dict[str, str] = {}
    if VERTEX_API_KEY:
        params["key"] = VERTEX_API_KEY
        headers["x-goog-api-key"] = VERTEX_API_KEY
    if access_token:
        headers["Authorization"] = f"Bearer {access_token}"

    vectors: list[list[float]] = []
    with httpx.Client(timeout=45) as client:
        for text in texts:
            payload = {
                "instances": [{"content": text, "task_type": "RETRIEVAL_DOCUMENT"}],
                "parameters": {"outputDimensionality": EMBEDDING_DIM, "autoTruncate": True},
            }
            res = client.post(url, params=params or None, headers=headers, json=payload)
            res.raise_for_status()
            body = res.json()
            preds = body.get("predictions")
            if not isinstance(preds, list) or not preds:
                raise RuntimeError("Missing Vertex predictions in embedding response")
            first = preds[0]
            if not isinstance(first, dict):
                raise RuntimeError("Unexpected Vertex prediction payload")
            embeddings = first.get("embeddings")
            values = embeddings.get("values") if isinstance(embeddings, dict) else None
            if not isinstance(values, list):
                raise RuntimeError("Missing Vertex embedding vector in response")
            vectors.append([float(x) for x in values])
    return vectors


def embed_texts(texts: list[str]) -> list[list[float]]:
    if not texts:
        return []
    provider = (EMBEDDING_PROVIDER or "local").lower()

    if provider == "vertex":
        try:
            return _vertex_embeddings(texts)
        except Exception:
            return [_hash_embedding(text) for text in texts]

    if provider == "gemini":
        if GEMINI_API_KEY:
            try:
                return _gemini_embeddings(texts)
            except Exception:
                return [_hash_embedding(text) for text in texts]
        return [_hash_embedding(text) for text in texts]

    return [_hash_embedding(text) for text in texts]


def embedding_model_name() -> str:
    provider = (EMBEDDING_PROVIDER or "local").lower()
    if provider == "vertex" and VERTEX_PROJECT_ID:
        return VERTEX_EMBEDDING_MODEL
    if provider == "gemini" and GEMINI_API_KEY:
        return GEMINI_EMBEDDING_MODEL
    return f"local-hash-{EMBEDDING_DIM}"


def index_transcript(memory_id: str, transcript: str, user_id: str) -> tuple[int, str]:
    chunks = chunk_text(transcript)
    vectors = embed_texts(chunks)

    now = datetime.now(timezone.utc).isoformat()
    col = chunks_collection()
    col.delete_many({"memory_id": memory_id})

    docs = []
    for idx, chunk in enumerate(chunks):
        docs.append(
            {
                "memory_id": memory_id,
                "user_id": user_id,
                "idx": idx,
                "content": chunk,
                "embedding": vectors[idx],
                "embedding_model": embedding_model_name(),
                "created_at": now,
                "updated_at": now,
            }
        )

    if docs:
        col.insert_many(docs)

    return len(chunks), embedding_model_name()


def search_stories(user_id: str, query: str, top_k: int = 10) -> list[tuple[str, float, str]]:
    """Vector search across the current user's memories. Returns list of (memory_id, score, content_snippet)."""
    if not query.strip():
        return []

    query_vector = embed_texts([query])[0]
    col = chunks_collection()
    # Fetch enough chunks so that after filtering by user_id we still have plenty to dedupe
    vector_limit = 300
    num_candidates = max(500, vector_limit * 2)

    # Atlas index may not have user_id/memory_id as filter fields. Run vector search without
    # filter, then $match by user_id so we don't require index changes.
    pipeline = [
        {
            "$vectorSearch": {
                "index": MONGODB_VECTOR_INDEX,
                "path": "embedding",
                "queryVector": query_vector,
                "numCandidates": num_candidates,
                "limit": vector_limit,
            }
        },
        {"$match": {"user_id": user_id}},
        {"$project": {"_id": 0, "memory_id": 1, "content": 1, "score": {"$meta": "vectorSearchScore"}}},
    ]

    rows: list[dict] = []
    path_used = "vector_search_post_filter"

    try:
        rows = list(col.aggregate(pipeline))
    except OperationFailure as e:
        logger.warning("search_stories: vector search (post-filter) failed: %s", e)
        path_used = "fallback_find_one"
        memory_ids = [
            m["id"]
            for m in memories_collection().find({"user_id": user_id}, {"id": 1})
            if m.get("id")
        ]
        rows = []
        for mid in memory_ids[:top_k]:
            chunk_row = col.find_one({"memory_id": mid}, {"_id": 0, "memory_id": 1, "content": 1})
            if chunk_row:
                rows.append({**chunk_row, "score": 0.0})

    def _score_from_item(item: dict) -> float:
        raw = item.get("score")
        if raw is None:
            return 0.0
        if isinstance(raw, (int, float)):
            return float(raw)
        # Atlas can return Decimal128 or other numeric types
        try:
            return float(raw)
        except (TypeError, ValueError):
            pass
        if hasattr(raw, "to_decimal"):
            return float(raw.to_decimal())
        return 0.0

    # Deduplicate by memory_id, keep best score per memory
    seen: dict[str, tuple[float, str]] = {}
    for item in rows:
        mid = item.get("memory_id")
        content = item.get("content") or ""
        score = _score_from_item(item)
        if not mid:
            continue
        if mid not in seen or score > seen[mid][0]:
            seen[mid] = (score, content)

    result = [(mid, sc, snippet) for mid, (sc, snippet) in seen.items()]
    result.sort(key=lambda x: -x[1])
    result = result[:top_k]

    logger.info(
        "search_stories: user_id=%s query=%r path=%s hits=%d",
        user_id,
        query[:80] + ("..." if len(query) > 80 else ""),
        path_used,
        len(result),
    )
    if rows and path_used != "fallback_find_one" and all(_score_from_item(r) == 0.0 for r in rows[:5]):
        # Debug: log raw keys/score from first row when all scores are 0
        first = rows[0]
        logger.info("search_stories: debug first row keys=%s score_raw=%s", list(first.keys()), first.get("score"))
    for rank, (mid, score, snippet) in enumerate(result, start=1):
        preview = (snippet[:60] + "...") if len(snippet) > 60 else snippet
        logger.info(
            "  [%d] memory_id=%s score=%.4f snippet=%r",
            rank,
            mid,
            score,
            preview,
        )

    return result


def retrieve(memory_id: str, query: str, top_k: int = 4) -> list[str]:
    if not query.strip():
        return []

    query_vector = embed_texts([query])[0]
    col = chunks_collection()

    pipeline = [
        {
            "$vectorSearch": {
                "index": MONGODB_VECTOR_INDEX,
                "path": "embedding",
                "queryVector": query_vector,
                "numCandidates": max(top_k * 25, 100),
                "limit": top_k,
                "filter": {"memory_id": memory_id},
            }
        },
        {"$project": {"_id": 0, "content": 1, "score": {"$meta": "vectorSearchScore"}}},
    ]

    try:
        rows = list(col.aggregate(pipeline))
        return [str(item.get("content", "")) for item in rows if item.get("content")]
    except OperationFailure:
        # Fallback when Atlas vector index is not created yet.
        rows = list(col.find({"memory_id": memory_id}).sort("idx", 1).limit(top_k))
        return [str(item.get("content", "")) for item in rows if item.get("content")]


def join_context(chunks: Iterable[str]) -> str:
    return "\n\n".join(chunks)


def _score_from_item(item: dict) -> float:
    raw = item.get("score")
    if raw is None:
        return 0.0
    if isinstance(raw, (int, float)):
        return float(raw)
    try:
        return float(raw)
    except (TypeError, ValueError):
        pass
    if hasattr(raw, "to_decimal"):
        return float(raw.to_decimal())
    return 0.0


def get_memory_centroid(memory_id: str) -> list[float] | None:
    """Return the mean of all chunk embeddings for a memory, or None if no chunks."""
    col = chunks_collection()
    rows = list(col.find({"memory_id": memory_id}, {"_id": 0, "embedding": 1}))
    if not rows:
        return None
    embeddings = [r["embedding"] for r in rows if isinstance(r.get("embedding"), list)]
    if not embeddings:
        return None
    dim = len(embeddings[0])
    centroid = [0.0] * dim
    for vec in embeddings:
        if len(vec) != dim:
            continue
        for i in range(dim):
            centroid[i] += float(vec[i])
    n = len(embeddings)
    centroid = [c / n for c in centroid]
    norm = sum(c * c for c in centroid) ** 0.5
    if norm > 0:
        centroid = [c / norm for c in centroid]
    return centroid


def _vector_search_by_vector(
    user_id: str,
    query_vector: list[float],
    limit: int = 300,
    exclude_memory_id: str | None = None,
) -> list[dict]:
    """Run Atlas $vectorSearch with query_vector; post-filter by user_id. Returns list of {memory_id, score, content}."""
    col = chunks_collection()
    num_candidates = max(500, limit * 2)
    pipeline = [
        {
            "$vectorSearch": {
                "index": MONGODB_VECTOR_INDEX,
                "path": "embedding",
                "queryVector": query_vector,
                "numCandidates": num_candidates,
                "limit": limit,
            }
        },
        {"$match": {"user_id": user_id}},
        {"$project": {"_id": 0, "memory_id": 1, "content": 1, "score": {"$meta": "vectorSearchScore"}}},
    ]
    try:
        rows = list(col.aggregate(pipeline))
    except OperationFailure:
        return []
    if exclude_memory_id:
        rows = [r for r in rows if r.get("memory_id") != exclude_memory_id]
    return rows


def find_related_memories(
    user_id: str, memory_id: str, top_k: int = 10
) -> list[tuple[str, float]]:
    """Return memories similar to the given memory: [(memory_id, score), ...]."""
    centroid = get_memory_centroid(memory_id)
    if not centroid:
        return []
    rows = _vector_search_by_vector(
        user_id, centroid, limit=top_k * 5, exclude_memory_id=memory_id
    )
    seen: dict[str, float] = {}
    for item in rows:
        mid = item.get("memory_id")
        if not mid:
            continue
        score = _score_from_item(item)
        if mid not in seen or score > seen[mid]:
            seen[mid] = score
    result = [(mid, sc) for mid, sc in seen.items()]
    result.sort(key=lambda x: -x[1])
    return result[:top_k]


def get_graph_edges(
    user_id: str,
    memory_ids: list[str],
    top_k_per_node: int = 5,
    min_score: float | None = None,
) -> list[tuple[str, str, float]]:
    """Return list of (source_id, target_id, score) for the graph. Self-edges excluded; only edges between nodes in memory_ids; deduped (unordered pair)."""
    id_set = set(memory_ids)
    edges_set: dict[tuple[str, str], float] = {}
    for memory_id in memory_ids:
        centroid = get_memory_centroid(memory_id)
        if not centroid:
            continue
        rows = _vector_search_by_vector(
            user_id, centroid, limit=top_k_per_node + 5, exclude_memory_id=memory_id
        )
        seen: dict[str, float] = {}
        for item in rows:
            mid = item.get("memory_id")
            if not mid or mid == memory_id or mid not in id_set:
                continue
            score = _score_from_item(item)
            if mid not in seen or score > seen[mid]:
                seen[mid] = score
        for target_id, score in sorted(seen.items(), key=lambda x: -x[1])[:top_k_per_node]:
            if min_score is not None and score < min_score:
                continue
            pair = (memory_id, target_id) if memory_id < target_id else (target_id, memory_id)
            if pair not in edges_set or score > edges_set[pair]:
                edges_set[pair] = score
    return [(a, b, s) for (a, b), s in edges_set.items()]
