from __future__ import annotations

import io
import logging
import shutil
import tempfile
from pathlib import Path
from typing import Literal
from uuid import uuid4

logger = logging.getLogger(__name__)

from bson import ObjectId
from fastapi import Depends, FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from gridfs import GridFSBucket
from pydantic import BaseModel, Field

from .config import APP_ORIGIN, AUDIO_DIR, COVER_DIR, STORE_AUDIO_IN_GRIDFS, STORY_AUDIO_DIR, VOICE_SEARCH_LANGUAGE_HINT
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
    family_edges_collection,
    family_people_collection,
    init_db,
    memories_collection,
    memory_to_response,
    now_iso,
    playback_collection,
    users_collection,
    get_db,
)
from .rag import (
    find_related_memories,
    get_graph_edges,
    index_transcript,
    join_context,
    retrieve,
    search_stories,
)
from .services import (
    generate_story_variants,
    generate_cover_svg,
    infer_mood_tag,
    infer_themes,
    synthesize_story_audio_with_elevenlabs,
    transcribe_with_elevenlabs,
)

app = FastAPI(title="Virsa AI", version="0.2.0")

_cors_origins = {
    (APP_ORIGIN or "").rstrip("/"),
    "http://localhost:3000",
    "http://localhost:5173",
    "http://localhost:5174",
    "http://127.0.0.1:3000",
    "http://127.0.0.1:5173",
    "http://127.0.0.1:5174",
}

app.add_middleware(
    CORSMiddleware,
    allow_origins=sorted(origin for origin in _cors_origins if origin),
    allow_origin_regex=r"https?://(localhost|127\.0\.0\.1)(:\d+)?$",
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
def on_startup() -> None:
    # Ensure app loggers emit at INFO to the console.
    app_logger = logging.getLogger("app")
    services_logger = logging.getLogger("app.services")
    httpx_logger = logging.getLogger("httpx")
    app_logger.setLevel(logging.INFO)
    services_logger.setLevel(logging.INFO)
    httpx_logger.setLevel(logging.WARNING)
    if not app_logger.handlers:
        handler = logging.StreamHandler()
        handler.setLevel(logging.INFO)
        handler.setFormatter(logging.Formatter("%(levelname)s:%(name)s:%(message)s"))
        app_logger.addHandler(handler)
    if not services_logger.handlers:
        for handler in app_logger.handlers:
            services_logger.addHandler(handler)
    init_db()


app.mount("/covers", StaticFiles(directory=COVER_DIR), name="covers")


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


class RegisterRequest(BaseModel):
    email: str = Field(min_length=3, max_length=320)
    password: str = Field(min_length=10, max_length=1024)
    name: str = Field(default="", max_length=120)
    elder_display_name: str = Field(default="", max_length=120)
    elder_birth_year: int | None = Field(default=None, ge=1800, le=2100)
    elder_age_range: str = Field(default="", max_length=60)
    elder_preferred_language: str = Field(default="", max_length=60)
    elder_home_region: str = Field(default="", max_length=120)
    elder_consent: bool = Field(default=False)


class LoginRequest(BaseModel):
    email: str = Field(min_length=3, max_length=320)
    password: str = Field(min_length=1, max_length=1024)


class RefreshRequest(BaseModel):
    refresh_token: str = Field(min_length=20, max_length=4096)


class LogoutRequest(BaseModel):
    refresh_token: str = Field(min_length=20, max_length=4096)


class CreateElderRootRequest(BaseModel):
    display_name: str = Field(min_length=1, max_length=120)
    birth_year: int | None = Field(default=None, ge=1800, le=2100)
    age_range: str = Field(default="", max_length=60)
    preferred_language: str = Field(default="", max_length=60)
    home_region: str = Field(default="", max_length=120)
    consent: bool = Field(default=False)


class CreatePersonWithEdgeRequest(BaseModel):
    display_name: str = Field(min_length=1, max_length=120)
    given_name: str = Field(default="", max_length=120)
    family_name: str = Field(default="", max_length=120)
    sex: Literal["female", "male", "other", "unknown"] = "unknown"
    birth_year: int | None = Field(default=None, ge=1800, le=2100)
    death_year: int | None = Field(default=None, ge=1800, le=2100)
    notes: str = Field(default="", max_length=2000)
    connect_to_person_id: str = Field(min_length=1, max_length=64)
    relationship: Literal["child", "parent", "partner", "sibling"]
    relationship_type: Literal["biological", "adoptive", "step", "guardian", "unknown"] = "unknown"
    partner_type: Literal["married", "partner", "divorced", "separated", "unknown"] = "unknown"
    certainty: Literal["certain", "estimated", "unknown"] = "unknown"
    start_year: int | None = Field(default=None, ge=1800, le=2100)
    end_year: int | None = Field(default=None, ge=1800, le=2100)


class UpdateFamilyPersonRequest(BaseModel):
    display_name: str | None = Field(default=None, min_length=1, max_length=120)
    given_name: str | None = Field(default=None, max_length=120)
    family_name: str | None = Field(default=None, max_length=120)
    sex: Literal["female", "male", "other", "unknown"] | None = None
    birth_year: int | None = Field(default=None, ge=1800, le=2100)
    death_year: int | None = Field(default=None, ge=1800, le=2100)
    notes: str | None = Field(default=None, max_length=2000)
    age_range: str | None = Field(default=None, max_length=60)
    preferred_language: str | None = Field(default=None, max_length=60)
    home_region: str | None = Field(default=None, max_length=120)
    consent: bool | None = None


class CreateFamilyEdgeRequest(BaseModel):
    kind: Literal["parent_child", "partner"]
    from_person_id: str = Field(min_length=1, max_length=64)
    to_person_id: str = Field(min_length=1, max_length=64)
    relationship_type: Literal["biological", "adoptive", "step", "guardian", "unknown"] = "unknown"
    partner_type: Literal["married", "partner", "divorced", "separated", "unknown"] = "unknown"
    certainty: Literal["certain", "estimated", "unknown"] = "unknown"
    start_year: int | None = Field(default=None, ge=1800, le=2100)
    end_year: int | None = Field(default=None, ge=1800, le=2100)


def _request_client_meta(request: Request) -> tuple[str | None, str | None]:
    user_agent = request.headers.get("user-agent")
    forwarded_for = request.headers.get("x-forwarded-for", "")
    remote_ip = forwarded_for.split(",")[0].strip() if forwarded_for else None
    if not remote_ip and request.client:
        remote_ip = request.client.host
    return user_agent, remote_ip


def _create_elder_root_family(
    owner_user_id: str,
    *,
    elder_display_name: str,
    elder_birth_year: int | None = None,
    elder_age_range: str = "",
    elder_preferred_language: str = "",
    elder_home_region: str = "",
    elder_consent: bool = False,
) -> tuple[str, str]:
    family_id = str(uuid4())
    elder_person_id = str(uuid4())
    now = now_iso()
    family_people_collection().insert_one(
        {
            "id": elder_person_id,
            "owner_user_id": owner_user_id,
            "family_id": family_id,
            "is_elder_root": True,
            "display_name": elder_display_name,
            "given_name": "",
            "family_name": "",
            "sex": "unknown",
            "birth_year": elder_birth_year,
            "death_year": None,
            "notes": "",
            "age_range": elder_age_range,
            "preferred_language": elder_preferred_language,
            "home_region": elder_home_region,
            "consent": elder_consent,
            "created_at": now,
            "updated_at": now,
        }
    )
    users_collection().update_one(
        {"id": owner_user_id},
        {
            "$set": {
                "default_family_id": family_id,
                "default_elder_person_id": elder_person_id,
                "updated_at": now_iso(),
            }
        },
    )
    return family_id, elder_person_id


def _family_elder_root_or_404(owner_user_id: str, family_id: str) -> dict:
    elder = family_people_collection().find_one(
        {
            "owner_user_id": owner_user_id,
            "family_id": family_id,
            "is_elder_root": True,
        },
        {"_id": 0},
    )
    if not elder:
        raise HTTPException(status_code=404, detail="Family not found")
    return elder


def _person_in_family_or_404(owner_user_id: str, family_id: str, person_id: str) -> dict:
    person = family_people_collection().find_one(
        {
            "owner_user_id": owner_user_id,
            "family_id": family_id,
            "id": person_id,
        },
        {"_id": 0},
    )
    if not person:
        raise HTTPException(status_code=404, detail="Person not found in family")
    return person


def _build_edge_doc(
    owner_user_id: str,
    family_id: str,
    *,
    kind: Literal["parent_child", "partner"],
    from_person_id: str,
    to_person_id: str,
    relationship_type: str = "unknown",
    partner_type: str = "unknown",
    certainty: str = "unknown",
    start_year: int | None = None,
    end_year: int | None = None,
) -> dict:
    now = now_iso()
    return {
        "id": str(uuid4()),
        "owner_user_id": owner_user_id,
        "family_id": family_id,
        "kind": kind,
        "from_person_id": from_person_id,
        "to_person_id": to_person_id,
        "relationship_type": relationship_type if kind == "parent_child" else "unknown",
        "partner_type": partner_type if kind == "partner" else "unknown",
        "certainty": certainty,
        "start_year": start_year,
        "end_year": end_year,
        "created_at": now,
        "updated_at": now,
    }


def _validate_edge_years(start_year: int | None, end_year: int | None) -> None:
    if start_year is not None and end_year is not None and start_year > end_year:
        raise HTTPException(status_code=400, detail="start_year must be less than or equal to end_year")


def _edge_exists(
    owner_user_id: str,
    family_id: str,
    *,
    kind: Literal["parent_child", "partner"],
    from_person_id: str,
    to_person_id: str,
) -> bool:
    if kind == "partner":
        query = {
            "owner_user_id": owner_user_id,
            "family_id": family_id,
            "kind": "partner",
            "$or": [
                {"from_person_id": from_person_id, "to_person_id": to_person_id},
                {"from_person_id": to_person_id, "to_person_id": from_person_id},
            ],
        }
    else:
        query = {
            "owner_user_id": owner_user_id,
            "family_id": family_id,
            "kind": "parent_child",
            "from_person_id": from_person_id,
            "to_person_id": to_person_id,
        }
    return family_edges_collection().find_one(query, {"_id": 1}) is not None


def _strip_mongo_id(doc: dict) -> dict:
    clean = dict(doc)
    clean.pop("_id", None)
    return clean


def _edge_in_family_or_404(owner_user_id: str, family_id: str, edge_id: str) -> dict:
    edge = family_edges_collection().find_one(
        {
            "owner_user_id": owner_user_id,
            "family_id": family_id,
            "id": edge_id,
        },
        {"_id": 0},
    )
    if not edge:
        raise HTTPException(status_code=404, detail="Edge not found in family")
    return edge


@app.post("/api/auth/register")
def auth_register(body: RegisterRequest, request: Request) -> dict:
    clean_elder_display_name = body.elder_display_name.strip()
    try:
        user = register_user(body.email, body.password, body.name)
        family_id = ""
        elder_person_id = ""
        # Backward compatibility: if older clients still pass elder details at signup,
        # create elder-root family here; otherwise create it later via dedicated endpoint.
        if clean_elder_display_name:
            if not body.elder_consent:
                raise HTTPException(status_code=400, detail="Elder consent is required")
            family_id, elder_person_id = _create_elder_root_family(
                str(user.get("id") or ""),
                elder_display_name=clean_elder_display_name,
                elder_birth_year=body.elder_birth_year,
                elder_age_range=body.elder_age_range.strip(),
                elder_preferred_language=body.elder_preferred_language.strip(),
                elder_home_region=body.elder_home_region.strip(),
                elder_consent=body.elder_consent,
            )
        user_agent, remote_ip = _request_client_meta(request)
        tokens = create_session(user, user_agent=user_agent, ip_address=remote_ip)
    except AuthError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc

    response = {
        "user": public_user(user),
        **tokens,
    }
    if family_id and elder_person_id:
        response["family_id"] = family_id
        response["elder_person_id"] = elder_person_id
    return response


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


@app.post("/api/families/elder-root")
def create_elder_root_family(body: CreateElderRootRequest, user: dict = Depends(get_current_user)) -> dict:
    if not body.consent:
        raise HTTPException(status_code=400, detail="Elder consent is required")

    owner_user_id = _user_id(user)
    existing = family_people_collection().find_one(
        {"owner_user_id": owner_user_id, "is_elder_root": True},
        {"_id": 0, "family_id": 1, "id": 1},
    )
    if existing:
        return {
            "family_id": str(existing.get("family_id") or ""),
            "elder_person_id": str(existing.get("id") or ""),
            "created": False,
        }

    family_id, elder_person_id = _create_elder_root_family(
        owner_user_id,
        elder_display_name=body.display_name.strip(),
        elder_birth_year=body.birth_year,
        elder_age_range=body.age_range.strip(),
        elder_preferred_language=body.preferred_language.strip(),
        elder_home_region=body.home_region.strip(),
        elder_consent=body.consent,
    )

    return {
        "family_id": family_id,
        "elder_person_id": elder_person_id,
        "created": True,
    }


@app.get("/api/families/{family_id}/tree")
def get_family_tree(family_id: str, user: dict = Depends(get_current_user)) -> dict:
    owner_user_id = _user_id(user)
    elder = _family_elder_root_or_404(owner_user_id, family_id)
    people = list(
        family_people_collection().find(
            {"owner_user_id": owner_user_id, "family_id": family_id},
            {"_id": 0},
        )
    )
    edges = list(
        family_edges_collection().find(
            {"owner_user_id": owner_user_id, "family_id": family_id},
            {"_id": 0},
        )
    )
    return {
        "family_id": family_id,
        "elder_person_id": str(elder.get("id") or ""),
        "people": people,
        "edges": edges,
    }


@app.post("/api/families/{family_id}/people_with_edge")
def create_person_with_edge(
    family_id: str,
    body: CreatePersonWithEdgeRequest,
    user: dict = Depends(get_current_user),
) -> dict:
    owner_user_id = _user_id(user)
    _family_elder_root_or_404(owner_user_id, family_id)
    connect_to = _person_in_family_or_404(owner_user_id, family_id, body.connect_to_person_id)

    now = now_iso()
    person_id = str(uuid4())
    person_doc = {
        "id": person_id,
        "owner_user_id": owner_user_id,
        "family_id": family_id,
        "is_elder_root": False,
        "display_name": body.display_name.strip(),
        "given_name": body.given_name.strip(),
        "family_name": body.family_name.strip(),
        "sex": body.sex,
        "birth_year": body.birth_year,
        "death_year": body.death_year,
        "notes": body.notes.strip(),
        "created_at": now,
        "updated_at": now,
    }
    family_people_collection().insert_one(person_doc)

    created_people: list[dict] = [person_doc]
    edge_docs: list[dict] = []

    relationship = body.relationship
    if relationship == "child":
        edge_docs.append(
            _build_edge_doc(
                owner_user_id,
                family_id,
                kind="parent_child",
                from_person_id=str(connect_to.get("id") or ""),
                to_person_id=person_id,
                relationship_type=body.relationship_type,
                certainty=body.certainty,
            )
        )
    elif relationship == "parent":
        edge_docs.append(
            _build_edge_doc(
                owner_user_id,
                family_id,
                kind="parent_child",
                from_person_id=person_id,
                to_person_id=str(connect_to.get("id") or ""),
                relationship_type=body.relationship_type,
                certainty=body.certainty,
            )
        )
    elif relationship == "partner":
        _validate_edge_years(body.start_year, body.end_year)
        edge_docs.append(
            _build_edge_doc(
                owner_user_id,
                family_id,
                kind="partner",
                from_person_id=str(connect_to.get("id") or ""),
                to_person_id=person_id,
                partner_type=body.partner_type,
                certainty=body.certainty,
                start_year=body.start_year,
                end_year=body.end_year,
            )
        )
    else:
        placeholder_id = str(uuid4())
        placeholder_doc = {
            "id": placeholder_id,
            "owner_user_id": owner_user_id,
            "family_id": family_id,
            "is_elder_root": False,
            "display_name": f"Unknown Parent of {str(connect_to.get('display_name') or 'Person')}",
            "given_name": "",
            "family_name": "",
            "sex": "unknown",
            "birth_year": None,
            "death_year": None,
            "notes": "Auto-created placeholder for sibling relationship.",
            "created_at": now,
            "updated_at": now,
        }
        family_people_collection().insert_one(placeholder_doc)
        created_people.append(placeholder_doc)
        edge_docs.append(
            _build_edge_doc(
                owner_user_id,
                family_id,
                kind="parent_child",
                from_person_id=placeholder_id,
                to_person_id=str(connect_to.get("id") or ""),
                relationship_type="unknown",
                certainty="unknown",
            )
        )
        edge_docs.append(
            _build_edge_doc(
                owner_user_id,
                family_id,
                kind="parent_child",
                from_person_id=placeholder_id,
                to_person_id=person_id,
                relationship_type=body.relationship_type,
                certainty=body.certainty,
            )
        )

    if edge_docs:
        family_edges_collection().insert_many(edge_docs)

    return {
        "family_id": family_id,
        "created_people": [_strip_mongo_id(doc) for doc in created_people],
        "created_edges": [_strip_mongo_id(doc) for doc in edge_docs],
    }


@app.patch("/api/families/{family_id}/people/{person_id}")
def update_family_person(
    family_id: str,
    person_id: str,
    body: UpdateFamilyPersonRequest,
    user: dict = Depends(get_current_user),
) -> dict:
    owner_user_id = _user_id(user)
    existing = _person_in_family_or_404(owner_user_id, family_id, person_id)

    updates: dict[str, object] = {}
    supplied = body.model_fields_set

    if "display_name" in supplied:
        clean_display_name = (body.display_name or "").strip()
        if not clean_display_name:
            raise HTTPException(status_code=400, detail="display_name cannot be empty")
        updates["display_name"] = clean_display_name
    if "given_name" in supplied:
        updates["given_name"] = (body.given_name or "").strip()
    if "family_name" in supplied:
        updates["family_name"] = (body.family_name or "").strip()
    if "sex" in supplied:
        updates["sex"] = body.sex or "unknown"
    if "birth_year" in supplied:
        updates["birth_year"] = body.birth_year
    if "death_year" in supplied:
        updates["death_year"] = body.death_year
    if "notes" in supplied:
        updates["notes"] = (body.notes or "").strip()
    if "age_range" in supplied:
        updates["age_range"] = (body.age_range or "").strip()
    if "preferred_language" in supplied:
        updates["preferred_language"] = (body.preferred_language or "").strip()
    if "home_region" in supplied:
        updates["home_region"] = (body.home_region or "").strip()
    if "consent" in supplied:
        updates["consent"] = bool(body.consent)

    if not updates:
        return {"person": existing}

    updates["updated_at"] = now_iso()
    family_people_collection().update_one(
        {"owner_user_id": owner_user_id, "family_id": family_id, "id": person_id},
        {"$set": updates},
    )
    updated = _person_in_family_or_404(owner_user_id, family_id, person_id)
    return {"person": updated}


@app.delete("/api/families/{family_id}/people/{person_id}")
def delete_family_person(
    family_id: str,
    person_id: str,
    user: dict = Depends(get_current_user),
) -> dict:
    owner_user_id = _user_id(user)
    person = _person_in_family_or_404(owner_user_id, family_id, person_id)
    if bool(person.get("is_elder_root")):
        raise HTTPException(status_code=400, detail="Cannot delete elder root person")

    person_result = family_people_collection().delete_one(
        {"owner_user_id": owner_user_id, "family_id": family_id, "id": person_id}
    )
    edges_result = family_edges_collection().delete_many(
        {
            "owner_user_id": owner_user_id,
            "family_id": family_id,
            "$or": [{"from_person_id": person_id}, {"to_person_id": person_id}],
        }
    )
    return {
        "deleted": person_result.deleted_count == 1,
        "edges_deleted": int(edges_result.deleted_count),
    }


@app.post("/api/families/{family_id}/edges")
def create_family_edge(
    family_id: str,
    body: CreateFamilyEdgeRequest,
    user: dict = Depends(get_current_user),
) -> dict:
    owner_user_id = _user_id(user)
    _family_elder_root_or_404(owner_user_id, family_id)
    _person_in_family_or_404(owner_user_id, family_id, body.from_person_id)
    _person_in_family_or_404(owner_user_id, family_id, body.to_person_id)

    if body.from_person_id == body.to_person_id:
        raise HTTPException(status_code=400, detail="Edge endpoints must be different people")
    _validate_edge_years(body.start_year, body.end_year)
    if _edge_exists(
        owner_user_id,
        family_id,
        kind=body.kind,
        from_person_id=body.from_person_id,
        to_person_id=body.to_person_id,
    ):
        raise HTTPException(status_code=409, detail="An equivalent relationship edge already exists")

    edge_doc = _build_edge_doc(
        owner_user_id,
        family_id,
        kind=body.kind,
        from_person_id=body.from_person_id,
        to_person_id=body.to_person_id,
        relationship_type=body.relationship_type,
        partner_type=body.partner_type,
        certainty=body.certainty,
        start_year=body.start_year,
        end_year=body.end_year,
    )
    family_edges_collection().insert_one(edge_doc)
    return {"edge": _strip_mongo_id(edge_doc)}


@app.delete("/api/families/{family_id}/edges/{edge_id}")
def delete_family_edge(
    family_id: str,
    edge_id: str,
    user: dict = Depends(get_current_user),
) -> dict:
    owner_user_id = _user_id(user)
    _edge_in_family_or_404(owner_user_id, family_id, edge_id)
    result = family_edges_collection().delete_one(
        {"owner_user_id": owner_user_id, "family_id": family_id, "id": edge_id}
    )
    return {"deleted": result.deleted_count == 1}


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


StoryVariant = Literal["children", "narration"]


def _story_variant_or_400(variant: str) -> StoryVariant:
    clean = variant.strip().lower()
    if clean not in {"children", "narration"}:
        raise HTTPException(status_code=400, detail="Variant must be 'children' or 'narration'")
    return clean


def _story_variant_text(row: dict, variant: StoryVariant) -> str:
    primary = str(row.get("story_children") if variant == "children" else row.get("story_narration") or "")
    clean_primary = " ".join(primary.split())
    if clean_primary:
        return clean_primary

    summary = " ".join(str(row.get("ai_summary") or "").split())
    if summary:
        if variant == "children":
            return f"Child-friendly retelling: {summary}"
        return f"Documentary narration: {summary}"

    transcript = " ".join(str(row.get("transcript") or "").split())
    if transcript:
        if variant == "children":
            return f"Child-friendly retelling: {transcript}"
        return f"Documentary narration: {transcript}"
    return ""


def _story_variant_audio_doc(row: dict, variant: StoryVariant) -> dict:
    story_audio = row.get("story_audio")
    if not isinstance(story_audio, dict):
        return {}
    item = story_audio.get(variant)
    return item if isinstance(item, dict) else {}


def _story_variant_file_path(memory_id: str, variant: StoryVariant) -> Path:
    return STORY_AUDIO_DIR / f"{memory_id}_{variant}.mp3"


def _ensure_story_variant_audio(row: dict, user_id: str, variant: StoryVariant) -> dict:
    memory_id = str(row.get("id") or "")
    if not memory_id:
        raise HTTPException(status_code=404, detail="Memory not found")

    existing = _story_variant_audio_doc(row, variant)
    existing_path = str(existing.get("file_path") or "")
    existing_file = Path(existing_path) if existing_path else _story_variant_file_path(memory_id, variant)
    if existing_path and existing_file.exists():
        return {
            "audio_path": f"/api/memories/{memory_id}/story-audio/{variant}",
            "transcript": str(existing.get("transcript") or ""),
            "transcript_timing": existing.get("transcript_timing") if isinstance(existing.get("transcript_timing"), list) else [],
            "status": str(existing.get("status") or "ready"),
            "voice_id": str(existing.get("voice_id") or ""),
        }

    text = " ".join(_story_variant_text(row, variant).split())
    if not text:
        raise HTTPException(status_code=400, detail=f"{variant.title()} version not generated yet.")

    source_audio = _materialize_audio(row)
    if not source_audio:
        raise HTTPException(status_code=404, detail="Source audio file not found")

    existing_story_audio = row.get("story_audio") if isinstance(row.get("story_audio"), dict) else {}
    voice_clone = existing_story_audio.get("voice_clone") if isinstance(existing_story_audio.get("voice_clone"), dict) else {}
    preferred_voice_id = str(voice_clone.get("voice_id") or "")
    speaker_tag = str(row.get("speaker_tag") or "")
    audio_bytes, mime_type, words, voice_id, synth_status = synthesize_story_audio_with_elevenlabs(
        text=text,
        memory_id=memory_id,
        speaker_tag=speaker_tag,
        source_audio_path=source_audio,
        preferred_voice_id=preferred_voice_id,
    )
    if not audio_bytes:
        raise HTTPException(status_code=502, detail=f"Story audio generation failed: {synth_status}")

    out_file = _story_variant_file_path(memory_id, variant)
    out_file.write_bytes(audio_bytes)
    now = now_iso()
    voice_clone_status = "voice_reused" if preferred_voice_id and preferred_voice_id == voice_id else synth_status

    updates: dict[str, object] = {
        f"story_audio.{variant}.file_path": str(out_file),
        f"story_audio.{variant}.mime_type": mime_type,
        f"story_audio.{variant}.transcript": text,
        f"story_audio.{variant}.transcript_timing": words,
        f"story_audio.{variant}.voice_id": voice_id,
        f"story_audio.{variant}.status": "ready",
        f"story_audio.{variant}.updated_at": now,
        "updated_at": now,
    }
    if voice_id:
        updates["story_audio.voice_clone.voice_id"] = voice_id
        updates["story_audio.voice_clone.status"] = voice_clone_status
        updates["story_audio.voice_clone.updated_at"] = now

    memories_collection().update_one(
        {"id": memory_id, "user_id": user_id},
        {"$set": updates},
    )
    return {
        "audio_path": f"/api/memories/{memory_id}/story-audio/{variant}",
        "transcript": text,
        "transcript_timing": words,
        "status": "ready",
        "voice_id": voice_id,
    }


def _user_id(user: dict) -> str:
    return str(user.get("id") or "")


def _owned_memory_or_404(memory_id: str, user_id: str, projection: dict | None = None) -> dict:
    row = memories_collection().find_one({"id": memory_id, "user_id": user_id}, projection or {"_id": 0})
    if not row:
        raise HTTPException(status_code=404, detail="Memory not found")
    return row


@app.post("/api/memories")
async def create_memory(
    audio: UploadFile = File(...),
    title: str = Form(default="Untitled Memory"),
    speaker_tag: str = Form(default=""),
    speaker_person_id: str = Form(default=""),
    user: dict = Depends(get_current_user),
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
    clean_user_id = _user_id(user)
    clean_family_id = str(user.get("default_family_id") or "").strip()
    clean_speaker_person_id = speaker_person_id.strip()
    clean_speaker_tag = speaker_tag.strip()

    if clean_speaker_person_id:
        if clean_family_id:
            speaker_person = _person_in_family_or_404(clean_user_id, clean_family_id, clean_speaker_person_id)
        else:
            speaker_person = family_people_collection().find_one(
                {"owner_user_id": clean_user_id, "id": clean_speaker_person_id},
                {"_id": 0},
            )
            if not speaker_person:
                raise HTTPException(status_code=404, detail="Speaker not found in family")
            clean_family_id = str(speaker_person.get("family_id") or "").strip()
        clean_speaker_tag = str(speaker_person.get("display_name") or "").strip()
        if not clean_speaker_tag:
            raise HTTPException(status_code=400, detail="Selected family member has no display name")
    elif not clean_speaker_tag:
        raise HTTPException(status_code=400, detail="Select a family member as the speaker")

    memories_collection().insert_one(
        {
            "id": memory_id,
            "title": clean_title,
            "speaker_tag": clean_speaker_tag,
            "speaker_person_id": clean_speaker_person_id,
            "family_id": clean_family_id,
            "audio": {
                "filename": audio.filename,
                "mime_type": audio.content_type or "audio/webm",
                "local_path": str(audio_path),
                "gridfs_id": gridfs_id,
            },
            "transcript": "",
            "transcript_timing": [],
            "story_children": "",
            "story_narration": "",
            "story_audio": {
                "children": {},
                "narration": {},
                "voice_clone": {},
            },
            "cover_path": "",
            "mood_tag": "unknown",
            "themes": [],
            "ai_summary": "",
            "ai_summary_status": "pending",
            "embedding_status": {
                "indexed": False,
                "chunk_count": 0,
                "model": "",
                "indexed_at": "",
            },
            "user_id": clean_user_id,
            "created_at": now,
            "updated_at": now,
        }
    )

    return {
        "id": memory_id,
        "title": clean_title,
        "speaker_tag": clean_speaker_tag,
        "speaker_person_id": clean_speaker_person_id,
        "family_id": clean_family_id,
        "audio_path": f"/api/memories/{memory_id}/audio",
        "audio_url": f"/api/memories/{memory_id}/audio",
    }


@app.get("/api/memories")
def list_memories(user: dict = Depends(get_current_user)) -> dict:
    rows = list(memories_collection().find({"user_id": _user_id(user)}, {"_id": 0}).sort("created_at", -1))
    return {"items": [memory_to_response(row) for row in rows]}


@app.get("/api/memories/graph")
def get_memory_graph(
    theme: str | None = None,
    limit: int = 100,
    user: dict = Depends(get_current_user),
) -> dict:
    """Return nodes (memories) and edges (similarity pairs) for the Memory Map graph."""
    user_id = _user_id(user)
    query: dict = {"user_id": user_id}
    if theme and theme.strip():
        query["themes"] = theme.strip()
    rows = list(
        memories_collection()
        .find(query, {"_id": 0})
        .sort("created_at", -1)
        .limit(limit)
    )
    nodes = [memory_to_response(r) for r in rows]
    memory_ids = [r["id"] for r in rows if r.get("id")]
    edges_tuples = get_graph_edges(user_id, memory_ids, top_k_per_node=5)
    edges = [
        {"source": a, "target": b, "score": round(s, 4)}
        for a, b, s in edges_tuples
    ]
    return {"nodes": nodes, "edges": edges}


@app.get("/api/memories/{memory_id}/related")
def get_related_memories(
    memory_id: str,
    top_k: int = 10,
    user: dict = Depends(get_current_user),
) -> dict:
    """Return memories similar to the given one, with scores."""
    user_id = _user_id(user)
    _owned_memory_or_404(memory_id, user_id)
    related = find_related_memories(user_id, memory_id, top_k=top_k)
    if not related:
        return {"items": []}
    ids = [mid for mid, _ in related]
    scores_by_id = {mid: sc for mid, sc in related}
    rows = list(
        memories_collection().find(
            {"id": {"$in": ids}, "user_id": user_id},
            {"_id": 0},
        )
    )
    by_id = {r["id"]: r for r in rows}
    items = [
        {"memory": memory_to_response(by_id[mid]), "score": round(scores_by_id[mid], 4)}
        for mid in ids
        if mid in by_id
    ]
    return {"items": items}


@app.get("/api/speakers")
def list_speakers(user: dict = Depends(get_current_user)) -> dict:
    """Return family members as selectable speakers for recording."""
    user_id = _user_id(user)
    family_id = str(user.get("default_family_id") or "").strip()
    if not family_id:
        elder = family_people_collection().find_one(
            {"owner_user_id": user_id, "is_elder_root": True},
            {"_id": 0, "family_id": 1},
        )
        family_id = str((elder or {}).get("family_id") or "").strip()
    if not family_id:
        return {"family_id": "", "speakers": []}

    rows = list(
        family_people_collection()
        .find(
            {"owner_user_id": user_id, "family_id": family_id},
            {"_id": 0, "id": 1, "display_name": 1, "is_elder_root": 1},
        )
        .sort([("is_elder_root", -1), ("display_name", 1)])
    )
    speakers = [
        {
            "person_id": str(row.get("id") or ""),
            "display_name": str(row.get("display_name") or ""),
            "is_elder_root": bool(row.get("is_elder_root")),
        }
        for row in rows
        if str(row.get("id") or "").strip() and str(row.get("display_name") or "").strip()
    ]
    return {"family_id": family_id, "speakers": speakers}


async def _search_request_body(request: Request) -> tuple[str, UploadFile | None]:
    """Parse search request: either JSON { query } or multipart with query and/or audio."""
    content_type = (request.headers.get("content-type") or "").lower()
    search_query = ""
    audio_file: UploadFile | None = None

    if "application/json" in content_type:
        try:
            body = await request.json()
            search_query = (body.get("query") or "").strip()
        except Exception:
            pass
        return search_query, None

    if "multipart/form-data" in content_type:
        form = await request.form()
        search_query = (form.get("query") or "").strip()
        maybe_audio = form.get("audio")
        if isinstance(maybe_audio, UploadFile) or (
            hasattr(maybe_audio, "filename") and hasattr(maybe_audio, "file")
        ):
            audio_file = maybe_audio
        return search_query, audio_file

    return "", None


@app.post("/api/search")
async def search_memories(
    request: Request,
    user: dict = Depends(get_current_user),
) -> dict:
    search_query, audio_file = await _search_request_body(request)

    if audio_file and audio_file.filename:
        suffix = Path(audio_file.filename or "audio").suffix or ".webm"
        with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
            shutil.copyfileobj(audio_file.file, tmp)
            tmp_path = Path(tmp.name)
        try:
            language_hint = None if VOICE_SEARCH_LANGUAGE_HINT == "auto" else VOICE_SEARCH_LANGUAGE_HINT
            transcript, _, ok, message = await transcribe_with_elevenlabs(tmp_path, language_code=language_hint)
            if ok and (transcript or "").strip():
                search_query = transcript.strip()
            elif not search_query:
                raise HTTPException(status_code=502, detail=message or "Audio transcription failed.")
        finally:
            tmp_path.unlink(missing_ok=True)

    if not search_query:
        raise HTTPException(
            status_code=400,
            detail="Provide a text query or an audio recording to search.",
        )

    user_id = _user_id(user)
    hits = search_stories(user_id, search_query, top_k=15)
    memory_ids = [mid for mid, _, _ in hits]
    scores_by_id = {mid: score for mid, score, _ in hits}

    if not memory_ids:
        logger.info("search_memories: user_id=%s query=%r no hits", user_id, search_query[:80])
        return {"query": search_query, "items": []}

    rows = list(
        memories_collection().find(
            {"id": {"$in": memory_ids}, "user_id": user_id},
            {"_id": 0},
        )
    )
    by_id = {r["id"]: r for r in rows}
    # Return items in best-match order (same order as hits, already sorted by score)
    ordered = [memory_to_response(by_id[mid]) for mid in memory_ids if mid in by_id]

    logger.info(
        "search_memories: user_id=%s query=%r returning %d stories (best-match order)",
        user_id,
        search_query[:80] + ("..." if len(search_query) > 80 else ""),
        len(ordered),
    )
    for rank, mem_id in enumerate(memory_ids, start=1):
        if mem_id in by_id:
            title = by_id[mem_id].get("title") or "(no title)"
            score = scores_by_id.get(mem_id, 0)
            logger.info("  [%d] id=%s title=%r score=%.4f", rank, mem_id, title, score)

    return {"query": search_query, "items": ordered}


@app.get("/api/memories/{memory_id}")
def get_memory(memory_id: str, user: dict = Depends(get_current_user)) -> dict:
    row = _owned_memory_or_404(memory_id, _user_id(user))
    return memory_to_response(row)


@app.get("/api/memories/{memory_id}/audio")
def get_memory_audio(memory_id: str, user: dict = Depends(get_current_user)):
    row = _owned_memory_or_404(memory_id, _user_id(user))

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


@app.post("/api/memories/{memory_id}/story-audio/{variant}")
def ensure_story_audio_variant(
    memory_id: str,
    variant: str,
    user: dict = Depends(get_current_user),
) -> dict:
    clean_variant = _story_variant_or_400(variant)
    clean_user_id = _user_id(user)
    row = _owned_memory_or_404(memory_id, clean_user_id)
    payload = _ensure_story_variant_audio(row, clean_user_id, clean_variant)
    return {
        "id": memory_id,
        "variant": clean_variant,
        **payload,
    }


@app.get("/api/memories/{memory_id}/story-audio/{variant}")
def get_story_audio_variant(
    memory_id: str,
    variant: str,
    user: dict = Depends(get_current_user),
):
    clean_variant = _story_variant_or_400(variant)
    clean_user_id = _user_id(user)
    row = _owned_memory_or_404(memory_id, clean_user_id)
    _ensure_story_variant_audio(row, clean_user_id, clean_variant)

    latest = _owned_memory_or_404(memory_id, clean_user_id)
    audio_doc = _story_variant_audio_doc(latest, clean_variant)
    file_path = str(audio_doc.get("file_path") or "")
    if not file_path:
        raise HTTPException(status_code=404, detail="Story audio file not found")
    out_path = Path(file_path)
    if not out_path.exists():
        raise HTTPException(status_code=404, detail="Story audio file not found")

    media_type = str(audio_doc.get("mime_type") or "audio/mpeg")
    return FileResponse(out_path, media_type=media_type, filename=f"{memory_id}_{clean_variant}.mp3")


@app.post("/api/memories/{memory_id}/transcribe")
async def transcribe_memory(memory_id: str, user: dict = Depends(get_current_user)) -> dict:
    row = _owned_memory_or_404(memory_id, _user_id(user))

    audio_path = _materialize_audio(row)
    if not audio_path:
        raise HTTPException(status_code=404, detail="Audio file not found")

    transcript, transcript_timing, ok, message = await transcribe_with_elevenlabs(audio_path)
    if not ok:
        raise HTTPException(status_code=502, detail=message)

    chunk_count, embedding_model = index_transcript(memory_id, transcript, _user_id(user))
    mood_tag = infer_mood_tag(transcript)
    themes = infer_themes(transcript)

    memories_collection().update_one(
        {"id": memory_id, "user_id": _user_id(user)},
        {
            "$set": {
                "transcript": transcript,
                "transcript_timing": transcript_timing,
                "audio.local_path": str(audio_path),
                "mood_tag": mood_tag,
                "themes": themes,
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
        "themes": themes,
        "chunks_indexed": chunk_count,
        "embedding_model": embedding_model,
    }


@app.post("/api/memories/{memory_id}/story")
def build_story(
    memory_id: str,
    prompt: str = Form(default="Create a heartfelt family story."),
    user: dict = Depends(get_current_user),
) -> dict:
    clean_user_id = _user_id(user)
    row = _owned_memory_or_404(memory_id, clean_user_id)

    transcript = str(row.get("transcript") or "")
    if not transcript:
        raise HTTPException(status_code=400, detail="Transcribe this memory before generating a story")

    relevant_chunks = retrieve(memory_id, prompt, top_k=5)
    context = join_context(relevant_chunks)
    variants, generation_status = generate_story_variants(
        transcript=transcript,
        context=context,
        prompt=prompt,
        title=str(row.get("title") or ""),
        speaker_tag=str(row.get("speaker_tag") or ""),
    )

    memories_collection().update_one(
        {"id": memory_id, "user_id": clean_user_id},
        {
            "$set": {
                "ai_summary": variants["ai_summary"],
                "story_children": variants["story_children"],
                "story_narration": variants["story_narration"],
                "ai_summary_status": generation_status,
                "story_audio.children": {},
                "story_audio.narration": {},
                "updated_at": now_iso(),
            }
        },
    )

    refreshed = _owned_memory_or_404(memory_id, clean_user_id)
    audio_status: dict[str, str] = {}
    for variant in ("children", "narration"):
        try:
            _ensure_story_variant_audio(refreshed, clean_user_id, variant)
            audio_status[variant] = "ready"
            refreshed = _owned_memory_or_404(memory_id, clean_user_id)
        except HTTPException as exc:
            audio_status[variant] = f"error:{exc.detail}"
        except Exception:
            logger.exception("story_audio_generation_failed memory_id=%s variant=%s", memory_id, variant)
            audio_status[variant] = "error:unexpected_failure"

    return {
        "id": memory_id,
        "prompt": prompt,
        "context": relevant_chunks,
        "ai_summary": variants["ai_summary"],
        "story_children": variants["story_children"],
        "story_narration": variants["story_narration"],
        "ai_summary_status": generation_status,
        "story_audio_status": audio_status,
    }


@app.post("/api/memories/{memory_id}/cover")
def build_cover(
    memory_id: str,
    prompt: str = Form(default="Warm family storybook illustration"),
    user: dict = Depends(get_current_user),
) -> dict:
    logger.info("api_cover_request memory_id=%s user_id=%s", memory_id, _user_id(user))
    row = _owned_memory_or_404(
        memory_id,
        _user_id(user),
        {"_id": 0, "title": 1, "ai_summary": 1, "story_children": 1, "story_narration": 1},
    )

    cover_path, generation_status = generate_cover_svg(
        memory_id,
        str(row.get("title") or "Untitled"),
        prompt,
        str(row.get("ai_summary") or ""),
        str(row.get("story_children") or ""),
        str(row.get("story_narration") or ""),
    )
    memories_collection().update_one(
        {"id": memory_id, "user_id": _user_id(user)},
        {"$set": {"cover_path": cover_path, "cover_status": generation_status, "updated_at": now_iso()}},
    )
    logger.info("api_cover_result memory_id=%s status=%s", memory_id, generation_status)

    return {"id": memory_id, "cover_url": f"/covers/{memory_id}.svg", "cover_status": generation_status}


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
    user: dict = Depends(get_current_user),
) -> dict:
    user_id = _user_id(user)
    _owned_memory_or_404(memory_id, user_id, {"_id": 0, "id": 1})

    safe_position = max(0.0, float(position_seconds))
    key = _viewer_key(user_id, None)
    now = now_iso()

    playback_collection().update_one(
        {"memory_id": memory_id, "viewer_key": key},
        {
            "$set": {
                "memory_id": memory_id,
                "viewer_key": key,
                "user_id": user_id,
                "device_id": None,
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
        "user_id": user_id,
        "device_id": None,
        "updated_at": now,
    }


@app.get("/api/memories/{memory_id}/playback")
def get_playback_position(
    memory_id: str,
    user: dict = Depends(get_current_user),
) -> dict:
    user_id = _user_id(user)
    _owned_memory_or_404(memory_id, user_id, {"_id": 0, "id": 1})

    key = _viewer_key(user_id, None)
    row = playback_collection().find_one({"memory_id": memory_id, "viewer_key": key}, {"_id": 0})
    if not row:
        return {
            "memory_id": memory_id,
            "position_seconds": 0.0,
            "user_id": user_id,
            "device_id": None,
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


@app.post("/api/admin/backfill-chunk-user-ids")
def backfill_chunk_user_ids(user: dict = Depends(get_current_user)) -> dict:
    """One-time backfill: set user_id on chunks that lack it, using memories.user_id."""
    mems = {m["id"]: m.get("user_id") for m in memories_collection().find({}, {"id": 1, "user_id": 1}) if m.get("id")}
    col = chunks_collection()
    memory_ids = col.distinct("memory_id", {"user_id": {"$exists": False}})
    updated = 0
    for mid in memory_ids:
        uid = mems.get(mid)
        if uid:
            result = col.update_many({"memory_id": mid, "user_id": {"$exists": False}}, {"$set": {"user_id": uid}})
            updated += result.modified_count
    return {"updated": updated}


@app.get("/api/admin/chunks/{memory_id}")
def inspect_chunks(memory_id: str, user: dict = Depends(get_current_user)) -> dict:
    _owned_memory_or_404(memory_id, _user_id(user), {"_id": 0, "id": 1})
    rows = list(chunks_collection().find({"memory_id": memory_id}, {"_id": 0}).sort("idx", 1))
    return {"items": rows}
