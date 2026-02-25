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
  default_family_id?: string
  default_elder_person_id?: string
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

export type FamilyPerson = {
  id: string
  owner_user_id: string
  family_id: string
  is_elder_root: boolean
  display_name: string
  given_name?: string
  family_name?: string
  sex?: 'female' | 'male' | 'other' | 'unknown'
  birth_year?: number | null
  death_year?: number | null
  notes?: string
  created_at: string
  updated_at: string
}

export type FamilyEdge = {
  id: string
  owner_user_id: string
  family_id: string
  kind: 'parent_child' | 'partner'
  from_person_id: string
  to_person_id: string
  relationship_type?: 'biological' | 'adoptive' | 'step' | 'guardian' | 'unknown'
  partner_type?: 'married' | 'partner' | 'divorced' | 'separated' | 'unknown'
  certainty?: 'certain' | 'estimated' | 'unknown'
  start_year?: number | null
  end_year?: number | null
  created_at: string
  updated_at: string
}

export type FamilyTree = {
  family_id: string
  elder_person_id: string
  people: FamilyPerson[]
  edges: FamilyEdge[]
}
