from __future__ import annotations

import argparse
import json

from .db import init_db, memories_collection, now_iso
from .services import generate_cover_svg


def generate_cover_for_memory(memory_id: str) -> dict[str, str]:
    clean_id = (memory_id or "").strip()
    if not clean_id:
        raise ValueError("memory_id cannot be empty")

    init_db()
    row = memories_collection().find_one(
        {"id": clean_id},
        {"_id": 0, "id": 1, "title": 1, "ai_summary": 1, "story_children": 1, "story_narration": 1},
    )
    if not row:
        raise ValueError(f"memory not found: {clean_id}")

    cover_path, cover_status = generate_cover_svg(
        clean_id,
        str(row.get("title") or "Untitled"),
        "Animated storybook cover with warm family tones",
        str(row.get("ai_summary") or ""),
        str(row.get("story_children") or ""),
        str(row.get("story_narration") or ""),
    )
    memories_collection().update_one(
        {"id": clean_id},
        {"$set": {"cover_path": cover_path, "cover_status": cover_status, "updated_at": now_iso()}},
    )

    return {
        "id": clean_id,
        "cover_path": cover_path,
        "cover_url": f"/covers/{clean_id}.svg",
        "cover_status": cover_status,
    }


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Generate a cover for a memory ID.")
    parser.add_argument("memory_id", help="Memory ID to generate cover for")
    return parser.parse_args()


def main() -> None:
    args = _parse_args()
    result = generate_cover_for_memory(args.memory_id)
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
