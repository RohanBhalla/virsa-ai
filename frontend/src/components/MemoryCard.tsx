import type { Memory } from '../types'
import { toAssetUrl } from '../api'

type MemoryCardProps = {
  item: Memory
  busy: boolean
  onTranscribe: (id: string) => void
  onStory: (id: string) => void
  onCover: (id: string) => void
}

export function MemoryCard({ item, busy, onTranscribe, onStory, onCover }: MemoryCardProps) {
  const coverUrl = item.cover_path ? toAssetUrl(`/covers/${item.id}.svg`) : ''

  return (
    <article className="memory-card">
      <div className="memory-cover-wrap">
        {coverUrl ? <img src={coverUrl} alt={`${item.title} cover`} className="memory-cover" /> : <div className="memory-cover placeholder">No cover yet</div>}
      </div>
      <div className="memory-content">
        <h3>{item.title}</h3>
        <p className="meta">{new Date(item.created_at).toLocaleString()}</p>
        <p className="excerpt">{item.story_short || item.transcript.slice(0, 120) || 'Record and transcribe to generate a story.'}</p>
        <div className="actions">
          <button className="chip" disabled={busy} onClick={() => onTranscribe(item.id)}>Transcribe</button>
          <button className="chip" disabled={busy || !item.transcript} onClick={() => onStory(item.id)}>Create Story</button>
          <button className="chip" disabled={busy || !item.story_short} onClick={() => onCover(item.id)}>Create Cover</button>
        </div>
      </div>
    </article>
  )
}
