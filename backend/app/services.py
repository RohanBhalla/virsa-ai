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
    SENTIMENT_API_KEY,
    SENTIMENT_API_URL,
    VERTEX_ACCESS_TOKEN,
    VERTEX_API_KEY,
    VERTEX_GENERATIVE_BASE_URL,
    VERTEX_LOCATION,
    VERTEX_PROJECT_ID,
    VERTEX_STORY_MODEL,
)

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
    safe_prompt = textwrap.shorten(prompt or "Family memory", width=84, placeholder="...").replace("&", "and")

    svg = f"""<svg xmlns='http://www.w3.org/2000/svg' width='900' height='1200' viewBox='0 0 900 1200'>
  <defs>
    <linearGradient id='bg' x1='0' y1='0' x2='1' y2='1'>
      <stop offset='0%' stop-color='{c1}'/>
      <stop offset='55%' stop-color='{c2}'/>
      <stop offset='100%' stop-color='{c3}'/>
    </linearGradient>
  </defs>
  <rect width='900' height='1200' fill='url(#bg)'/>
  <rect x='70' y='90' width='760' height='1020' rx='38' fill='rgba(255,255,255,0.12)' stroke='rgba(255,255,255,0.35)'/>
  <text x='110' y='220' fill='white' font-size='64' font-family='Georgia, serif' font-weight='700'>{safe_title}</text>
  <text x='110' y='300' fill='white' font-size='28' font-family='Arial, sans-serif' opacity='0.92'>Storybook Memory</text>
  <text x='110' y='390' fill='white' font-size='24' font-family='Arial, sans-serif' opacity='0.88'>{safe_prompt}</text>
  <circle cx='740' cy='980' r='120' fill='rgba(255,255,255,0.18)'/>
  <circle cx='210' cy='910' r='90' fill='rgba(255,255,255,0.12)'/>
</svg>"""

    cover_path = COVER_DIR / f"{memory_id}.svg"
    cover_path.write_text(svg, encoding="utf-8")
    return str(cover_path)


def _heuristic_mood_tag(text: str) -> str:
    t = text.lower()
    positive = ("love", "happy", "joy", "grateful", "celebrate", "laugh")
    negative = ("sad", "loss", "cry", "hurt", "angry", "afraid")
    p = sum(1 for w in positive if w in t)
    n = sum(1 for w in negative if w in t)
    if p > n:
        return "positive"
    if n > p:
        return "somber"
    return "reflective"


def infer_mood_tag(transcript: str) -> str:
    text = (transcript or "").strip()
    if not text:
        return "neutral"

    if not SENTIMENT_API_URL:
        return _heuristic_mood_tag(text)

    headers = {"Content-Type": "application/json"}
    if SENTIMENT_API_KEY:
        headers["Authorization"] = f"Bearer {SENTIMENT_API_KEY}"

    payload = {"text": text}

    try:
        with httpx.Client(timeout=20) as client:
            res = client.post(SENTIMENT_API_URL, json=payload, headers=headers)
        if res.status_code >= 400:
            return _heuristic_mood_tag(text)
        body = res.json()
        mood = body.get("mood") or body.get("label") or body.get("sentiment")
        if isinstance(mood, str) and mood.strip():
            return mood.strip().lower()
    except Exception:
        return _heuristic_mood_tag(text)

    return _heuristic_mood_tag(text)
