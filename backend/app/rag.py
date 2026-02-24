from __future__ import annotations

import hashlib
import subprocess
from datetime import datetime, timezone
from functools import lru_cache
from typing import Iterable

import httpx
from pymongo.errors import OperationFailure

from .config import (
    EMBEDDING_DIM,
    EMBEDDING_PROVIDER,
    GEMINI_API_KEY,
    GEMINI_EMBEDDING_BASE_URL,
    GEMINI_EMBEDDING_MODEL,
    MONGODB_VECTOR_INDEX,
    OPENAI_API_KEY,
    OPENAI_EMBEDDING_MODEL,
    OPENAI_EMBEDDING_URL,
    VERTEX_ACCESS_TOKEN,
    VERTEX_API_KEY,
    VERTEX_EMBEDDING_BASE_URL,
    VERTEX_EMBEDDING_MODEL,
    VERTEX_LOCATION,
    VERTEX_PROJECT_ID,
)
from .db import chunks_collection


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


def _openai_embeddings(texts: list[str]) -> list[list[float]]:
    headers = {
        "Authorization": f"Bearer {OPENAI_API_KEY}",
        "Content-Type": "application/json",
    }
    payload = {
        "model": OPENAI_EMBEDDING_MODEL,
        "input": texts,
    }

    with httpx.Client(timeout=45) as client:
        res = client.post(OPENAI_EMBEDDING_URL, json=payload, headers=headers)
    res.raise_for_status()
    body = res.json()
    data = body.get("data")
    if not isinstance(data, list):
        raise RuntimeError("Invalid embedding response")

    vectors: list[list[float]] = []
    for item in data:
        emb = item.get("embedding") if isinstance(item, dict) else None
        if not isinstance(emb, list):
            raise RuntimeError("Missing embedding vector in response")
        vectors.append([float(x) for x in emb])
    return vectors


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

    if provider == "openai":
        if OPENAI_API_KEY:
            try:
                return _openai_embeddings(texts)
            except Exception:
                return [_hash_embedding(text) for text in texts]
        return [_hash_embedding(text) for text in texts]

    if OPENAI_API_KEY:
        return _openai_embeddings(texts)
    return [_hash_embedding(text) for text in texts]


def embedding_model_name() -> str:
    provider = (EMBEDDING_PROVIDER or "local").lower()
    if provider == "vertex" and VERTEX_PROJECT_ID:
        return VERTEX_EMBEDDING_MODEL
    if provider == "gemini" and GEMINI_API_KEY:
        return GEMINI_EMBEDDING_MODEL
    if provider == "openai" and OPENAI_API_KEY:
        return OPENAI_EMBEDDING_MODEL
    return f"local-hash-{EMBEDDING_DIM}"


def index_transcript(memory_id: str, transcript: str) -> tuple[int, str]:
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
