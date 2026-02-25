export type TranscriptWord = {
  text: string
  start: number
  end: number
}

export type Memory = {
  id: string
  title: string
  speaker_tag: string
  audio_path: string
  transcript: string
  transcript_timing: TranscriptWord[]
  story_children: string
  story_narration: string
  ai_summary: string
  ai_summary_status: string
  cover_path: string
  mood_tag?: string
  themes?: string[]
  created_at: string
  updated_at: string
}

export type User = {
  id: string
  email: string
  name: string
  created_at: string
  updated_at: string
}

export type AuthResponse = {
  user: User
  access_token: string
  refresh_token: string
  token_type: string
  access_token_expires_in: number
  refresh_token_expires_in: number
}

export type MemoryGraphEdge = {
  source: string
  target: string
  score: number
}

export type MemoryGraph = {
  nodes: Memory[]
  edges: MemoryGraphEdge[]
}

export type RelatedMemoryItem = {
  memory: Memory
  score: number
}
