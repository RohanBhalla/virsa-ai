from __future__ import annotations

import shutil
from pathlib import Path
from uuid import uuid4

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from .config import APP_ORIGIN, AUDIO_DIR, COVER_DIR
from .db import get_conn, init_db, now_iso, row_to_memory
from .rag import index_transcript, join_context, retrieve
from .services import fallback_story_from_transcript, generate_cover_svg, transcribe_with_elevenlabs

app = FastAPI(title="Virsa AI", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=[APP_ORIGIN, "http://localhost:3000", "http://localhost:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
def on_startup() -> None:
    init_db()


app.mount("/covers", StaticFiles(directory=COVER_DIR), name="covers")


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/api/memories")
async def create_memory(
    audio: UploadFile = File(...),
    title: str = Form(default="Untitled Memory"),
) -> dict:
    if not audio.filename:
        raise HTTPException(status_code=400, detail="Audio filename missing")

    memory_id = str(uuid4())
    ext = Path(audio.filename).suffix or ".webm"
    audio_path = AUDIO_DIR / f"{memory_id}{ext}"

    with audio_path.open("wb") as buffer:
        shutil.copyfileobj(audio.file, buffer)

    now = now_iso()
    with get_conn() as conn:
        conn.execute(
            """
            INSERT INTO memories(id, title, audio_path, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?)
            """,
            (memory_id, title.strip() or "Untitled Memory", str(audio_path), now, now),
        )

    return {"id": memory_id, "title": title, "audio_url": f"/api/memories/{memory_id}/audio"}


@app.get("/api/memories")
def list_memories() -> dict:
    with get_conn() as conn:
        rows = conn.execute("SELECT * FROM memories ORDER BY created_at DESC").fetchall()
    return {"items": [row_to_memory(row) for row in rows]}


@app.get("/api/memories/{memory_id}")
def get_memory(memory_id: str) -> dict:
    with get_conn() as conn:
        row = conn.execute("SELECT * FROM memories WHERE id = ?", (memory_id,)).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Memory not found")
    return row_to_memory(row)


@app.get("/api/memories/{memory_id}/audio")
def get_memory_audio(memory_id: str) -> FileResponse:
    with get_conn() as conn:
        row = conn.execute("SELECT audio_path FROM memories WHERE id = ?", (memory_id,)).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Memory not found")

    audio_path = Path(row["audio_path"])
    if not audio_path.exists():
        raise HTTPException(status_code=404, detail="Audio file not found")
    return FileResponse(audio_path)


@app.post("/api/memories/{memory_id}/transcribe")
async def transcribe_memory(memory_id: str) -> dict:
    with get_conn() as conn:
        row = conn.execute("SELECT * FROM memories WHERE id = ?", (memory_id,)).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Memory not found")

    audio_path = Path(row["audio_path"])
    if not audio_path.exists():
        raise HTTPException(status_code=404, detail="Audio file not found")

    transcript, ok, message = await transcribe_with_elevenlabs(audio_path)
    if not ok:
        raise HTTPException(status_code=502, detail=message)

    chunk_count = index_transcript(memory_id, transcript)
    with get_conn() as conn:
        conn.execute(
            "UPDATE memories SET transcript = ?, updated_at = ? WHERE id = ?",
            (transcript, now_iso(), memory_id),
        )

    return {"id": memory_id, "transcript": transcript, "chunks_indexed": chunk_count}


@app.post("/api/memories/{memory_id}/story")
def build_story(memory_id: str, prompt: str = Form(default="Create a heartfelt family story.")) -> dict:
    with get_conn() as conn:
        row = conn.execute("SELECT * FROM memories WHERE id = ?", (memory_id,)).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Memory not found")

    transcript = row["transcript"] or ""
    if not transcript:
        raise HTTPException(status_code=400, detail="Transcribe this memory before generating a story")

    relevant_chunks = retrieve(memory_id, prompt, top_k=5)
    context = join_context(relevant_chunks)
    short_story, long_story = fallback_story_from_transcript(transcript, context)

    with get_conn() as conn:
        conn.execute(
            """
            UPDATE memories
            SET story_short = ?, story_long = ?, updated_at = ?
            WHERE id = ?
            """,
            (short_story, long_story, now_iso(), memory_id),
        )

    return {
        "id": memory_id,
        "prompt": prompt,
        "context": relevant_chunks,
        "story_short": short_story,
        "story_long": long_story,
    }


@app.post("/api/memories/{memory_id}/cover")
def build_cover(memory_id: str, prompt: str = Form(default="Warm family storybook illustration")) -> dict:
    with get_conn() as conn:
        row = conn.execute("SELECT title FROM memories WHERE id = ?", (memory_id,)).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Memory not found")

    cover_path = generate_cover_svg(memory_id, row["title"] or "Untitled", prompt)
    with get_conn() as conn:
        conn.execute(
            "UPDATE memories SET cover_path = ?, updated_at = ? WHERE id = ?",
            (cover_path, now_iso(), memory_id),
        )

    return {"id": memory_id, "cover_url": f"/covers/{memory_id}.svg"}
