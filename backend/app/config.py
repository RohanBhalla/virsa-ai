from pathlib import Path
import os
from dotenv import load_dotenv

BASE_DIR = Path(__file__).resolve().parent.parent
load_dotenv(BASE_DIR / ".env")
DATA_DIR = BASE_DIR / "data"
AUDIO_DIR = DATA_DIR / "audio"
COVER_DIR = DATA_DIR / "covers"

ELEVENLABS_API_KEY = os.getenv("ELEVENLABS_API_KEY", "")
ELEVENLABS_MODEL_ID = os.getenv("ELEVENLABS_MODEL_ID", "scribe_v1")
ELEVENLABS_STT_URL = os.getenv("ELEVENLABS_STT_URL", "https://api.elevenlabs.io/v1/speech-to-text")
VOICE_SEARCH_LANGUAGE_HINT = os.getenv("VOICE_SEARCH_LANGUAGE_HINT", "en").strip().lower()

APP_ORIGIN = os.getenv("APP_ORIGIN", "http://localhost:5173")

MONGODB_URI = os.getenv("MONGODB_URI", "mongodb://localhost:27017")
MONGODB_DB_NAME = os.getenv("MONGODB_DB_NAME", "virsa_ai")
MONGODB_MEMORIES_COLLECTION = os.getenv("MONGODB_MEMORIES_COLLECTION", "memories")
MONGODB_CHUNKS_COLLECTION = os.getenv("MONGODB_CHUNKS_COLLECTION", "memory_chunks")
MONGODB_PLAYBACK_COLLECTION = os.getenv("MONGODB_PLAYBACK_COLLECTION", "playback_positions")
MONGODB_USERS_COLLECTION = os.getenv("MONGODB_USERS_COLLECTION", "users")
MONGODB_AUTH_SESSIONS_COLLECTION = os.getenv("MONGODB_AUTH_SESSIONS_COLLECTION", "auth_sessions")
MONGODB_FAMILY_PEOPLE_COLLECTION = os.getenv("MONGODB_FAMILY_PEOPLE_COLLECTION", "family_people")
MONGODB_FAMILY_EDGES_COLLECTION = os.getenv("MONGODB_FAMILY_EDGES_COLLECTION", "family_edges")
MONGODB_VECTOR_INDEX = os.getenv("MONGODB_VECTOR_INDEX", "memory_chunks_vector_index")

# Embedding provider selection. Supported: vertex | gemini | local
EMBEDDING_PROVIDER = os.getenv("EMBEDDING_PROVIDER", "vertex").lower()

VERTEX_PROJECT_ID = os.getenv("VERTEX_PROJECT_ID", "")
VERTEX_LOCATION = os.getenv("VERTEX_LOCATION", "us-central1")
VERTEX_API_KEY = os.getenv("VERTEX_API_KEY", "")
VERTEX_ACCESS_TOKEN = os.getenv("VERTEX_ACCESS_TOKEN", "")
VERTEX_EMBEDDING_MODEL = os.getenv("VERTEX_EMBEDDING_MODEL", "gemini-embedding-001")
VERTEX_EMBEDDING_BASE_URL = os.getenv("VERTEX_EMBEDDING_BASE_URL", "")
VERTEX_STORY_MODEL = os.getenv("VERTEX_STORY_MODEL", "gemini-2.0-flash-001")
VERTEX_GENERATIVE_BASE_URL = os.getenv("VERTEX_GENERATIVE_BASE_URL", "")

GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "")
GEMINI_EMBEDDING_MODEL = os.getenv("GEMINI_EMBEDDING_MODEL", "gemini-embedding-001")
GEMINI_EMBEDDING_BASE_URL = os.getenv("GEMINI_EMBEDDING_BASE_URL", "https://generativelanguage.googleapis.com/v1beta")

EMBEDDING_DIM = int(os.getenv("EMBEDDING_DIM", "3072"))

# Optional external sentiment service. If not configured, a local heuristic is used.
SENTIMENT_API_URL = os.getenv("SENTIMENT_API_URL", "")
SENTIMENT_API_KEY = os.getenv("SENTIMENT_API_KEY", "")

# Store a second copy of uploaded audio in MongoDB GridFS when enabled.
STORE_AUDIO_IN_GRIDFS = os.getenv("STORE_AUDIO_IN_GRIDFS", "false").lower() == "true"

# Authentication
JWT_SECRET_KEY = os.getenv("JWT_SECRET_KEY", "")
JWT_ALGORITHM = os.getenv("JWT_ALGORITHM", "HS256")
JWT_ISSUER = os.getenv("JWT_ISSUER", "virsa-ai")
JWT_AUDIENCE = os.getenv("JWT_AUDIENCE", "virsa-ai-users")
ACCESS_TOKEN_TTL_MINUTES = int(os.getenv("ACCESS_TOKEN_TTL_MINUTES", "15"))
REFRESH_TOKEN_TTL_DAYS = int(os.getenv("REFRESH_TOKEN_TTL_DAYS", "14"))
REFRESH_TOKEN_HASH_SECRET = os.getenv("REFRESH_TOKEN_HASH_SECRET", "")

for path in (DATA_DIR, AUDIO_DIR, COVER_DIR):
    path.mkdir(parents=True, exist_ok=True)
