from __future__ import annotations

import base64
import hashlib
import html
import json
import logging
import re
import textwrap
from pathlib import Path

import httpx

from .config import (
    COVER_DIR,
    ELEVENLABS_API_KEY,
    ELEVENLABS_DEFAULT_VOICE_ID,
    ELEVENLABS_MODEL_ID,
    ELEVENLABS_STT_URL,
    ELEVENLABS_TTS_BASE_URL,
    ELEVENLABS_TTS_MODEL_ID,
    ELEVENLABS_TTS_OUTPUT_FORMAT,
    ELEVENLABS_VOICES_URL,
    VERTEX_ACCESS_TOKEN,
    VERTEX_API_KEY,
    VERTEX_COVER_MODEL,
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


def _extract_word_timing_from_alignment(payload: dict) -> list[dict[str, float | str]]:
    alignment = payload.get("alignment")
    if not isinstance(alignment, dict):
        alignment = payload.get("normalized_alignment")
    if not isinstance(alignment, dict):
        return []

    chars = alignment.get("characters")
    starts = alignment.get("character_start_times_seconds")
    ends = alignment.get("character_end_times_seconds")
    if not isinstance(chars, list) or not isinstance(starts, list) or not isinstance(ends, list):
        return []
    count = min(len(chars), len(starts), len(ends))
    if count <= 0:
        return []

    words: list[dict[str, float | str]] = []
    buffer = ""
    word_start: float | None = None
    word_end = 0.0

    def flush_word() -> None:
        nonlocal buffer, word_start, word_end
        clean = buffer.strip()
        if clean and word_start is not None:
            words.append({"text": clean, "start": max(0.0, word_start), "end": max(word_start, word_end)})
        buffer = ""
        word_start = None
        word_end = 0.0

    for i in range(count):
        ch = str(chars[i] or "")
        start = _as_float(starts[i])
        end = _as_float(ends[i])
        if start is None or end is None:
            continue

        if ch.isspace():
            flush_word()
            continue

        if word_start is None:
            word_start = start
        buffer += ch
        word_end = max(word_end, end)

    flush_word()
    return words


def _approximate_word_timing(text: str, total_seconds: float = 0.0) -> list[dict[str, float | str]]:
    words_raw = [w for w in re.split(r"\s+", text.strip()) if w]
    if not words_raw:
        return []
    # Fallback timing when provider timestamps are unavailable.
    duration = total_seconds if total_seconds > 0 else max(2.0, min(120.0, len(words_raw) * 0.42))
    step = duration / max(1, len(words_raw))
    out: list[dict[str, float | str]] = []
    cursor = 0.0
    for token in words_raw:
        start = cursor
        end = start + step
        out.append({"text": token, "start": start, "end": end})
        cursor = end
    return out


def _voice_clone_name(memory_id: str, speaker_tag: str) -> str:
    speaker = re.sub(r"[^a-zA-Z0-9_-]+", "-", (speaker_tag or "speaker").strip()).strip("-")
    short_id = (memory_id or "")[:8] or "memory"
    return f"virsa-{speaker or 'speaker'}-{short_id}"[:60]


def _clone_voice_from_sample(audio_path: Path, memory_id: str, speaker_tag: str) -> tuple[str | None, str]:
    if not ELEVENLABS_API_KEY:
        return None, "missing_elevenlabs_api_key"

    headers = {"xi-api-key": ELEVENLABS_API_KEY}
    data = {"name": _voice_clone_name(memory_id, speaker_tag)}
    try:
        with audio_path.open("rb") as sample:
            files = {"files": (audio_path.name, sample, "audio/webm")}
            with httpx.Client(timeout=90) as client:
                response = client.post(f"{ELEVENLABS_VOICES_URL.rstrip('/')}/add", headers=headers, data=data, files=files)
        if response.status_code >= 400:
            return None, f"voice_clone_failed_{response.status_code}"
        payload = response.json()
        voice_id = payload.get("voice_id")
        if isinstance(voice_id, str) and voice_id.strip():
            return voice_id.strip(), "voice_clone_created"
    except Exception:
        logger.exception("voice_clone_failed memory_id=%s", memory_id)
    return None, "voice_clone_failed"


def _pick_existing_voice_id() -> str:
    if not ELEVENLABS_API_KEY:
        return ""
    headers = {"xi-api-key": ELEVENLABS_API_KEY}
    try:
        with httpx.Client(timeout=30) as client:
            response = client.get(ELEVENLABS_VOICES_URL.rstrip("/"), headers=headers)
        if response.status_code >= 400:
            return ""
        payload = response.json()
        voices = payload.get("voices")
        if not isinstance(voices, list):
            return ""
        for voice in voices:
            if not isinstance(voice, dict):
                continue
            voice_id = voice.get("voice_id")
            if isinstance(voice_id, str) and voice_id.strip():
                return voice_id.strip()
    except Exception:
        logger.exception("list_voices_failed")
    return ""


def synthesize_story_audio_with_elevenlabs(
    *,
    text: str,
    memory_id: str,
    speaker_tag: str,
    source_audio_path: Path,
    preferred_voice_id: str = "",
) -> tuple[bytes, str, list[dict[str, float | str]], str, str]:
    clean_text = " ".join((text or "").split())
    if len(clean_text) > 4500:
        clean_text = textwrap.shorten(clean_text, width=4500, placeholder="...")
    if not clean_text:
        return b"", "audio/mpeg", [], "", "missing_text"
    if not ELEVENLABS_API_KEY:
        return b"", "audio/mpeg", [], "", "missing_elevenlabs_api_key"

    selected_voice = preferred_voice_id.strip()
    status = "voice_reused"
    if not selected_voice:
        selected_voice, status = _clone_voice_from_sample(source_audio_path, memory_id, speaker_tag)
    if not selected_voice:
        selected_voice = ELEVENLABS_DEFAULT_VOICE_ID.strip()
        if selected_voice:
            status = "voice_fallback_default"
    if not selected_voice:
        selected_voice = _pick_existing_voice_id()
        if selected_voice:
            status = "voice_fallback_existing"
    if not selected_voice:
        return b"", "audio/mpeg", [], "", "no_voice_available"

    payload = {
        "text": clean_text,
        "model_id": ELEVENLABS_TTS_MODEL_ID,
        "output_format": ELEVENLABS_TTS_OUTPUT_FORMAT,
    }
    headers = {
        "xi-api-key": ELEVENLABS_API_KEY,
        "Content-Type": "application/json",
        "Accept": "application/json",
    }
    url = f"{ELEVENLABS_TTS_BASE_URL.rstrip('/')}/{selected_voice}/with-timestamps"
    try:
        with httpx.Client(timeout=120) as client:
            response = client.post(url, headers=headers, json=payload)
        if response.status_code >= 400:
            detail_preview = " ".join((response.text or "").split())[:140]
            logger.error(
                "story_tts_with_timestamps_failed memory_id=%s status=%s detail=%s",
                memory_id,
                response.status_code,
                detail_preview,
            )
            fallback_url = f"{ELEVENLABS_TTS_BASE_URL.rstrip('/')}/{selected_voice}"
            fallback_headers = {
                "xi-api-key": ELEVENLABS_API_KEY,
                "Content-Type": "application/json",
                "Accept": "audio/mpeg",
            }
            with httpx.Client(timeout=120) as client:
                fallback = client.post(
                    fallback_url,
                    headers=fallback_headers,
                    params={"output_format": ELEVENLABS_TTS_OUTPUT_FORMAT},
                    json={"text": clean_text, "model_id": ELEVENLABS_TTS_MODEL_ID},
                )
            if fallback.status_code >= 400:
                fallback_preview = " ".join((fallback.text or "").split())[:140]
                logger.error(
                    "story_tts_fallback_failed memory_id=%s status=%s detail=%s",
                    memory_id,
                    fallback.status_code,
                    fallback_preview,
                )
                return b"", "audio/mpeg", [], "", f"tts_failed_{response.status_code}"
            audio_bytes = fallback.content
            approx_words = _approximate_word_timing(clean_text)
            return audio_bytes, "audio/mpeg", approx_words, selected_voice, "tts_fallback_no_timestamps"
        body = response.json()
        audio_b64 = body.get("audio_base64")
        if not isinstance(audio_b64, str) or not audio_b64:
            return b"", "audio/mpeg", [], "", "tts_missing_audio"
        audio_bytes = base64.b64decode(audio_b64)
        words = _extract_word_timing_from_alignment(body)
        return audio_bytes, "audio/mpeg", words, selected_voice, status
    except Exception:
        logger.exception("story_tts_failed memory_id=%s", memory_id)
        return b"", "audio/mpeg", [], "", "tts_failed"


def _normalize_hex_color(value: object, fallback: str) -> str:
    if isinstance(value, str) and re.fullmatch(r"#[0-9a-fA-F]{6}", value.strip()):
        return value.strip().lower()
    return fallback


def _legacy_cover_svg(memory_id: str, title: str, prompt: str) -> str:
    digest = hashlib.sha256((memory_id + prompt + title).encode("utf-8")).hexdigest()
    c1 = f"#{digest[0:6]}"
    c2 = f"#{digest[6:12]}"
    c3 = f"#{digest[12:18]}"

    safe_title = html.escape((title or "Untitled Story").replace("&", "and")[:48])

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


def _vertex_cover_direction(
    title: str,
    prompt: str,
    ai_summary: str,
    story_children: str,
    story_narration: str,
) -> dict[str, object] | None:
    context = textwrap.shorten(
        " ".join(part for part in (ai_summary, story_children, story_narration) if part),
        width=1400,
        placeholder="...",
    )
    system_prompt = (
    "You are a senior visual art director for animated children's storybook covers. "
    "Your job is to design a cinematic, Pixar-style animated book cover featuring the MAIN CHARACTER(S) from the story. "
    "The cover must feel alive, expressive, emotional, and character-driven — not abstract or symbolic only. "

    "Always include the actual protagonist(s) clearly described with: "
    "age group, gender (if specified), clothing, hairstyle, facial expression, pose, and emotional tone. "
    "The character must be the focal point of the composition. "
    "Background elements should support the character and reflect the story setting. "

    "Visual style guidelines: "
    "3D animated look, soft global illumination, expressive eyes, dynamic pose, shallow depth of field, "
    "storybook warmth, magical atmosphere, detailed textures, subtle motion cues. "

    "Return STRICT JSON with fields: "
    "palette_top, palette_mid, palette_bottom, accent, motif, motion, tagline, character_description, cover_scene. "

    "Rules: "
    "- All colors must be valid hex codes in #RRGGBB format. "
    "- motif must be one of [moon, tree, lantern, kite, stars, home, river]. "
    "- motion must be one of [drift, twinkle, pulse, sway]. "
    "- tagline must be 6 words or fewer. "
    "- character_description must be 1–3 vivid sentences describing the main character visually. "
    "- cover_scene must be 2–4 sentences describing the full animated cover composition in rich detail."
)
    user_prompt = (
        f"Title: {title or 'Untitled Story'}\n"
        f"Prompt: {textwrap.shorten(prompt, width=360, placeholder='...')}\n"
        f"Story context: {context or 'Family memory'}"
    )
    result = _vertex_generate_json(
        system_prompt,
        user_prompt,
        temperature=0.75,
        model=VERTEX_COVER_MODEL,
    )
    if not result:
        return None
    return result


def _vertex_cover_image_part(
    title: str,
    prompt: str,
    ai_summary: str,
    story_children: str,
    story_narration: str,
) -> tuple[str, str, str] | None:
    if not VERTEX_PROJECT_ID or (not VERTEX_API_KEY and not VERTEX_ACCESS_TOKEN):
        return None

    context = textwrap.shorten(
        " ".join(part for part in (ai_summary, story_children, story_narration) if part),
        width=1500,
        placeholder="...",
    )
    endpoint = (
        VERTEX_GENERATIVE_BASE_URL.rstrip("/")
        if VERTEX_GENERATIVE_BASE_URL
        else f"https://{VERTEX_LOCATION}-aiplatform.googleapis.com"
    )
    model_path = (
        VERTEX_COVER_MODEL
        if VERTEX_COVER_MODEL.startswith("publishers/google/models/")
        else f"publishers/google/models/{VERTEX_COVER_MODEL}"
    )
    url = f"{endpoint}/v1/projects/{VERTEX_PROJECT_ID}/locations/{VERTEX_LOCATION}/{model_path}:generateContent"

    headers = {"Content-Type": "application/json"}
    params: dict[str, str] | None = None
    if VERTEX_API_KEY:
        headers["x-goog-api-key"] = VERTEX_API_KEY
        params = {"key": VERTEX_API_KEY}
    if VERTEX_ACCESS_TOKEN:
        headers["Authorization"] = f"Bearer {VERTEX_ACCESS_TOKEN}"

    system_prompt = (
        "You are a children's storybook cover illustrator. "
        "Generate one warm, cinematic portrait image for a family memory cover. "
        "No readable text in the image."
    )
    user_prompt = (
        f"Title: {title or 'Untitled Story'}\n"
        f"Cover prompt: {textwrap.shorten(prompt, width=500, placeholder='...')}\n"
        f"Story context: {context or 'Family memory'}"
    )
    payload = {
        "system_instruction": {"parts": [{"text": system_prompt}]},
        "contents": [{"role": "user", "parts": [{"text": user_prompt}]}],
        "generationConfig": {
            "temperature": 0.8,
            "responseModalities": ["TEXT", "IMAGE"],
            "imageConfig": {"aspectRatio": "3:4"},
        },
    }

    logger.info("vertex_cover_image_request model=%s", VERTEX_COVER_MODEL)
    try:
        with httpx.Client(timeout=60) as client:
            response = client.post(url, params=params, headers=headers, json=payload)
        response.raise_for_status()
    except httpx.HTTPStatusError as exc:
        body_preview = (exc.response.text or "")[:800].replace("\n", " ")
        logger.error(
            "vertex_cover_image_http_error model=%s status=%s body=%s",
            VERTEX_COVER_MODEL,
            exc.response.status_code,
            body_preview,
        )
        return None
    except Exception:
        logger.exception("vertex_cover_image_failed model=%s", VERTEX_COVER_MODEL)
        return None

    body = response.json()
    candidates = body.get("candidates")
    if not isinstance(candidates, list) or not candidates:
        logger.warning("vertex_cover_image_empty_candidates model=%s", VERTEX_COVER_MODEL)
        return None
    content = candidates[0].get("content") if isinstance(candidates[0], dict) else None
    parts = content.get("parts") if isinstance(content, dict) else None
    if not isinstance(parts, list) or not parts:
        logger.warning("vertex_cover_image_empty_parts model=%s", VERTEX_COVER_MODEL)
        return None

    caption = ""
    for part in parts:
        if isinstance(part, dict) and isinstance(part.get("text"), str) and not caption:
            caption = part["text"].strip()
        inline = part.get("inlineData") if isinstance(part, dict) else None
        if isinstance(inline, dict):
            data = inline.get("data")
            mime = inline.get("mimeType")
            if isinstance(data, str) and isinstance(mime, str) and mime.startswith("image/"):
                return data, mime, caption

    logger.warning("vertex_cover_image_missing_inline_data model=%s", VERTEX_COVER_MODEL)
    return None


def _render_image_cover_svg(
    memory_id: str,
    title: str,
    image_b64: str,
    image_mime_type: str,
    caption: str,
) -> str:
    _ = (title, caption)
    svg = f"""<svg xmlns='http://www.w3.org/2000/svg' width='800' height='1200' viewBox='0 0 800 1200'>
  <image href='data:{image_mime_type};base64,{image_b64}' x='0' y='0' width='800' height='1200' preserveAspectRatio='none'/>
</svg>"""

    cover_path = COVER_DIR / f"{memory_id}.svg"
    cover_path.write_text(svg, encoding="utf-8")
    return str(cover_path)


def _render_animated_cover_svg(memory_id: str, title: str, direction: dict[str, object]) -> str:
    digest = hashlib.sha256((memory_id + title).encode("utf-8")).hexdigest()
    d1 = f"#{digest[0:6]}"
    d2 = f"#{digest[6:12]}"
    d3 = f"#{digest[12:18]}"

    c1 = _normalize_hex_color(direction.get("palette_top"), d1)
    c2 = _normalize_hex_color(direction.get("palette_mid"), d2)
    c3 = _normalize_hex_color(direction.get("palette_bottom"), d3)
    accent = _normalize_hex_color(direction.get("accent"), "#f4e6a3")

    motif_raw = str(direction.get("motif") or "stars").strip().lower()
    motif = motif_raw if motif_raw in {"moon", "tree", "lantern", "kite", "stars", "home", "river"} else "stars"
    motion_raw = str(direction.get("motion") or "drift").strip().lower()
    motion = motion_raw if motion_raw in {"drift", "twinkle", "pulse", "sway"} else "drift"

    safe_title = html.escape((title or "Untitled Story").strip()[:52])
    raw_tagline = " ".join(str(direction.get("tagline") or "").split())[:70]
    safe_tagline = html.escape(raw_tagline) if raw_tagline else "A family storybook memory"

    title_len = len(safe_title)
    title_size = min(94, max(46, 102 - title_len * 2))
    move_animation = (
        "<animateTransform attributeName='transform' type='translate' values='0 0; 0 -14; 0 0' dur='8s' repeatCount='indefinite'/>"
        if motion in {"drift", "sway"}
        else "<animate attributeName='opacity' values='0.45;0.85;0.45' dur='4.2s' repeatCount='indefinite'/>"
    )

    motifs: dict[str, str] = {
        "moon": "<circle cx='702' cy='260' r='88' fill='rgba(255,255,255,0.4)'/>",
        "tree": "<path d='M220 900 C255 760 360 690 430 890 Z' fill='rgba(255,255,255,0.24)'/>",
        "lantern": "<rect x='660' y='290' width='78' height='110' rx='14' fill='rgba(255,255,255,0.3)'/>",
        "kite": "<polygon points='650,240 740,320 650,400 560,320' fill='rgba(255,255,255,0.22)'/>",
        "stars": "<g><circle cx='180' cy='220' r='6'/><circle cx='270' cy='170' r='4'/><circle cx='740' cy='210' r='5'/></g>",
        "home": "<path d='M610 410 L700 330 L790 410 V520 H610 Z' fill='rgba(255,255,255,0.24)'/>",
        "river": "<path d='M40 830 C260 760, 580 940, 860 860' stroke='rgba(255,255,255,0.3)' stroke-width='26' fill='none'/>",
    }
    motif_svg = motifs[motif]
    sparkle_anim = (
        "<animate attributeName='opacity' values='0.15;0.8;0.15' dur='3.4s' repeatCount='indefinite'/>"
        if motion in {"twinkle", "pulse"}
        else "<animate attributeName='opacity' values='0.25;0.55;0.25' dur='6.2s' repeatCount='indefinite'/>"
    )

    svg = f"""<svg xmlns='http://www.w3.org/2000/svg' width='900' height='1200' viewBox='0 0 900 1200'>
  <defs>
    <linearGradient id='bg' x1='0' y1='0' x2='0' y2='1'>
      <stop offset='0%' stop-color='{c1}'/>
      <stop offset='54%' stop-color='{c2}'/>
      <stop offset='100%' stop-color='{c3}'/>
    </linearGradient>
    <radialGradient id='glow' cx='50%' cy='42%' r='54%'>
      <stop offset='0%' stop-color='{accent}' stop-opacity='0.45'/>
      <stop offset='100%' stop-color='{accent}' stop-opacity='0'/>
    </radialGradient>
  </defs>
  <rect width='900' height='1200' fill='url(#bg)'/>
  <circle cx='450' cy='470' r='470' fill='url(#glow)'>
    {sparkle_anim}
  </circle>
  <g fill='{accent}'>
    <circle cx='132' cy='220' r='4'>{sparkle_anim}</circle>
    <circle cx='760' cy='300' r='5'>{sparkle_anim}</circle>
    <circle cx='300' cy='930' r='5'>{sparkle_anim}</circle>
  </g>
  <g>
    {motif_svg}
    {move_animation}
  </g>
  <text x='450' y='760' text-anchor='middle' dominant-baseline='middle' fill='white' font-size='{title_size}' font-family='Inter, \"Segoe UI\", \"Helvetica Neue\", Arial, sans-serif' font-weight='800'>{safe_title}</text>
  <text x='450' y='845' text-anchor='middle' fill='rgba(255,255,255,0.94)' font-size='34' font-family='Georgia, Times, serif'>{safe_tagline}</text>
</svg>"""

    cover_path = COVER_DIR / f"{memory_id}.svg"
    cover_path.write_text(svg, encoding="utf-8")
    return str(cover_path)


def generate_cover_svg(
    memory_id: str,
    title: str,
    prompt: str,
    ai_summary: str = "",
    story_children: str = "",
    story_narration: str = "",
) -> tuple[str, str]:
    logger.info("cover_generation_started memory_id=%s title=%s", memory_id, (title or "Untitled")[:80])
    if not VERTEX_PROJECT_ID or (not VERTEX_API_KEY and not VERTEX_ACCESS_TOKEN):
        logger.warning("cover_generation_fallback memory_id=%s reason=no_vertex_config", memory_id)
        return _legacy_cover_svg(memory_id, title, prompt), "generated_fallback_no_vertex_config"

    try:
        image_result = _vertex_cover_image_part(title, prompt, ai_summary, story_children, story_narration)
        if image_result:
            image_b64, image_mime_type, caption = image_result
            logger.info("cover_generation_success memory_id=%s provider=vertex mode=image", memory_id)
            return _render_image_cover_svg(memory_id, title, image_b64, image_mime_type, caption), "generated_vertex"

        direction = _vertex_cover_direction(title, prompt, ai_summary, story_children, story_narration)
        if direction:
            logger.info("cover_generation_success memory_id=%s provider=vertex mode=direction", memory_id)
            return _render_animated_cover_svg(memory_id, title, direction), "generated_vertex_direction_only"
        logger.warning("cover_generation_fallback memory_id=%s reason=empty_vertex_response", memory_id)
        return _legacy_cover_svg(memory_id, title, prompt), "generated_fallback_empty_vertex_response"
    except Exception:
        logger.exception("cover_generation_fallback memory_id=%s reason=vertex_error", memory_id)

    return _legacy_cover_svg(memory_id, title, prompt), "generated_fallback_vertex_error"


def _vertex_generate_json(
    system_prompt: str,
    user_prompt: str,
    *,
    temperature: float = 0.2,
    model: str | None = None,
) -> dict | None:
    """Call Vertex Gemini generateContent; return parsed JSON dict or None."""
    if not VERTEX_PROJECT_ID or (not VERTEX_API_KEY and not VERTEX_ACCESS_TOKEN):
        return None

    endpoint = (
        VERTEX_GENERATIVE_BASE_URL.rstrip("/")
        if VERTEX_GENERATIVE_BASE_URL
        else f"https://{VERTEX_LOCATION}-aiplatform.googleapis.com"
    )
    selected_model = model or VERTEX_STORY_MODEL
    model_path = (
        selected_model
        if selected_model.startswith("publishers/google/models/")
        else f"publishers/google/models/{selected_model}"
    )
    url = f"{endpoint}/v1/projects/{VERTEX_PROJECT_ID}/locations/{VERTEX_LOCATION}/{model_path}:generateContent"

    headers = {"Content-Type": "application/json"}
    params: dict[str, str] | None = None
    if VERTEX_API_KEY:
        headers["x-goog-api-key"] = VERTEX_API_KEY
        params = {"key": VERTEX_API_KEY}
    if VERTEX_ACCESS_TOKEN:
        headers["Authorization"] = f"Bearer {VERTEX_ACCESS_TOKEN}"

    is_image_model = "flash-image" in selected_model
    generation_config: dict[str, object] = {
        "temperature": temperature,
    }
    if is_image_model:
        generation_config["responseModalities"] = ["TEXT", "IMAGE"]
        generation_config["imageConfig"] = {"aspectRatio": "3:4"}
    else:
        generation_config["responseMimeType"] = "application/json"

    payload = {
        "system_instruction": {"parts": [{"text": system_prompt}]},
        "contents": [{"role": "user", "parts": [{"text": user_prompt}]}],
        "generationConfig": generation_config,
    }

    logger.info("vertex_generate_json_request model=%s temperature=%.2f", selected_model, temperature)
    try:
        with httpx.Client(timeout=30) as client:
            response = client.post(url, params=params, headers=headers, json=payload)
        response.raise_for_status()
    except httpx.HTTPStatusError as exc:
        body_preview = (exc.response.text or "")[:800].replace("\n", " ")
        logger.error(
            "vertex_generate_json_http_error model=%s status=%s body=%s",
            selected_model,
            exc.response.status_code,
            body_preview,
        )
        return None
    except Exception:
        logger.exception("vertex_generate_json_failed model=%s", selected_model)
        return None

    body = response.json()
    candidates = body.get("candidates")
    if not isinstance(candidates, list) or not candidates:
        logger.warning("vertex_generate_json_empty_candidates model=%s", selected_model)
        return None
    first = candidates[0]
    content = first.get("content") if isinstance(first, dict) else None
    parts = content.get("parts") if isinstance(content, dict) else None
    if not isinstance(parts, list) or not parts:
        logger.warning("vertex_generate_json_empty_parts model=%s", selected_model)
        return None
    text: str | None = None
    for part in parts:
        if isinstance(part, dict) and isinstance(part.get("text"), str):
            text = part["text"]
            break
    if not isinstance(text, str):
        logger.warning("vertex_generate_json_missing_text model=%s", selected_model)
        return None
    raw = text.strip()
    if raw.startswith("```"):
        lines = raw.splitlines()
        if lines:
            lines = lines[1:]
        if lines and lines[-1].strip().startswith("```"):
            lines = lines[:-1]
        raw = "\n".join(lines).strip()
    if raw and "{" in raw and "}" in raw:
        raw = raw[raw.find("{") : raw.rfind("}") + 1]
    try:
        parsed = json.loads(raw)
        return parsed if isinstance(parsed, dict) else None
    except json.JSONDecodeError:
        logger.warning("vertex_generate_json_invalid_json model=%s", selected_model)
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
