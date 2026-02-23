# Virsa AI Webapp (Step 1)

Responsive web app to:
- record voice memories,
- transcribe with ElevenLabs,
- index transcript chunks in a lightweight RAG store,
- generate story text,
- generate storybook-style cover cards.

## Project Structure

- `backend/` FastAPI API + SQLite + local file storage
- `frontend/` React + Vite responsive UI

## Run Backend

```bash
cd backend
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
uvicorn app.main:app --reload --port 8000
```

Set `ELEVENLABS_API_KEY` in `.env` for real transcription.

## Run Frontend

```bash
cd frontend
npm install
cp .env.example .env
npm run dev
```

Open `http://localhost:5173`.

## Step 1 Flow

1. Record audio.
2. Save recording.
3. Click `Transcribe` (ElevenLabs).
4. Click `Create Story` (RAG-assisted prompt context).
5. Click `Create Cover` (storybook card cover SVG).

## Notes

- Current story generation is a deterministic fallback to keep development unblocked.
- Cover generation currently writes SVG cards locally. Swap this with an image model later for full AI image generation.
