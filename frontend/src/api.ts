import type { Memory } from './types'

const API_BASE = import.meta.env.VITE_API_BASE ?? 'http://localhost:8000'

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${url}`, init)
  if (!res.ok) {
    const text = await res.text()
    throw new Error(text || `Request failed: ${res.status}`)
  }
  return (await res.json()) as T
}

export async function listMemories(): Promise<Memory[]> {
  const data = await fetchJson<{ items: Memory[] }>('/api/memories')
  return data.items
}

export async function createMemory(file: Blob, title: string): Promise<{ id: string }> {
  const fd = new FormData()
  fd.append('audio', file, 'memory.webm')
  fd.append('title', title)
  return fetchJson<{ id: string }>('/api/memories', { method: 'POST', body: fd })
}

export async function transcribeMemory(id: string): Promise<{ transcript: string }> {
  return fetchJson<{ transcript: string }>(`/api/memories/${id}/transcribe`, {
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

export { API_BASE }
