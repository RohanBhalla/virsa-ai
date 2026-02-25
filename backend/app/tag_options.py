"""Defined option lists for mood_tag and themes on memory documents."""

# Single choice: exactly one mood per memory. Used by sentiment agent.
MOOD_OPTIONS: tuple[str, ...] = (
    "joyful",
    "bittersweet",
    "nostalgic",
    "sad",
    "hopeful",
    "reflective",
    "somber",
    "neutral",
    "peaceful",
)

# Multi-choice: zero or more themes per memory. Used by themes agent.
THEMES_OPTIONS: tuple[str, ...] = (
    "family",
    "courage",
    "immigration",
    "tradition",
    "food",
    "war",
    "faith",
    "love",
    "resilience",
    "loss",
    "childhood",
    "marriage",
    "education",
    "identity",
    "community",
)

MOOD_DEFAULT = "neutral"
