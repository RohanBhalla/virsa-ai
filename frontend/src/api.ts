import type { AuthResponse, Memory, TranscriptWord, User } from './types'

const API_BASE = import.meta.env.VITE_API_BASE ?? 'http://localhost:8000'
let accessToken = ''

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

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers)
  if (accessToken) headers.set('Authorization', `Bearer ${accessToken}`)

  const res = await fetch(`${API_BASE}${url}`, {
    ...init,
    headers,
  })
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

export async function generateStory(id: string, prompt: string): Promise<{ story_short: string; story_long: string }> {
  const fd = new FormData()
  fd.append('prompt', prompt)
  return fetchJson<{ story_short: string; story_long: string }>(`/api/memories/${id}/story`, {
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
  const res = await fetch(`${API_BASE}${path}`, { headers })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(parseApiError(text, res.status))
  }
  return res.blob()
}

export { API_BASE }
