from __future__ import annotations

import hashlib
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
)


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


async def transcribe_with_elevenlabs(audio_path: Path) -> tuple[str, list[dict[str, float | str]], bool, str]:
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


def fallback_story_from_transcript(transcript: str, context: str) -> tuple[str, str]:
    seed = transcript.strip() or "A precious family memory was recorded, and this story preserves it."
    preview = textwrap.shorten(seed, width=240, placeholder="...")

    short_story = (
        "A memory worth keeping: "
        + preview
    )

    long_story = (
        "Chapter 1: The Voice\n"
        f"{preview}\n\n"
        "Chapter 2: What This Means\n"
        "This memory reflects a family moment with emotional depth and living history. "
        "The narrative can be enriched over time as more memories are captured.\n\n"
        "Context Notes\n"
        f"{textwrap.shorten(context or seed, width=500, placeholder='...')}"
    )
    return short_story, long_story


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
