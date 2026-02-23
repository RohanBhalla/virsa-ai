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
