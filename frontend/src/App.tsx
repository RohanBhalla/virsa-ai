import { useEffect, useMemo, useRef, useState } from 'react'
import { API_BASE, createMemory, generateCover, generateStory, listMemories, toAssetUrl, transcribeMemory } from './api'
import { Recorder } from './components/Recorder'
import type { Memory, TranscriptWord } from './types'

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

function animateScrollByX(el: HTMLElement, distance: number, duration = 420) {
  const start = el.scrollLeft
  const target = start + distance
  const startTime = performance.now()

  const easeInOut = (t: number) =>
    t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2

  const tick = (now: number) => {
    const elapsed = now - startTime
    const progress = Math.min(1, elapsed / duration)
    const eased = easeInOut(progress)
    el.scrollLeft = start + (target - start) * eased
    if (progress < 1) requestAnimationFrame(tick)
  }

  requestAnimationFrame(tick)
}

type LyricLine = {
  text: string
  start: number
  end: number
}

const NO_SPACE_BEFORE_RE = /^[.,!?;:%)\]}]/
const NO_SPACE_AFTER_RE = /^[([{]$/

function joinTranscriptTokens(tokens: string[]): string {
  if (tokens.length === 0) return ''
  let text = ''
  for (const token of tokens) {
    const cleaned = token.trim()
    if (!cleaned) continue

    if (!text) {
      text = cleaned
      continue
    }

    const prevChar = text.slice(-1)
    if (NO_SPACE_BEFORE_RE.test(cleaned) || NO_SPACE_AFTER_RE.test(prevChar)) {
      text += cleaned
    } else {
      text += ` ${cleaned}`
    }
  }
  return text.trim()
}

function buildLyricLines(words: TranscriptWord[]): LyricLine[] {
  if (words.length === 0) return []

  const lines: LyricLine[] = []
  let lineWords: TranscriptWord[] = []

  const pushLine = () => {
    if (lineWords.length === 0) return
    const text = joinTranscriptTokens(lineWords.map((word) => word.text))
    if (text) {
      lines.push({
        text,
        start: lineWords[0].start,
        end: lineWords[lineWords.length - 1].end,
      })
    }
    lineWords = []
  }

  for (let i = 0; i < words.length; i += 1) {
    const word = words[i]
    const prev = lineWords[lineWords.length - 1]
    const gap = prev ? word.start - prev.end : 0
    const shouldBreakBeforeWord = lineWords.length >= 1 && (gap > 1.2 || lineWords.length >= 12)
    if (shouldBreakBeforeWord) pushLine()

    lineWords.push(word)

    const punctuationBreak = /[.!?]$/.test(word.text)
    if (punctuationBreak && lineWords.length >= 6) pushLine()
  }

  pushLine()
  return lines
}

function findActiveLineIndex(lines: LyricLine[], currentTime: number): number {
  if (lines.length === 0) return -1

  let lo = 0
  let hi = lines.length - 1
  let best = -1
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2)
    if (lines[mid].start <= currentTime) {
      best = mid
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  if (best < 0) return 0
  return best
}

function formatTime(seconds: number): string {
  const mins = Math.floor(seconds / 60)
  const secs = Math.floor(seconds % 60)
  return `${mins}:${secs.toString().padStart(2, '0')}`
}

function CoverRail({ title, items }: { title: string; items: Memory[] }) {
  const railId = `rail-${title.toLowerCase().replace(/\s+/g, '-')}`

  function scrollNext() {
    const rail = document.getElementById(railId)
    if (!rail) return
    animateScrollByX(rail, rail.clientWidth * 0.8)
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
  const [memories, setMemories] = useState<Memory[]>([])
  const [loading, setLoading] = useState(true)
  const [recordedBlob, setRecordedBlob] = useState<Blob | null>(null)
  const [draftTitle, setDraftTitle] = useState('')
  const [draftSpeaker, setDraftSpeaker] = useState('')
  const [recordStatus, setRecordStatus] = useState('')
  const [recordError, setRecordError] = useState('')
  const [isSavingRecord, setIsSavingRecord] = useState(false)
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState<'all' | 'covers' | 'stories'>('all')
  const [searchExpanded, setSearchExpanded] = useState(false)
  const [playheadSeconds, setPlayheadSeconds] = useState(0)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const lyricLineRefs = useRef<Array<HTMLButtonElement | null>>([])

  async function loadMemories() {
    setLoading(true)
    try {
      const data = await listMemories()
      setMemories(data)
    } catch {
      // Keep the home view quiet for now; we'll add richer error states in a later step.
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
  const canSaveRecording = !!recordedBlob && !!draftTitle.trim() && !!draftSpeaker.trim() && !isSavingRecord

  const detailItem = route.view === 'detail' ? memories.find((m) => m.id === route.id) : undefined
  const lyricLines = useMemo(() => buildLyricLines(detailItem?.transcript_timing || []), [detailItem?.transcript_timing])
  const activeLyricIndex = useMemo(() => findActiveLineIndex(lyricLines, playheadSeconds), [lyricLines, playheadSeconds])
  const wallId = 'cover-wall-strip'

  useEffect(() => {
    lyricLineRefs.current = []
    setPlayheadSeconds(0)
  }, [detailItem?.id])

  useEffect(() => {
    if (route.view !== 'detail' || activeLyricIndex < 0) return
    const el = lyricLineRefs.current[activeLyricIndex]
    if (!el) return
    el.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }, [activeLyricIndex, route.view])

  function scrollWallNext() {
    const rail = document.getElementById(wallId)
    if (!rail) return
    animateScrollByX(rail, rail.clientWidth * 0.9)
  }

  async function saveRecordedMemory() {
    if (!recordedBlob || !draftTitle.trim() || !draftSpeaker.trim()) return

    setIsSavingRecord(true)
    setRecordError('')

    try {
      setRecordStatus('Saving recording...')
      const created = await createMemory(recordedBlob, draftTitle.trim(), draftSpeaker.trim())

      setRecordStatus('Transcribing with ElevenLabs...')
      await transcribeMemory(created.id)

      setRecordStatus('Building story with RAG context...')
      await generateStory(created.id, 'Create a warm family storybook chapter based on this memory.')

      setRecordStatus('Designing story cover...')
      await generateCover(created.id, 'Storybook cover with warm, nostalgic family tones')

      await loadMemories()
      setRecordStatus('Saved. Transcript and story are ready.')
      setRecordedBlob(null)
      setDraftTitle('')
      setDraftSpeaker('')
    } catch (err) {
      setRecordError(err instanceof Error ? err.message : 'Failed to save recording')
    } finally {
      setIsSavingRecord(false)
    }
  }

  function seekToLyric(seconds: number) {
    const audio = audioRef.current
    if (!audio) return
    audio.currentTime = seconds
    setPlayheadSeconds(seconds)
    void audio.play().catch(() => {
      // Ignore autoplay constraints if the browser blocks programmatic playback.
    })
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
        <div className="view-shell record-view">
          <section className="panel recorder-panel">
            <Recorder
              onReady={(blob) => {
                setRecordedBlob(blob)
                setRecordError('')
                setRecordStatus('')
              }}
            />
            {recordedBlob ? (
              <div className="record-form">
                <div className="record-form-fields">
                  <input
                    type="text"
                    className="title-input"
                    placeholder="Memory title"
                    value={draftTitle}
                    onChange={(e) => setDraftTitle(e.target.value)}
                  />
                  <input
                    type="text"
                    className="title-input"
                    placeholder="Speaker tag"
                    value={draftSpeaker}
                    onChange={(e) => setDraftSpeaker(e.target.value)}
                  />
                </div>
                <div className="record-form-actions">
                  <button type="button" className="record-save-button" disabled={!canSaveRecording} onClick={saveRecordedMemory}>
                    {isSavingRecord ? 'Saving...' : 'Save'}
                  </button>
                </div>
                {recordStatus ? <p className="status-text">{recordStatus}</p> : null}
                {recordError ? <p className="error-text">{recordError}</p> : null}
              </div>
            ) : null}
          </section>
        </div>
      ) : null}

      {route.view === 'detail' ? (
        <div className="view-shell">
          <section className="panel recording-detail">
            {detailItem ? (
              <>
                <div className="detail-head">
                  <h2>{detailItem.title}</h2>
                  <p className="meta">{new Date(detailItem.created_at).toLocaleString()}</p>
                </div>

                <section className="detail-block">
                  <h3>Cover Photo</h3>
                  {detailItem.cover_path ? (
                    <img
                      src={toAssetUrl(`/covers/${detailItem.id}.svg`)}
                      alt={`${detailItem.title} cover`}
                      className="detail-cover"
                    />
                  ) : (
                    <div className="detail-cover placeholder">Cover photo not available yet.</div>
                  )}
                </section>

                <section className="detail-block">
                  <h3>AI Story Summary</h3>
                  <p className="detail-summary">
                    {detailItem.story_short || detailItem.story_long || 'AI summary not generated yet.'}
                  </p>
                </section>

                <section className="detail-block">
                  <h3>Play Audio</h3>
                  <audio
                    ref={audioRef}
                    className="detail-audio"
                    controls
                    preload="metadata"
                    src={toAssetUrl(detailItem.audio_path)}
                    onTimeUpdate={(event) => setPlayheadSeconds(event.currentTarget.currentTime)}
                    onSeeked={(event) => setPlayheadSeconds(event.currentTarget.currentTime)}
                    onLoadedMetadata={(event) => setPlayheadSeconds(event.currentTarget.currentTime)}
                  >
                    Your browser does not support the audio element.
                  </audio>
                </section>

                <section className="detail-block">
                  <h3>Live Transcript</h3>
                  {lyricLines.length > 0 ? (
                    <div className="lyrics-panel spring-scroll">
                      {lyricLines.map((line, idx) => (
                        <button
                          key={`${line.start}-${idx}`}
                          ref={(element) => {
                            lyricLineRefs.current[idx] = element
                          }}
                          type="button"
                          className={`lyric-line ${idx === activeLyricIndex ? 'lyric-line-active' : ''}`}
                          onClick={() => seekToLyric(line.start)}
                        >
                          <span className="lyric-line-time">{formatTime(line.start)}</span>
                          <span>{line.text}</span>
                        </button>
                      ))}
                    </div>
                  ) : (
                    <p className="detail-transcript-fallback">
                      {detailItem.transcript || 'Transcript not available yet. Save and transcribe this recording first.'}
                    </p>
                  )}
                </section>
              </>
            ) : (
              <p className="meta">Recording not found.</p>
            )}
            <button className="btn btn-primary detail-back" onClick={() => navigate('/')}>Back Home</button>
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
