from __future__ import annotations

import io
import shutil
from pathlib import Path
from uuid import uuid4

from bson import ObjectId
from fastapi import Depends, FastAPI, File, Form, HTTPException, Query, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from gridfs import GridFSBucket
from pydantic import BaseModel, Field

from .config import APP_ORIGIN, AUDIO_DIR, COVER_DIR, STORE_AUDIO_IN_GRIDFS
from .auth import (
    AuthError,
    authenticate_user,
    create_session,
    get_current_user,
    public_user,
    register_user,
    revoke_session,
    rotate_refresh_token,
)
from .db import (
    chunks_collection,
    init_db,
    memories_collection,
    memory_to_response,
    now_iso,
    playback_collection,
    users_collection,
    get_db,
)
from .rag import index_transcript, join_context, retrieve
from .services import (
    fallback_story_from_transcript,
    generate_cover_svg,
    infer_mood_tag,
    transcribe_with_elevenlabs,
)

app = FastAPI(title="Virsa AI", version="0.2.0")

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


class RegisterRequest(BaseModel):
    email: str = Field(min_length=3, max_length=320)
    password: str = Field(min_length=10, max_length=1024)
    name: str = Field(default="", max_length=120)


class LoginRequest(BaseModel):
    email: str = Field(min_length=3, max_length=320)
    password: str = Field(min_length=1, max_length=1024)


class RefreshRequest(BaseModel):
    refresh_token: str = Field(min_length=20, max_length=4096)


class LogoutRequest(BaseModel):
    refresh_token: str = Field(min_length=20, max_length=4096)


def _request_client_meta(request: Request) -> tuple[str | None, str | None]:
    user_agent = request.headers.get("user-agent")
    forwarded_for = request.headers.get("x-forwarded-for", "")
    remote_ip = forwarded_for.split(",")[0].strip() if forwarded_for else None
    if not remote_ip and request.client:
        remote_ip = request.client.host
    return user_agent, remote_ip


@app.post("/api/auth/register")
def auth_register(body: RegisterRequest, request: Request) -> dict:
    try:
        user = register_user(body.email, body.password, body.name)
        user_agent, remote_ip = _request_client_meta(request)
        tokens = create_session(user, user_agent=user_agent, ip_address=remote_ip)
    except AuthError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc

    return {
        "user": public_user(user),
        **tokens,
    }


@app.post("/api/auth/login")
def auth_login(body: LoginRequest, request: Request) -> dict:
    user = authenticate_user(body.email, body.password)
    if not user:
        raise HTTPException(status_code=401, detail="Invalid email or password")
    try:
        user_agent, remote_ip = _request_client_meta(request)
        tokens = create_session(user, user_agent=user_agent, ip_address=remote_ip)
    except AuthError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc

    return {
        "user": public_user(user),
        **tokens,
    }


@app.post("/api/auth/refresh")
def auth_refresh(body: RefreshRequest, request: Request) -> dict:
    try:
        user_agent, remote_ip = _request_client_meta(request)
        return rotate_refresh_token(body.refresh_token, user_agent=user_agent, ip_address=remote_ip)
    except AuthError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.post("/api/auth/logout")
def auth_logout(body: LogoutRequest) -> dict:
    revoke_session(body.refresh_token)
    return {"status": "ok"}


@app.get("/api/auth/me")
def auth_me(user: dict = Depends(get_current_user)) -> dict:
    return {"user": public_user(user)}


def _gridfs_bucket() -> GridFSBucket:
    return GridFSBucket(get_db())


def _extract_audio_path(memory: dict) -> str:
    audio = memory.get("audio")
    if isinstance(audio, dict):
        local_path = audio.get("local_path")
        if isinstance(local_path, str):
            return local_path
    path = memory.get("audio_path")
    return path if isinstance(path, str) else ""


def resolve_audio_file(memory_id: str, stored_path: str) -> Path | None:
    raw = (stored_path or "").strip()
    if raw:
        candidate = Path(raw)
        if candidate.exists():
            return candidate
        if not candidate.is_absolute():
            from_audio_dir = AUDIO_DIR / candidate
            if from_audio_dir.exists():
                return from_audio_dir

    matches = sorted(AUDIO_DIR.glob(f"{memory_id}.*"))
    return matches[0] if matches else None


def _materialize_audio(memory: dict) -> Path | None:
    memory_id = str(memory.get("id") or "")
    local = resolve_audio_file(memory_id, _extract_audio_path(memory))
    if local:
        return local

    audio = memory.get("audio")
    if not isinstance(audio, dict):
        return None

    gridfs_id = audio.get("gridfs_id")
    if not isinstance(gridfs_id, str) or not gridfs_id:
        return None

    filename = str(audio.get("filename") or f"{memory_id}.webm")
    ext = Path(filename).suffix or ".webm"
    out_path = AUDIO_DIR / f"{memory_id}{ext}"

    try:
        grid_out = _gridfs_bucket().open_download_stream(ObjectId(gridfs_id))
        data = grid_out.read()
        out_path.write_bytes(data)
        return out_path
    except Exception:
        return None


@app.post("/api/memories")
async def create_memory(
    audio: UploadFile = File(...),
    title: str = Form(default="Untitled Memory"),
    speaker_tag: str = Form(default=""),
    user_id: str | None = Form(default=None),
) -> dict:
    if not audio.filename:
        raise HTTPException(status_code=400, detail="Audio filename missing")

    memory_id = str(uuid4())
    ext = Path(audio.filename).suffix or ".webm"
    audio_path = AUDIO_DIR / f"{memory_id}{ext}"

    with audio_path.open("wb") as buffer:
        shutil.copyfileobj(audio.file, buffer)

    gridfs_id: str | None = None
    if STORE_AUDIO_IN_GRIDFS:
        try:
            audio_bytes = audio_path.read_bytes()
            gridfs_oid = _gridfs_bucket().upload_from_stream(
                filename=audio.filename,
                source=audio_bytes,
                metadata={
                    "memory_id": memory_id,
                    "content_type": audio.content_type or "audio/webm",
                },
            )
            gridfs_id = str(gridfs_oid)
        except Exception:
            gridfs_id = None

    now = now_iso()
    clean_title = title.strip() or "Untitled Memory"
    clean_speaker_tag = speaker_tag.strip()
    clean_user_id = (user_id or "").strip() or None

    memories_collection().insert_one(
        {
            "id": memory_id,
            "title": clean_title,
            "speaker_tag": clean_speaker_tag,
            "audio": {
                "filename": audio.filename,
                "mime_type": audio.content_type or "audio/webm",
                "local_path": str(audio_path),
                "gridfs_id": gridfs_id,
            },
            "transcript": "",
            "transcript_timing": [],
            "story_short": "",
            "story_long": "",
            "cover_path": "",
            "mood_tag": "unknown",
            "ai_summary": "",
            "ai_summary_status": "pending",
            "embedding_status": {
                "indexed": False,
                "chunk_count": 0,
                "model": "",
                "indexed_at": "",
            },
            # Account provision: nullable until auth is wired.
            "user_id": clean_user_id,
            "created_at": now,
            "updated_at": now,
        }
    )

    return {
        "id": memory_id,
        "title": clean_title,
        "speaker_tag": clean_speaker_tag,
        "audio_path": f"/api/memories/{memory_id}/audio",
        "audio_url": f"/api/memories/{memory_id}/audio",
    }


@app.get("/api/memories")
def list_memories() -> dict:
    rows = list(memories_collection().find({}, {"_id": 0}).sort("created_at", -1))
    return {"items": [memory_to_response(row) for row in rows]}


@app.get("/api/memories/{memory_id}")
def get_memory(memory_id: str) -> dict:
    row = memories_collection().find_one({"id": memory_id}, {"_id": 0})
    if not row:
        raise HTTPException(status_code=404, detail="Memory not found")
    return memory_to_response(row)


@app.get("/api/memories/{memory_id}/audio")
def get_memory_audio(memory_id: str):
    row = memories_collection().find_one({"id": memory_id}, {"_id": 0})
    if not row:
        raise HTTPException(status_code=404, detail="Memory not found")

    audio_meta = row.get("audio") if isinstance(row.get("audio"), dict) else {}
    gridfs_id = audio_meta.get("gridfs_id") if isinstance(audio_meta, dict) else None
    if isinstance(gridfs_id, str) and gridfs_id:
        try:
            grid_out = _gridfs_bucket().open_download_stream(ObjectId(gridfs_id))
            data = grid_out.read()
            media_type = str(audio_meta.get("mime_type") or "audio/webm")
            return StreamingResponse(io.BytesIO(data), media_type=media_type)
        except Exception:
            pass

    audio_path = resolve_audio_file(memory_id, _extract_audio_path(row))
    if not audio_path:
        raise HTTPException(status_code=404, detail="Audio file not found")
    return FileResponse(audio_path)


@app.post("/api/memories/{memory_id}/transcribe")
async def transcribe_memory(memory_id: str) -> dict:
    row = memories_collection().find_one({"id": memory_id}, {"_id": 0})
    if not row:
        raise HTTPException(status_code=404, detail="Memory not found")

    audio_path = _materialize_audio(row)
    if not audio_path:
        raise HTTPException(status_code=404, detail="Audio file not found")

    transcript, transcript_timing, ok, message = await transcribe_with_elevenlabs(audio_path)
    if not ok:
        raise HTTPException(status_code=502, detail=message)

    chunk_count, embedding_model = index_transcript(memory_id, transcript)
    mood_tag = infer_mood_tag(transcript)

    memories_collection().update_one(
        {"id": memory_id},
        {
            "$set": {
                "transcript": transcript,
                "transcript_timing": transcript_timing,
                "audio.local_path": str(audio_path),
                "mood_tag": mood_tag,
                "embedding_status": {
                    "indexed": chunk_count > 0,
                    "chunk_count": chunk_count,
                    "model": embedding_model,
                    "indexed_at": now_iso(),
                },
                "updated_at": now_iso(),
            }
        },
    )

    return {
        "id": memory_id,
        "transcript": transcript,
        "transcript_timing": transcript_timing,
        "mood_tag": mood_tag,
        "chunks_indexed": chunk_count,
        "embedding_model": embedding_model,
    }


@app.post("/api/memories/{memory_id}/story")
def build_story(memory_id: str, prompt: str = Form(default="Create a heartfelt family story.")) -> dict:
    row = memories_collection().find_one({"id": memory_id}, {"_id": 0})
    if not row:
        raise HTTPException(status_code=404, detail="Memory not found")

    transcript = str(row.get("transcript") or "")
    if not transcript:
        raise HTTPException(status_code=400, detail="Transcribe this memory before generating a story")

    relevant_chunks = retrieve(memory_id, prompt, top_k=5)
    context = join_context(relevant_chunks)
    short_story, long_story = fallback_story_from_transcript(transcript, context)

    summary = short_story[:240]

    memories_collection().update_one(
        {"id": memory_id},
        {
            "$set": {
                "story_short": short_story,
                "story_long": long_story,
                "ai_summary": summary,
                "ai_summary_status": "generated_fallback",
                "updated_at": now_iso(),
            }
        },
    )

    return {
        "id": memory_id,
        "prompt": prompt,
        "context": relevant_chunks,
        "story_short": short_story,
        "story_long": long_story,
        "ai_summary": summary,
    }


@app.post("/api/memories/{memory_id}/cover")
def build_cover(memory_id: str, prompt: str = Form(default="Warm family storybook illustration")) -> dict:
    row = memories_collection().find_one({"id": memory_id}, {"_id": 0, "title": 1})
    if not row:
        raise HTTPException(status_code=404, detail="Memory not found")

    cover_path = generate_cover_svg(memory_id, str(row.get("title") or "Untitled"), prompt)
    memories_collection().update_one(
        {"id": memory_id},
        {"$set": {"cover_path": cover_path, "updated_at": now_iso()}},
    )

    return {"id": memory_id, "cover_url": f"/covers/{memory_id}.svg"}


def _viewer_key(user_id: str | None, device_id: str | None) -> str:
    clean_user_id = (user_id or "").strip()
    if clean_user_id:
        return f"user:{clean_user_id}"
    clean_device_id = (device_id or "").strip() or "anonymous"
    return f"device:{clean_device_id}"


@app.post("/api/memories/{memory_id}/playback")
def save_playback_position(
    memory_id: str,
    position_seconds: float = Form(...),
    user_id: str | None = Form(default=None),
    device_id: str | None = Form(default="anonymous"),
) -> dict:
    memory = memories_collection().find_one({"id": memory_id}, {"_id": 0, "id": 1})
    if not memory:
        raise HTTPException(status_code=404, detail="Memory not found")

    safe_position = max(0.0, float(position_seconds))
    key = _viewer_key(user_id, device_id)
    now = now_iso()

    playback_collection().update_one(
        {"memory_id": memory_id, "viewer_key": key},
        {
            "$set": {
                "memory_id": memory_id,
                "viewer_key": key,
                "user_id": (user_id or "").strip() or None,
                "device_id": (device_id or "").strip() or None,
                "position_seconds": safe_position,
                "updated_at": now,
            },
            "$setOnInsert": {"created_at": now},
        },
        upsert=True,
    )

    return {
        "memory_id": memory_id,
        "position_seconds": safe_position,
        "user_id": (user_id or "").strip() or None,
        "device_id": (device_id or "").strip() or None,
        "updated_at": now,
    }


@app.get("/api/memories/{memory_id}/playback")
def get_playback_position(
    memory_id: str,
    user_id: str | None = Query(default=None),
    device_id: str | None = Query(default="anonymous"),
) -> dict:
    memory = memories_collection().find_one({"id": memory_id}, {"_id": 0, "id": 1})
    if not memory:
        raise HTTPException(status_code=404, detail="Memory not found")

    key = _viewer_key(user_id, device_id)
    row = playback_collection().find_one({"memory_id": memory_id, "viewer_key": key}, {"_id": 0})
    if not row:
        return {
            "memory_id": memory_id,
            "position_seconds": 0.0,
            "user_id": (user_id or "").strip() or None,
            "device_id": (device_id or "").strip() or None,
            "updated_at": "",
        }

    return {
        "memory_id": memory_id,
        "position_seconds": float(row.get("position_seconds") or 0.0),
        "user_id": row.get("user_id"),
        "device_id": row.get("device_id"),
        "updated_at": row.get("updated_at") or "",
    }


@app.get("/api/users/provision")
def users_provision_hint() -> dict:
    return {
        "message": "User/account auth is enabled.",
        "users_collection": users_collection().name,
        "auth_endpoints": [
            "/api/auth/register",
            "/api/auth/login",
            "/api/auth/refresh",
            "/api/auth/logout",
            "/api/auth/me",
        ],
        "linking_strategy": "memories.user_id and playback_positions.user_id",
    }


@app.get("/api/admin/chunks/{memory_id}")
def inspect_chunks(memory_id: str) -> dict:
    rows = list(chunks_collection().find({"memory_id": memory_id}, {"_id": 0}).sort("idx", 1))
    return {"items": rows}
