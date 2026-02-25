import type { Memory } from '../types'
import { toAssetUrl } from '../api'

function formatTag(value: string): string {
  return value.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

type MemoryCardProps = {
  item: Memory
  busy: boolean
  onTranscribe: (id: string) => void
  onStory: (id: string) => void
  onCover: (id: string) => void
}

export function MemoryCard({ item, busy, onTranscribe, onStory, onCover }: MemoryCardProps) {
  const coverUrl = item.cover_path ? toAssetUrl(`/covers/${item.id}.svg?v=${encodeURIComponent(item.updated_at || '')}`) : ''
  const mood = item.mood_tag?.trim()
  const themes = item.themes?.length ? item.themes : []

  return (
    <article className="memory-card">
      <div className="memory-cover-wrap">
        {coverUrl ? <img src={coverUrl} alt={`${item.title} cover`} className="memory-cover" /> : <div className="memory-cover placeholder">No cover yet</div>}
      </div>
      <div className="memory-content">
        <h3>{item.title}</h3>
        <p className="meta">{new Date(item.created_at).toLocaleString()}</p>
        {(mood || themes.length > 0) ? (
          <div className="memory-tags">
            {mood ? <span className="memory-tag memory-tag-mood">{formatTag(mood)}</span> : null}
            {themes.map((t) => (
              <span key={t} className="memory-tag memory-tag-theme">{formatTag(t)}</span>
            ))}
          </div>
        ) : null}
        <p className="excerpt">{item.ai_summary || item.transcript.slice(0, 120) || 'Record and transcribe to generate a story.'}</p>
        <div className="actions">
          <button className="chip" disabled={busy} onClick={() => onTranscribe(item.id)}>Transcribe</button>
          <button className="chip" disabled={busy || !item.transcript} onClick={() => onStory(item.id)}>Create Story</button>
          <button className="chip" disabled={busy || !item.ai_summary} onClick={() => onCover(item.id)}>Create Cover</button>
        </div>
      </div>
    </article>
  )
}
