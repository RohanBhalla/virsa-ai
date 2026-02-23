import { useEffect, useMemo, useState } from 'react'
import { API_BASE, createMemory, generateCover, generateStory, listMemories, toAssetUrl, transcribeMemory } from './api'
import { Recorder } from './components/Recorder'
import type { Memory } from './types'

type View = 'home' | 'record' | 'detail'

function parseHash(): { view: View; id?: string } {
  const hash = window.location.hash.replace(/^#/, '')
  if (!hash || hash === '/') return { view: 'home' }
  if (hash === '/record') return { view: 'record' }
  if (hash.startsWith('/recordings/')) {
    const id = hash.split('/')[2]
    if (id) return { view: 'detail', id }
  }
  return { view: 'home' }
}

function navigate(path: string) {
  window.location.hash = path
}

function CoverRail({ title, items }: { title: string; items: Memory[] }) {
  const railId = `rail-${title.toLowerCase().replace(/\s+/g, '-')}`

  function scrollNext() {
    const rail = document.getElementById(railId)
    if (!rail) return
    rail.scrollBy({ left: rail.clientWidth * 0.8, behavior: 'smooth' })
  }

  return (
    <section className="rail-section">
      <h2 className="rail-title">{title}</h2>
      <div className="cover-rail-wrap">
        <div id={railId} className="cover-rail spring-scroll">
          {items.map((item) => (
            <button key={item.id} className="cover-card" onClick={() => navigate(`/recordings/${item.id}`)}>
              {item.cover_path ? (
                <img src={toAssetUrl(`/covers/${item.id}.svg`)} alt={item.title} className="cover-image" />
              ) : (
                <div className="cover-image placeholder">No cover yet</div>
              )}
              <span>{item.title}</span>
            </button>
          ))}
        </div>
        <button type="button" className="rail-next" onClick={scrollNext} aria-label={`Scroll ${title}`}>
          &#8250;
        </button>
      </div>
    </section>
  )
}

export default function App() {
  const [route, setRoute] = useState(parseHash())
  const [title, setTitle] = useState('')
  const [recordedBlob, setRecordedBlob] = useState<Blob | null>(null)
  const [memories, setMemories] = useState<Memory[]>([])
  const [loading, setLoading] = useState(true)
  const [status, setStatus] = useState('')
  const [error, setError] = useState('')
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState<'all' | 'covers' | 'stories'>('all')
  const [searchExpanded, setSearchExpanded] = useState(false)

  async function loadMemories() {
    setLoading(true)
    setError('')
    try {
      const data = await listMemories()
      setMemories(data)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load memories')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void loadMemories()
  }, [])

  useEffect(() => {
    const onHash = () => setRoute(parseHash())
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  useEffect(() => {
    if (route.view !== 'home' && searchExpanded) setSearchExpanded(false)
  }, [route.view, searchExpanded])

  useEffect(() => {
    const animated = new WeakSet<Element>()

    const triggerBounce = (el: HTMLElement, axis: 'x' | 'y', direction: 1 | -1) => {
      if (animated.has(el)) return
      animated.add(el)

      const offset = direction * 22
      const frames =
        axis === 'x'
          ? [{ transform: 'translateX(0)' }, { transform: `translateX(${offset}px)` }, { transform: 'translateX(0)' }]
          : [{ transform: 'translateY(0)' }, { transform: `translateY(${offset}px)` }, { transform: 'translateY(0)' }]

      const anim = el.animate(frames, {
        duration: 420,
        easing: 'cubic-bezier(0.18, 0.85, 0.28, 1)',
      })
      anim.onfinish = () => animated.delete(el)
      anim.oncancel = () => animated.delete(el)
    }

    const onWheel = (ev: WheelEvent) => {
      const target = ev.currentTarget as HTMLElement
      const hasX = target.scrollWidth > target.clientWidth + 2
      const hasY = target.scrollHeight > target.clientHeight + 2

      if (hasX) {
        const delta = Math.abs(ev.deltaX) > Math.abs(ev.deltaY) ? ev.deltaX : ev.deltaY
        const atStart = target.scrollLeft <= 1
        const atEnd = target.scrollLeft + target.clientWidth >= target.scrollWidth - 1
        if (delta < 0 && atStart) triggerBounce(target, 'x', 1)
        if (delta > 0 && atEnd) triggerBounce(target, 'x', -1)
      }

      if (hasY) {
        const atTop = target.scrollTop <= 1
        const atBottom = target.scrollTop + target.clientHeight >= target.scrollHeight - 1
        if (ev.deltaY < 0 && atTop) triggerBounce(target, 'y', 1)
        if (ev.deltaY > 0 && atBottom) triggerBounce(target, 'y', -1)
      }
    }

    const scrollers = Array.from(document.querySelectorAll<HTMLElement>('.spring-scroll'))
    scrollers.forEach((el) => el.addEventListener('wheel', onWheel, { passive: true }))

    return () => {
      scrollers.forEach((el) => el.removeEventListener('wheel', onWheel))
    }
  }, [route.view, searchExpanded])

  const canUpload = useMemo(() => !!recordedBlob, [recordedBlob])

  const searchResults = useMemo(() => {
    const q = search.trim().toLowerCase()
    return memories.filter((item) => {
      if (filter === 'covers' && !item.cover_path) return false
      if (filter === 'stories' && !item.story_short) return false
      if (!q) return true
      return item.title.toLowerCase().includes(q) || item.story_short.toLowerCase().includes(q)
    })
  }, [memories, search, filter])

  const recommended = useMemo(
    () => memories.filter((m) => m.cover_path && m.story_short).slice(0, 8),
    [memories],
  )

  const recent = useMemo(
    () => [...memories].sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, 8),
    [memories],
  )

  async function onUpload() {
    if (!recordedBlob) return
    setStatus('Uploading recording...')
    setError('')
    try {
      const created = await createMemory(recordedBlob, title || `Memory ${new Date().toLocaleDateString()}`)
      setStatus('Transcribing with ElevenLabs...')
      await transcribeMemory(created.id)
      setStatus('Building story with RAG context...')
      await generateStory(created.id, 'Create a warm family storybook chapter based on this memory.')
      setStatus('Designing story cover...')
      await generateCover(created.id, 'Storybook cover with warm, nostalgic family tones')
      setRecordedBlob(null)
      setTitle('')
      await loadMemories()
      setStatus('Memory fully processed: transcript, story, and cover are ready.')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Processing failed')
    }
  }

  const detailItem = route.view === 'detail' ? memories.find((m) => m.id === route.id) : undefined
  const wallId = 'cover-wall-strip'

  function scrollWallNext() {
    const rail = document.getElementById(wallId)
    if (!rail) return
    rail.scrollBy({ left: rail.clientWidth * 0.9, behavior: 'smooth' })
  }

  return (
    <main className="page app-shell">
      <header className="hero">
        <h1>Virasat.ai</h1>
      </header>

      {route.view === 'home' ? (
        <div className="view-shell">
          <CoverRail title="Recommended Stories" items={recommended} />
          <CoverRail title="Recent Stories" items={recent} />

          <section className="panel">
            <div className="section-head">
              <h2>Cover Wall</h2>
              <a href={`${API_BASE}/api/health`} target="_blank" rel="noreferrer">API status</a>
            </div>
            {loading ? <p className="meta">Loading memories...</p> : null}
            {!loading && memories.length === 0 ? <p className="meta">No stories yet.</p> : null}
            <div className="cover-wall-wrap">
              <div id={wallId} className="cover-wall spring-scroll">
                {memories.map((item) => (
                  <button key={item.id} className="cover-wall-item" onClick={() => navigate(`/recordings/${item.id}`)}>
                    {item.cover_path ? (
                      <img src={toAssetUrl(`/covers/${item.id}.svg`)} alt={item.title} className="cover-image" />
                    ) : (
                      <div className="cover-image placeholder">No cover</div>
                    )}
                    <span>{item.title}</span>
                  </button>
                ))}
              </div>
              <button type="button" className="rail-next rail-next-wall" onClick={scrollWallNext} aria-label="Scroll cover wall">
                &#8250;
              </button>
            </div>
          </section>
        </div>
      ) : null}

      {route.view === 'record' ? (
        <div className="view-shell">
          <section className="panel recorder-panel">
            <div>
              <h2>Record a New Memory</h2>
              <p>Save once and we automatically generate transcript, story, and cover.</p>
            </div>
            <Recorder onReady={(blob) => setRecordedBlob(blob)} />
            <div className="upload-row">
              <input
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                className="title-input"
                placeholder="Memory title (optional)"
              />
              <button className="btn btn-primary" disabled={!canUpload} onClick={onUpload}>Save and Generate</button>
            </div>
            {recordedBlob ? <p className="recorder-status">Recording ready: {(recordedBlob.size / 1024).toFixed(1)} KB</p> : null}
            {status ? <p className="status-text">{status}</p> : null}
            {error ? <p className="error-text">{error}</p> : null}
          </section>

          <section className="panel">
            <h2>Recent Recordings</h2>
            <p className="meta">Placeholder list until full recording detail pages are built.</p>
            <div className="record-list">
              {memories.slice(0, 10).map((item) => (
                <button key={item.id} className="record-item" onClick={() => navigate(`/recordings/${item.id}`)}>
                  <strong>{item.title}</strong>
                  <span className="meta">{new Date(item.created_at).toLocaleString()}</span>
                </button>
              ))}
            </div>
          </section>
        </div>
      ) : null}

      {route.view === 'detail' ? (
        <div className="view-shell">
          <section className="panel">
            <h2>Recording Page (Placeholder)</h2>
            {detailItem ? (
              <>
                <p><strong>{detailItem.title}</strong></p>
                <p className="meta">This is a placeholder. Next step: dedicated recording page with transcript sections, playback, and story variants.</p>
              </>
            ) : (
              <p className="meta">Recording not found.</p>
            )}
            <button className="btn btn-primary" onClick={() => navigate('/')}>Back Home</button>
          </section>
        </div>
      ) : null}

      {searchExpanded && route.view === 'home' ? (
        <button className="search-backdrop" aria-label="Close search" onClick={() => setSearchExpanded(false)} />
      ) : null}

      <div className="bottom-bar">
        <nav className="bottom-nav">
          <span className={`nav-indicator ${route.view === 'record' ? 'is-record' : 'is-home'}`} />
          <button className={route.view === 'home' ? 'active' : ''} onClick={() => navigate('/')}>Home</button>
          <button className={route.view === 'record' ? 'active' : ''} onClick={() => navigate('/record')}>Record</button>
        </nav>
        <button
          className={`search-trigger ${searchExpanded ? 'active' : ''}`}
          onClick={() => route.view === 'home' && setSearchExpanded((prev) => !prev)}
          aria-label="Open search and filters"
          disabled={route.view !== 'home'}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true" className="search-icon">
            <circle cx="11" cy="11" r="6.5" fill="none" stroke="currentColor" strokeWidth="2" />
            <path d="M16 16 L21 21" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
        </button>
      </div>

      {searchExpanded && route.view === 'home' ? (
        <section className="search-island panel">
          <div className="search-results spring-scroll">
            {searchResults.length === 0 ? <p className="meta">No search results.</p> : null}
            {searchResults.map((item) => (
              <button
                key={item.id}
                className="search-result-item"
                onClick={() => {
                  setSearchExpanded(false)
                  navigate(`/recordings/${item.id}`)
                }}
              >
                {item.cover_path ? (
                  <img src={toAssetUrl(`/covers/${item.id}.svg`)} alt={item.title} className="search-result-cover" />
                ) : (
                  <div className="search-result-cover placeholder">No cover</div>
                )}
                <div>
                  <strong>{item.title}</strong>
                  <p className="meta">{item.story_short || 'No story summary yet.'}</p>
                </div>
              </button>
            ))}
          </div>
          <div className="actions search-filters">
            <button className={`chip ${filter === 'all' ? 'chip-active' : ''}`} onClick={() => setFilter('all')}>All</button>
            <button className={`chip ${filter === 'covers' ? 'chip-active' : ''}`} onClick={() => setFilter('covers')}>Has Cover</button>
            <button className={`chip ${filter === 'stories' ? 'chip-active' : ''}`} onClick={() => setFilter('stories')}>Has Story</button>
          </div>
          <div className="search-wrap search-bottom">
            <input
              autoFocus
              type="search"
              className="title-input"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search by title or story"
            />
          </div>
        </section>
      ) : null}
    </main>
  )
}
