import type {
  AuthResponse,
  Memory,
  MemoryGraph,
  RelatedMemoryItem,
  TranscriptWord,
  User,
} from './types'

const API_BASE = import.meta.env.VITE_API_BASE ?? 'http://localhost:8000'
const ACCESS_TOKEN_KEY = 'virsa_access_token'
const REFRESH_TOKEN_KEY = 'virsa_refresh_token'
let accessToken = ''
let refreshInFlight: Promise<boolean> | null = null

function parseApiError(raw: string, status: number): string {
  try {
    const body = JSON.parse(raw) as { detail?: string }
    if (typeof body.detail === 'string' && body.detail.trim()) return body.detail
  } catch {
    // Ignore invalid JSON error body.
  }
  return raw || `Request failed: ${status}`
}

export function setAccessToken(token: string) {
  accessToken = token
}

function clearStoredAuth() {
  localStorage.removeItem(ACCESS_TOKEN_KEY)
  localStorage.removeItem(REFRESH_TOKEN_KEY)
  accessToken = ''
}

async function refreshAccessTokenFromStorage(): Promise<boolean> {
  if (refreshInFlight) return refreshInFlight

  const refreshToken = localStorage.getItem(REFRESH_TOKEN_KEY) || ''
  if (!refreshToken) return false

  refreshInFlight = (async () => {
    const res = await fetch(`${API_BASE}/api/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: refreshToken }),
    })
    if (!res.ok) {
      clearStoredAuth()
      return false
    }

    const data = (await res.json()) as { access_token: string; refresh_token: string }
    if (!data.access_token || !data.refresh_token) {
      clearStoredAuth()
      return false
    }

    accessToken = data.access_token
    localStorage.setItem(ACCESS_TOKEN_KEY, data.access_token)
    localStorage.setItem(REFRESH_TOKEN_KEY, data.refresh_token)
    return true
  })()

  try {
    return await refreshInFlight
  } finally {
    refreshInFlight = null
  }
}

async function fetchJson<T>(url: string, init?: RequestInit, hasRetried = false): Promise<T> {
  const headers = new Headers(init?.headers)
  if (accessToken) headers.set('Authorization', `Bearer ${accessToken}`)

  const res = await fetch(`${API_BASE}${url}`, {
    ...init,
    headers,
  })

  if (res.status === 401 && !hasRetried) {
    const refreshed = await refreshAccessTokenFromStorage()
    if (refreshed) return fetchJson<T>(url, init, true)
  }

  if (!res.ok) {
    const text = await res.text()
    throw new Error(parseApiError(text, res.status))
  }
  return (await res.json()) as T
}

export async function listMemories(): Promise<Memory[]> {
  const data = await fetchJson<{ items: Memory[] }>('/api/memories')
  return data.items
}

export async function getSpeakers(): Promise<string[]> {
  const data = await fetchJson<{ speakers: string[] }>('/api/speakers')
  return data.speakers
}

export async function createMemory(file: Blob, title: string, speakerTag: string): Promise<{ id: string }> {
  const fd = new FormData()
  fd.append('audio', file, 'memory.webm')
  fd.append('title', title)
  fd.append('speaker_tag', speakerTag)
  return fetchJson<{ id: string }>('/api/memories', { method: 'POST', body: fd })
}

export async function transcribeMemory(id: string): Promise<{ transcript: string; transcript_timing: TranscriptWord[] }> {
  return fetchJson<{ transcript: string; transcript_timing: TranscriptWord[] }>(`/api/memories/${id}/transcribe`, {
    method: 'POST',
  })
}

export async function generateStory(
  id: string,
  prompt: string
): Promise<{
  ai_summary: string
  story_children: string
  story_narration: string
  ai_summary_status: string
}> {
  const fd = new FormData()
  fd.append('prompt', prompt)
  return fetchJson<{
    ai_summary: string
    story_children: string
    story_narration: string
    ai_summary_status: string
  }>(`/api/memories/${id}/story`, {
    method: 'POST',
    body: fd,
  })
}

export async function generateCover(id: string, prompt: string): Promise<{ cover_url: string }> {
  const fd = new FormData()
  fd.append('prompt', prompt)
  return fetchJson<{ cover_url: string }>(`/api/memories/${id}/cover`, {
    method: 'POST',
    body: fd,
  })
}

export function toAssetUrl(coverUrl: string): string {
  if (coverUrl.startsWith('http')) return coverUrl
  return `${API_BASE}${coverUrl}`
}

export async function register(email: string, password: string, name: string): Promise<AuthResponse> {
  return fetchJson<AuthResponse>('/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, name }),
  })
}

export async function login(email: string, password: string): Promise<AuthResponse> {
  return fetchJson<AuthResponse>('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  })
}

export async function refreshAuth(refreshToken: string): Promise<Omit<AuthResponse, 'user'>> {
  return fetchJson<Omit<AuthResponse, 'user'>>('/api/auth/refresh', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refresh_token: refreshToken }),
  })
}

export async function logout(refreshToken: string): Promise<{ status: string }> {
  return fetchJson<{ status: string }>('/api/auth/logout', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refresh_token: refreshToken }),
  })
}

export async function getMe(): Promise<User> {
  const data = await fetchJson<{ user: User }>('/api/auth/me')
  return data.user
}

export async function fetchProtectedBlob(path: string): Promise<Blob> {
  const headers = new Headers()
  if (accessToken) headers.set('Authorization', `Bearer ${accessToken}`)
  let res = await fetch(`${API_BASE}${path}`, { headers })
  if (res.status === 401) {
    const refreshed = await refreshAccessTokenFromStorage()
    if (refreshed) {
      const retryHeaders = new Headers()
      if (accessToken) retryHeaders.set('Authorization', `Bearer ${accessToken}`)
      res = await fetch(`${API_BASE}${path}`, { headers: retryHeaders })
    }
  }
  if (!res.ok) {
    const text = await res.text()
    throw new Error(parseApiError(text, res.status))
  }
  return res.blob()
}

export type SearchResponse = { query: string; items: Memory[] }

export async function searchStories(query: string): Promise<SearchResponse> {
  return fetchJson<SearchResponse>('/api/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  })
}

export async function searchStoriesWithAudio(audioBlob: Blob): Promise<SearchResponse> {
  const fd = new FormData()
  fd.append('audio', audioBlob, 'search.webm')
  return fetchJson<SearchResponse>('/api/search', {
    method: 'POST',
    body: fd,
  })
}

export async function getMemoryGraph(params?: {
  theme?: string
  limit?: number
}): Promise<MemoryGraph> {
  const sp = new URLSearchParams()
  if (params?.theme != null && params.theme !== '') sp.set('theme', params.theme)
  if (params?.limit != null) sp.set('limit', String(params.limit))
  const qs = sp.toString()
  return fetchJson<MemoryGraph>(`/api/memories/graph${qs ? `?${qs}` : ''}`)
}

export async function getRelatedMemories(
  memoryId: string,
  topK?: number
): Promise<{ items: RelatedMemoryItem[] }> {
  const sp = new URLSearchParams()
  if (topK != null) sp.set('top_k', String(topK))
  const qs = sp.toString()
  return fetchJson<{ items: RelatedMemoryItem[] }>(
    `/api/memories/${memoryId}/related${qs ? `?${qs}` : ''}`
  )
}

export { API_BASE }
