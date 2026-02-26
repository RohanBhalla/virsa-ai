# Virsa AI - AI for Good Hackathon Project Description

## Overview
Virsa AI is a full-stack storytelling platform built for the **AI for Good** hackathon. It helps families preserve intergenerational memories by converting recorded oral stories into searchable, structured, and shareable digital heritage artifacts.

The product flow is:
1. Record a family memory.
2. Transcribe speech to text.
3. Enrich and index the memory semantically.
4. Generate story variants and synthetic narration.
5. Generate a storybook-style visual cover.
6. Enable semantic search and persona-grounded Q&A across memories.

## Why This Is “AI for Good”
- Preserves oral history from elders that is often lost across generations.
- Makes family memory archives easier to navigate using AI retrieval, not just manual tagging.
- Creates accessible outputs (text, audio, visual cover) for different age groups and learning styles.
- Supports cultural continuity by keeping memory context tied to people and family relationships.

## Technical Architecture

### Frontend
- **React + TypeScript + Vite**
- Interactive interfaces for recording, memory detail pages, memory map graph, and family graph.
- Uses authenticated API client with automatic token refresh.

### Backend
- **FastAPI (Python)**
- REST APIs for auth, family graph management, memory ingestion, transcription, story generation, cover generation, search, and persona reply.
- Services layer integrates external AI providers and deterministic fallbacks.

### Database
- **MongoDB Atlas / MongoDB**
- Collections include:
  - `memories`
  - `memory_chunks`
  - `family_people`
  - `family_edges`
  - `users`
  - `auth_sessions`
  - `playback_positions`
- Atlas Vector Search is used over `memory_chunks.embedding` for semantic retrieval.

### Media Storage
- Local file storage for uploaded audio, generated story audio, and SVG cover files.
- Optional duplication in GridFS.

## AI Agent System (Core Highlight)
Virsa AI is implemented as a practical **multi-agent pipeline**, where each “agent” is a specialized capability in the backend services.

### 1) Speech Capture Agent (Transcription)
- Uses ElevenLabs Speech-to-Text.
- Produces transcript plus word-level timing where available.
- Supports language hints for voice search ingestion.

### 2) Memory Indexing Agent (Embedding + Vectorization)
- Splits transcript into chunks.
- Generates embeddings via configurable provider:
  - Vertex AI embeddings
  - Gemini embeddings
  - Local deterministic hash fallback
- Writes vectors to `memory_chunks` for semantic search and related-memory discovery.

### 3) Story Composer Agent (Narrative Generation)
- Uses retrieved context from vector search + original transcript.
- Generates three outputs:
  - `ai_summary` (book-jacket style)
  - `story_children` (child-friendly retelling)
  - `story_narration` (documentary style)
- Uses Vertex generative model with deterministic fallback when unavailable.

### 4) Voice Preservation Agent (TTS + Voice Clone)
- Converts generated story variants to audio narration.
- Attempts voice cloning from original speaker sample.
- Falls back to configured/default/existing voices if cloning fails.
- Stores generated audio plus approximate or provider timing metadata.

### 5) Cover Art Agent (Generative Visuals)
- Uses Vertex multimodal generation for storybook-style cover imagery.
- If image output is unavailable, falls back to AI-directed animated SVG design.
- If Vertex is unavailable, falls back to deterministic gradient SVG cover generation.

### 6) Memory Insight Agent (Mood + Themes)
- Classifies transcript mood from constrained label set.
- Extracts themes from controlled taxonomy.
- Improves filtering, discovery, and memory-map clustering.

### 7) Persona Reply Agent (Reply-As Assistant)
- Answers user questions in first person as a selected family member.
- Grounds responses in:
  - retrieved memory context,
  - speaker profile,
  - family relationship graph context.
- Uses retrieval-augmented prompting with conservative fallback responses.

### 8) Semantic Search Agent (Text + Voice Query)
- Accepts typed query or voice query.
- Voice query is transcribed, then semantically searched over memory vectors.
- Returns top-ranked memories in best-match order.

## AI Safety and Reliability Strategy
- Controlled-output prompting for structured JSON where needed.
- Strict fallback behavior for offline or missing-key operation.
- Non-crashing degradations (local hash embeddings, deterministic text/cover generation).
- User-scoped data access via authenticated ownership checks on memory resources.

## Key API Capabilities
- `POST /api/memories` - upload new memory audio.
- `POST /api/memories/{id}/transcribe` - transcript + tags + embedding index.
- `POST /api/memories/{id}/story` - generate story variants.
- `POST /api/memories/{id}/story-audio/{variant}` - synthesize variant audio.
- `POST /api/memories/{id}/cover` - generate cover art.
- `POST /api/search` - semantic search from text or voice.
- `POST /api/geek/reply-as` - persona-grounded family-memory Q&A.
- `GET /api/memories/graph` and `GET /api/memories/{id}/related` - memory relationship graphing.

## Hackathon Build Qualities
- End-to-end working prototype (capture -> AI enrichment -> retrieval -> storytelling outputs).
- Demonstrates practical multi-agent orchestration, not just single-shot prompting.
- Designed for social impact through memory preservation, accessibility, and family connection.
