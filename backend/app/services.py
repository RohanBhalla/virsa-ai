from __future__ import annotations

import hashlib
import json
import logging
import textwrap
from pathlib import Path

import httpx

from .config import (
    COVER_DIR,
    ELEVENLABS_API_KEY,
    ELEVENLABS_MODEL_ID,
    ELEVENLABS_STT_URL,
    VERTEX_ACCESS_TOKEN,
    VERTEX_API_KEY,
    VERTEX_GENERATIVE_BASE_URL,
    VERTEX_LOCATION,
    VERTEX_PROJECT_ID,
    VERTEX_STORY_MODEL,
)
from .tag_options import MOOD_DEFAULT, MOOD_OPTIONS, THEMES_OPTIONS

logger = logging.getLogger(__name__)


def _as_float(value: object) -> float | None:
    if isinstance(value, int | float):
        return float(value)
    if isinstance(value, str):
        try:
            return float(value)
        except ValueError:
            return None
    return None


def _extract_word_timing(payload: dict) -> list[dict[str, float | str]]:
    raw_words = payload.get("words")
    if not isinstance(raw_words, list):
        return []

    words: list[dict[str, float | str]] = []
    for item in raw_words:
        if not isinstance(item, dict):
            continue

        text = str(item.get("text") or item.get("word") or "").strip()
        start = _as_float(item.get("start"))
        end = _as_float(item.get("end"))

        if not text or start is None or end is None:
            continue

        words.append({"text": text, "start": max(0.0, start), "end": max(start, end)})

    words.sort(key=lambda w: float(w["start"]))
    return words


async def transcribe_with_elevenlabs(
    audio_path: Path,
    *,
    language_code: str | None = None,
) -> tuple[str, list[dict[str, float | str]], bool, str]:
    if not ELEVENLABS_API_KEY:
        return (
            "",
            [],
            False,
            "ELEVENLABS_API_KEY is missing. Add it to enable real transcription.",
        )

    headers = {"xi-api-key": ELEVENLABS_API_KEY}

    async with httpx.AsyncClient(timeout=90) as client:
        with audio_path.open("rb") as audio_file:
            files = {"file": (audio_path.name, audio_file, "audio/webm")}
            data = {"model_id": ELEVENLABS_MODEL_ID, "timestamps_granularity": "word"}
            clean_language = (language_code or "").strip().lower()
            if clean_language and clean_language != "auto":
                data["language_code"] = clean_language
            response = await client.post(ELEVENLABS_STT_URL, headers=headers, files=files, data=data)

    if response.status_code >= 400:
        return (
            "",
            [],
            False,
            f"ElevenLabs STT failed ({response.status_code}): {response.text[:240]}",
        )

    payload = response.json()
    transcript = payload.get("text") or payload.get("transcript") or ""
    if not transcript.strip():
        return "", [], False, "ElevenLabs returned an empty transcript."

    words = _extract_word_timing(payload)

    return transcript.strip(), words, True, "ok"


def _clean_generated_text(value: object, max_chars: int = 6000) -> str:
    if not isinstance(value, str):
        return ""
    return " ".join(value.strip().split())[:max_chars]


def _fallback_story_variants(
    transcript: str,
    context: str,
    title: str,
    speaker_tag: str,
) -> dict[str, str]:
    subject = (speaker_tag or title or "this person").strip() or "this person"
    summary_seed = textwrap.shorten(transcript, width=220, placeholder="...")
    context_seed = textwrap.shorten(context or transcript, width=360, placeholder="...")

    return {
        "ai_summary": (
            f"Meet {subject}: {summary_seed} "
            "This heartfelt memory follows their journey, choices, and the meaning they carry forward."
        )[:480],
        "story_children": (
            f"{subject} has an important story to share. {summary_seed} "
            "In this version, we tell the memory with gentle words, clear moments, and a warm ending for young listeners."
        )[:1400],
        "story_narration": (
            "Documentary narration: "
            f"In this recorded account, {subject} reflects on a defining family moment. "
            f"{summary_seed} "
            f"Supporting context: {context_seed}"
        )[:2200],
    }


def _normalize_story_variants(
    payload: dict[str, object],
    transcript: str,
    context: str,
    title: str,
    speaker_tag: str,
) -> dict[str, str]:
    fallback = _fallback_story_variants(transcript, context, title, speaker_tag)
    out = dict(fallback)

    key_aliases: dict[str, tuple[str, ...]] = {
        "ai_summary": ("ai_summary", "book_blurb", "back_cover_blurb"),
        "story_children": ("story_children", "children_version", "kids_version"),
        "story_narration": ("story_narration", "narration", "documentary_narration"),
    }

    for target_key, aliases in key_aliases.items():
        for source_key in aliases:
            cleaned = _clean_generated_text(payload.get(source_key))
            if cleaned:
                out[target_key] = cleaned
                break
    return out


def _vertex_story_variants(
    transcript: str,
    context: str,
    prompt: str,
    title: str,
    speaker_tag: str,
) -> dict[str, str] | None:
    if not VERTEX_PROJECT_ID:
        return None
    if not VERTEX_API_KEY and not VERTEX_ACCESS_TOKEN:
        return None

    endpoint = VERTEX_GENERATIVE_BASE_URL.rstrip("/") if VERTEX_GENERATIVE_BASE_URL else f"https://{VERTEX_LOCATION}-aiplatform.googleapis.com"
    model = VERTEX_STORY_MODEL
    if model.startswith("publishers/google/models/"):
        model_path = model
    else:
        model_path = f"publishers/google/models/{model}"
    url = f"{endpoint}/v1/projects/{VERTEX_PROJECT_ID}/locations/{VERTEX_LOCATION}/{model_path}:generateContent"

    headers = {"Content-Type": "application/json"}
    params: dict[str, str] = {}
    if VERTEX_API_KEY:
        params["key"] = VERTEX_API_KEY
        headers["x-goog-api-key"] = VERTEX_API_KEY
    if VERTEX_ACCESS_TOKEN:
        headers["Authorization"] = f"Bearer {VERTEX_ACCESS_TOKEN}"

    transcript_seed = textwrap.shorten(transcript, width=3600, placeholder="...")
    context_seed = textwrap.shorten(context or transcript, width=2200, placeholder="...")
    request_prompt = textwrap.shorten(prompt, width=500, placeholder="...")

    system_prompt = (
        "You are a memory-storytelling agent. Return strict JSON with keys: "
        "ai_summary, story_children, story_narration. "
        "Requirements: ai_summary is a book-jacket style blurb focused on the main character and their action. "
        "story_children is not a summary; it is a child-friendly retelling with simple language. "
        "story_narration is documentary-style narration."
    )
    user_prompt = (
        f"Title: {title or 'Untitled Memory'}\n"
        f"Speaker: {speaker_tag or 'Unknown'}\n"
        f"Story request: {request_prompt}\n\n"
        f"Transcript:\n{transcript_seed}\n\n"
        f"Retrieved context:\n{context_seed}"
    )
    payload = {
        "system_instruction": {"parts": [{"text": system_prompt}]},
        "contents": [{"role": "user", "parts": [{"text": user_prompt}]}],
        "generationConfig": {
            "temperature": 0.8,
            "responseMimeType": "application/json",
        },
    }

    with httpx.Client(timeout=60) as client:
        response = client.post(url, params=params or None, headers=headers, json=payload)
    response.raise_for_status()

    body = response.json()
    candidates = body.get("candidates")
    if not isinstance(candidates, list) or not candidates:
        return None

    first = candidates[0]
    content = first.get("content") if isinstance(first, dict) else None
    parts = content.get("parts") if isinstance(content, dict) else None
    if not isinstance(parts, list) or not parts:
        return None
    text = parts[0].get("text") if isinstance(parts[0], dict) else None
    if not isinstance(text, str):
        return None

    parsed = json.loads(text)
    if not isinstance(parsed, dict):
        return None
    return _normalize_story_variants(parsed, transcript, context, title, speaker_tag)


def generate_story_variants(
    transcript: str,
    context: str,
    prompt: str,
    title: str,
    speaker_tag: str,
) -> tuple[dict[str, str], str]:
    try:
        generated = _vertex_story_variants(transcript, context, prompt, title, speaker_tag)
        if generated:
            return generated, "generated_vertex"
    except Exception:
        logger.exception("vertex story generation failed; falling back")

    return _fallback_story_variants(transcript, context, title, speaker_tag), "generated_fallback"


def generate_cover_svg(memory_id: str, title: str, prompt: str) -> str:
    digest = hashlib.sha256((memory_id + prompt + title).encode("utf-8")).hexdigest()
    c1 = f"#{digest[0:6]}"
    c2 = f"#{digest[6:12]}"
    c3 = f"#{digest[12:18]}"

    safe_title = (title or "Untitled Story").replace("&", "and")[:48]

    # Center title: one line, large bold sans-serif, reference book-cover style
    # Font: modern bold sans-serif; size scales down slightly for longer titles
    title_len = len(safe_title)
    font_size = min(96, max(48, 100 - title_len * 2))
    center_x = 450
    center_y = 600

    svg = f"""<svg xmlns='http://www.w3.org/2000/svg' width='900' height='1200' viewBox='0 0 900 1200'>
  <defs>
    <linearGradient id='bg' x1='0' y1='0' x2='1' y2='1'>
      <stop offset='0%' stop-color='{c1}'/>
      <stop offset='55%' stop-color='{c2}'/>
      <stop offset='100%' stop-color='{c3}'/>
    </linearGradient>
  </defs>
  <rect width='900' height='1200' fill='url(#bg)'/>
  <text x='{center_x}' y='{center_y}' text-anchor='middle' dominant-baseline='middle' fill='white' font-size='{font_size}' font-family='Inter, "Segoe UI", "Helvetica Neue", Arial, sans-serif' font-weight='700'>{safe_title}</text>
</svg>"""

    cover_path = COVER_DIR / f"{memory_id}.svg"
    cover_path.write_text(svg, encoding="utf-8")
    return str(cover_path)


def _vertex_generate_json(
    system_prompt: str,
    user_prompt: str,
    *,
    temperature: float = 0.2,
) -> dict | None:
    """Call Vertex Gemini generateContent; return parsed JSON dict or None."""
    if not VERTEX_PROJECT_ID or (not VERTEX_API_KEY and not VERTEX_ACCESS_TOKEN):
        return None

    endpoint = (
        VERTEX_GENERATIVE_BASE_URL.rstrip("/")
        if VERTEX_GENERATIVE_BASE_URL
        else f"https://{VERTEX_LOCATION}-aiplatform.googleapis.com"
    )
    model = VERTEX_STORY_MODEL
    model_path = (
        model
        if model.startswith("publishers/google/models/")
        else f"publishers/google/models/{model}"
    )
    url = f"{endpoint}/v1/projects/{VERTEX_PROJECT_ID}/locations/{VERTEX_LOCATION}/{model_path}:generateContent"

    headers = {"Content-Type": "application/json"}
    if VERTEX_API_KEY:
        headers["x-goog-api-key"] = VERTEX_API_KEY
    if VERTEX_ACCESS_TOKEN:
        headers["Authorization"] = f"Bearer {VERTEX_ACCESS_TOKEN}"

    payload = {
        "system_instruction": {"parts": [{"text": system_prompt}]},
        "contents": [{"role": "user", "parts": [{"text": user_prompt}]}],
        "generationConfig": {
            "temperature": temperature,
            "responseMimeType": "application/json",
        },
    }

    try:
        with httpx.Client(timeout=30) as client:
            response = client.post(url, params=None, headers=headers, json=payload)
        response.raise_for_status()
    except Exception:
        logger.exception("Vertex generateContent failed")
        return None

    body = response.json()
    candidates = body.get("candidates")
    if not isinstance(candidates, list) or not candidates:
        return None
    first = candidates[0]
    content = first.get("content") if isinstance(first, dict) else None
    parts = content.get("parts") if isinstance(content, dict) else None
    if not isinstance(parts, list) or not parts:
        return None
    text = parts[0].get("text") if isinstance(parts[0], dict) else None
    if not isinstance(text, str):
        return None
    try:
        parsed = json.loads(text)
        return parsed if isinstance(parsed, dict) else None
    except json.JSONDecodeError:
        return None


def _vertex_mood_tag(transcript: str) -> str | None:
    """Use Vertex to classify mood; return one of MOOD_OPTIONS or None."""
    text = (transcript or "").strip()
    if not text:
        return None
    transcript_seed = textwrap.shorten(text, width=3600, placeholder="...")
    mood_list = ", ".join(MOOD_OPTIONS)
    system_prompt = (
        f"You are a sentiment classifier. Given a memory transcript, choose exactly one mood from this list: {mood_list}. "
        'Respond with valid JSON only: {"mood": "<one of the options>"}.'
    )
    user_prompt = f"Transcript:\n{transcript_seed}"
    result = _vertex_generate_json(system_prompt, user_prompt, temperature=0.2)
    if not result:
        return None
    mood = result.get("mood")
    if isinstance(mood, str):
        mood = mood.strip().lower()
        if mood in MOOD_OPTIONS:
            return mood
    return None


def infer_mood_tag(transcript: str) -> str:
    """Set mood_tag from defined list; LLM only, default when Vertex unavailable."""
    mood = _vertex_mood_tag(transcript)
    return mood if mood else MOOD_DEFAULT


def _vertex_themes(transcript: str) -> list[str]:
    """Use Vertex to extract themes; return list of THEMES_OPTIONS only."""
    text = (transcript or "").strip()
    if not text:
        return []
    transcript_seed = textwrap.shorten(text, width=3600, placeholder="...")
    themes_list = ", ".join(THEMES_OPTIONS)
    system_prompt = (
        f"From this memory transcript, select all themes that apply from this list: {themes_list}. "
        'Return valid JSON only: {"themes": ["theme1", "theme2", ...]}. Only themes from the list are valid.'
    )
    user_prompt = f"Transcript:\n{transcript_seed}"
    result = _vertex_generate_json(system_prompt, user_prompt, temperature=0.2)
    if not result:
        return []
    raw = result.get("themes")
    if not isinstance(raw, list):
        return []
    allowed = set(THEMES_OPTIONS)
    return [
        t.strip().lower()
        for t in raw
        if isinstance(t, str) and t.strip().lower() in allowed
    ]


def infer_themes(transcript: str) -> list[str]:
    """Set themes from defined list; Vertex with fallback to []."""
    try:
        return _vertex_themes(transcript)
    except Exception:
        logger.exception("infer_themes failed")
        return []
