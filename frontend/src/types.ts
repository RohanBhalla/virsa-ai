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
  story_short: string
  story_long: string
  cover_path: string
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
