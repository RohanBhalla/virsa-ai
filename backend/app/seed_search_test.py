"""
Seed test data for vector search: memories and chunks for a given user_id.
Run from backend dir: python -m app.seed_search_test
"""
from __future__ import annotations

from uuid import uuid4

from .db import init_db, memories_collection, chunks_collection, now_iso
from .rag import chunk_text, embed_texts, embedding_model_name

TEST_USER_ID = "a672f3b6-50bf-401d-b3fe-ad7fb534e332"

# Distinct stories so semantic search can match queries like "war", "recipe", "lake", "wedding"
TEST_MEMORIES = [
    {
        "title": "Grandfather's War Story",
        "speaker_tag": "Grandpa Joe",
        "transcript": (
            "When I was in the war we had to march for days through the mud. My grandfather never liked to talk about "
            "the war but one day he told us about the time his unit was trapped behind enemy lines. They had no food "
            "for three days. He said the hardest part was not the fighting but missing his family. He wrote letters "
            "every week. When he came home he brought a small photograph of my grandmother that he had carried in his "
            "pocket the whole time. We still have that photograph in the family album."
        ),
        "story_short": "Grandpa Joe shared how his unit was trapped behind enemy lines and how he carried a photo of Grandma the whole war.",
    },
    {
        "title": "Mother's Apple Pie Recipe",
        "speaker_tag": "Mom",
        "transcript": (
            "This is the recipe my mother passed down to me. You need six large apples, preferably Granny Smith. "
            "The secret is in the crust—use cold butter and don't overwork the dough. We always made this recipe "
            "together at Thanksgiving. She would peel the apples and I would mix the cinnamon and sugar. The smell "
            "of baking pie filled the whole house. Now I make it with my own daughter every year. It's our family "
            "tradition. You can add a little nutmeg if you like. Serve it warm with vanilla ice cream."
        ),
        "story_short": "A family recipe for apple pie passed down through generations, made at Thanksgiving.",
    },
    {
        "title": "Family Reunion at the Lake",
        "speaker_tag": "Uncle Dave",
        "transcript": (
            "Every summer we used to go to the lake for the family reunion. All the cousins would swim and play in "
            "the water until the sun went down. We had a big picnic by the shore. Grandma would bring her famous "
            "potato salad. There was a wooden dock we used to jump off into the lake. One year my brother pushed me in "
            "with my clothes on. We still laugh about that. The lake was so clear you could see the fish. At night we "
            "would sit around the fire and tell stories. I miss those summers at the lake."
        ),
        "story_short": "Summer reunions at the lake with swimming, picnics, and stories by the fire.",
    },
    {
        "title": "Aunt Maria's Wedding Day",
        "speaker_tag": "Aunt Maria",
        "transcript": (
            "My wedding day was the happiest day of my life. I wore my mother's veil. The ceremony was in the same "
            "church where my parents were married. All our family and friends were there. My father walked me down "
            "the aisle. I was so nervous I almost dropped the bouquet. The reception was in the garden. We had a "
            "beautiful cake with flowers. We danced until midnight. My husband and I have been married for thirty "
            "years now. I still look at the wedding photos every anniversary."
        ),
        "story_short": "Aunt Maria's wedding in the family church, wearing her mother's veil, with a garden reception.",
    },
]


def main() -> None:
    init_db()
    now = now_iso()
    mem_col = memories_collection()
    chunk_col = chunks_collection()
    model_name = embedding_model_name()

    for m in TEST_MEMORIES:
        memory_id = str(uuid4())
        transcript = m["transcript"]
        chunks = chunk_text(transcript)
        vectors = embed_texts(chunks)

        mem_col.insert_one(
            {
                "id": memory_id,
                "title": m["title"],
                "speaker_tag": m["speaker_tag"],
                "audio": {},
                "transcript": transcript,
                "transcript_timing": [],
                "story_short": m["story_short"],
                "story_long": m["story_short"],
                "cover_path": "",
                "mood_tag": "unknown",
                "ai_summary": m["story_short"][:240],
                "ai_summary_status": "generated_fallback",
                "embedding_status": {
                    "indexed": True,
                    "chunk_count": len(chunks),
                    "model": model_name,
                    "indexed_at": now,
                },
                "user_id": TEST_USER_ID,
                "created_at": now,
                "updated_at": now,
            }
        )

        chunk_docs = [
            {
                "memory_id": memory_id,
                "user_id": TEST_USER_ID,
                "idx": idx,
                "content": chunk,
                "embedding": vectors[idx],
                "embedding_model": model_name,
                "created_at": now,
                "updated_at": now,
            }
            for idx, chunk in enumerate(chunks)
        ]
        chunk_col.insert_many(chunk_docs)
        print(f"  Inserted memory {memory_id}: {m['title']} ({len(chunks)} chunks)")

    print(f"\nDone. Created {len(TEST_MEMORIES)} memories with vector chunks for user_id={TEST_USER_ID}")
    print("Try searching for: 'war', 'recipe', 'lake', 'wedding'")


if __name__ == "__main__":
    main()
