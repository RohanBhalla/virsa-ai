from pathlib import Path
import os
from dotenv import load_dotenv

BASE_DIR = Path(__file__).resolve().parent.parent
load_dotenv(BASE_DIR / ".env")
DATA_DIR = BASE_DIR / "data"
AUDIO_DIR = DATA_DIR / "audio"
COVER_DIR = DATA_DIR / "covers"
DB_PATH = DATA_DIR / "app.db"

ELEVENLABS_API_KEY = os.getenv("ELEVENLABS_API_KEY", "")
ELEVENLABS_MODEL_ID = os.getenv("ELEVENLABS_MODEL_ID", "scribe_v1")
ELEVENLABS_STT_URL = os.getenv("ELEVENLABS_STT_URL", "https://api.elevenlabs.io/v1/speech-to-text")

APP_ORIGIN = os.getenv("APP_ORIGIN", "http://localhost:5173")

for path in (DATA_DIR, AUDIO_DIR, COVER_DIR):
    path.mkdir(parents=True, exist_ok=True)
