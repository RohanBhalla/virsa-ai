import { type CSSProperties, type FormEvent, useEffect, useMemo, useRef, useState } from 'react'
import {
  API_BASE,
  createMemory,
  fetchProtectedBlob,
  generateCover,
  generateStory,
  getMe,
  getSpeakers,
  listMemories,
  login,
  logout,
  refreshAuth,
  register,
  searchStories,
  searchStoriesWithAudio,
  setAccessToken,
  toAssetUrl,
  transcribeMemory,
} from './api'
import { Recorder } from './components/Recorder'
import virasatLogo from './assets/virasat-logo.png'
import type { Memory, TranscriptWord, User } from './types'

type View = 'home' | 'record' | 'detail' | 'account'
type AuthMode = 'login' | 'signup'

const ACCESS_TOKEN_KEY = 'virsa_access_token'
const REFRESH_TOKEN_KEY = 'virsa_refresh_token'

function parseHash(): { view: View; id?: string } {
  const hash = window.location.hash.replace(/^#/, '')
  if (!hash || hash === '/') return { view: 'home' }
  if (hash === '/record') return { view: 'record' }
  if (hash === '/account') return { view: 'account' }
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

function hashSeed(input: string): number {
  let hash = 0
  for (let i = 0; i < input.length; i += 1) {
    hash = (hash << 5) - hash + input.charCodeAt(i)
    hash |= 0
  }
  return Math.abs(hash)
}

function userInitials(user: User | null): string {
  if (!user) return 'U'
  const seed = (user.name || user.email || '').trim()
  if (!seed) return 'U'

  const parts = seed
    .replace(/[@._-]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean)

  if (parts.length >= 2) {
    return `${parts[0][0]}${parts[1][0]}`.toUpperCase()
  }
  return parts[0].slice(0, 2).toUpperCase()
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
  const [authMode, setAuthMode] = useState<AuthMode>('login')
  const [authUser, setAuthUser] = useState<User | null>(null)
  const [authReady, setAuthReady] = useState(false)
  const [authLoading, setAuthLoading] = useState(false)
  const [authError, setAuthError] = useState('')
  const [authName, setAuthName] = useState('')
  const [authEmail, setAuthEmail] = useState('')
  const [authPassword, setAuthPassword] = useState('')
  const [refreshToken, setRefreshToken] = useState('')
  const [profileMenuOpen, setProfileMenuOpen] = useState(false)
  const [memories, setMemories] = useState<Memory[]>([])
  const [loading, setLoading] = useState(true)
  const [recordedBlob, setRecordedBlob] = useState<Blob | null>(null)
  const [draftTitle, setDraftTitle] = useState('')
  const [draftSpeaker, setDraftSpeaker] = useState('')
  const [existingSpeakers, setExistingSpeakers] = useState<string[]>([])
  const [speakerSelectValue, setSpeakerSelectValue] = useState<string>('')
  const [recordStatus, setRecordStatus] = useState('')
  const [recordError, setRecordError] = useState('')
  const [isSavingRecord, setIsSavingRecord] = useState(false)
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState<'all' | 'covers' | 'stories'>('all')
  const [searchExpanded, setSearchExpanded] = useState(false)
  const [searchApiResults, setSearchApiResults] = useState<Memory[] | null>(null)
  const [lastSearchQuery, setLastSearchQuery] = useState('')
  const [searchLoading, setSearchLoading] = useState(false)
  const [searchError, setSearchError] = useState('')
  const [voiceRecording, setVoiceRecording] = useState(false)
  const [voiceProcessing, setVoiceProcessing] = useState(false)
  const voiceRecorderRef = useRef<MediaRecorder | null>(null)
  const voiceChunksRef = useRef<Blob[]>([])
  const [playheadSeconds, setPlayheadSeconds] = useState(0)
  const [audioSrc, setAudioSrc] = useState('')
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const lyricLineRefs = useRef<Array<HTMLButtonElement | null>>([])
  const profileMenuRef = useRef<HTMLDivElement | null>(null)

  function persistAuth(accessToken: string, nextRefreshToken: string) {
    localStorage.setItem(ACCESS_TOKEN_KEY, accessToken)
    localStorage.setItem(REFRESH_TOKEN_KEY, nextRefreshToken)
    setRefreshToken(nextRefreshToken)
    setAccessToken(accessToken)
  }

  function clearAuth() {
    localStorage.removeItem(ACCESS_TOKEN_KEY)
    localStorage.removeItem(REFRESH_TOKEN_KEY)
    setAccessToken('')
    setRefreshToken('')
    setAuthUser(null)
  }

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
    const bootstrapAuth = async () => {
      const storedAccess = localStorage.getItem(ACCESS_TOKEN_KEY) || ''
      const storedRefresh = localStorage.getItem(REFRESH_TOKEN_KEY) || ''
      if (!storedAccess || !storedRefresh) {
        setAuthReady(true)
        return
      }

      try {
        setAccessToken(storedAccess)
        setRefreshToken(storedRefresh)
        const me = await getMe()
        setAuthUser(me)
      } catch {
        try {
          const rotated = await refreshAuth(storedRefresh)
          persistAuth(rotated.access_token, rotated.refresh_token)
          const me = await getMe()
          setAuthUser(me)
        } catch {
          clearAuth()
        }
      } finally {
        setAuthReady(true)
      }
    }

    void bootstrapAuth()
  }, [])

  useEffect(() => {
    if (!authUser) {
      setMemories([])
      setLoading(false)
      return
    }
    void loadMemories()
  }, [authUser])

  useEffect(() => {
    const onHash = () => setRoute(parseHash())
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  useEffect(() => {
    if (route.view !== 'home' && searchExpanded) setSearchExpanded(false)
  }, [route.view, searchExpanded])

  useEffect(() => {
    if (!search.trim()) {
      setSearchApiResults(null)
      setLastSearchQuery('')
    }
  }, [search])

  async function runTextSearch() {
    const q = search.trim()
    if (!q) return
    setSearchLoading(true)
    setVoiceProcessing(false)
    setSearchError('')
    try {
      const data = await searchStories(q)
      setSearch(data.query)
      setSearchApiResults(data.items)
      setLastSearchQuery(data.query)
    } catch (err) {
      setSearchError(err instanceof Error ? err.message : 'Search failed')
      setSearchApiResults([])
      setLastSearchQuery(q)
    } finally {
      setSearchLoading(false)
    }
  }

  async function startVoiceSearch() {
    if (voiceRecording) {
      const mr = voiceRecorderRef.current
      if (mr && mr.state !== 'inactive') {
        mr.stop()
      }
      return
    }
    voiceChunksRef.current = []
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const recorder = new MediaRecorder(stream)
      voiceRecorderRef.current = recorder
      recorder.ondataavailable = (e) => {
        if (e.data.size) voiceChunksRef.current.push(e.data)
      }
      recorder.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop())
        setVoiceRecording(false)
        if (voiceChunksRef.current.length === 0) {
          setVoiceProcessing(false)
          return
        }
        const blob = new Blob(voiceChunksRef.current, { type: 'audio/webm' })
        setVoiceProcessing(true)
        setSearchLoading(true)
        setSearchError('')
        try {
          const data = await searchStoriesWithAudio(blob)
          setSearch(data.query)
          setSearchApiResults(data.items)
          setLastSearchQuery(data.query)
        } catch (err) {
          setSearchError(err instanceof Error ? err.message : 'Voice search failed')
        } finally {
          setVoiceProcessing(false)
          setSearchLoading(false)
        }
      }
      recorder.start()
      setVoiceRecording(true)
    } catch (err) {
      setVoiceProcessing(false)
      const domErr = err as DOMException | null
      if (domErr?.name === 'NotAllowedError') {
        setSearchError('Microphone access denied')
      } else if (domErr?.name === 'NotFoundError') {
        setSearchError('No microphone device found')
      } else if (domErr?.name === 'NotSupportedError') {
        setSearchError('Voice search is not supported in this browser')
      } else {
        setSearchError('Unable to start voice recording')
      }
    }
  }

  useEffect(() => {
    setProfileMenuOpen(false)
  }, [route.view])

  useEffect(() => {
    if (!recordedBlob || !authUser) return
    let cancelled = false
    getSpeakers()
      .then((speakers) => {
        if (!cancelled) setExistingSpeakers(speakers)
      })
      .catch(() => {
        if (!cancelled) setExistingSpeakers([])
      })
    return () => {
      cancelled = true
    }
  }, [recordedBlob, authUser])

  useEffect(() => {
    if (!profileMenuOpen) return
    const onMouseDown = (event: MouseEvent) => {
      const target = event.target as Node
      if (profileMenuRef.current && !profileMenuRef.current.contains(target)) {
        setProfileMenuOpen(false)
      }
    }
    document.addEventListener('mousedown', onMouseDown)
    return () => document.removeEventListener('mousedown', onMouseDown)
  }, [profileMenuOpen])

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
      if (filter === 'stories' && !item.ai_summary) return false
      if (!q) return true
      return item.title.toLowerCase().includes(q) || item.ai_summary.toLowerCase().includes(q)
    })
  }, [memories, search, filter])

  const displaySearchResults = useMemo(() => {
    if (searchApiResults !== null && lastSearchQuery) {
      return searchApiResults.filter((item) => {
        if (filter === 'covers' && !item.cover_path) return false
        if (filter === 'stories' && !item.ai_summary) return false
        return true
      })
    }
    return searchResults
  }, [searchApiResults, lastSearchQuery, filter, searchResults])

  const recommended = useMemo(
    () => memories.filter((m) => m.cover_path && m.ai_summary).slice(0, 8),
    [memories],
  )

  const recent = useMemo(
    () => [...memories].sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, 8),
    [memories],
  )
  const currentSpeakerName =
    speakerSelectValue === '__new__' ? draftSpeaker.trim() : (speakerSelectValue || '')
  const canSaveRecording =
    !!recordedBlob && !!draftTitle.trim() && !!currentSpeakerName && !isSavingRecord

  const detailItem = route.view === 'detail' ? memories.find((m) => m.id === route.id) : undefined
  const lyricLines = useMemo(() => buildLyricLines(detailItem?.transcript_timing || []), [detailItem?.transcript_timing])
  const activeLyricIndex = useMemo(() => findActiveLineIndex(lyricLines, playheadSeconds), [lyricLines, playheadSeconds])
  const profileInitials = useMemo(() => userInitials(authUser), [authUser])
  const profileAvatarStyle = useMemo(() => {
    const palette = ['#9d5f13', '#8f3c24', '#7a4c9f', '#2c6f86', '#7a2f56', '#5e6a2f']
    const key = `${authUser?.id || ''}:${profileInitials}`
    const bg = palette[hashSeed(key) % palette.length]
    return { '--avatar-bg': bg } as CSSProperties
  }, [authUser?.id, profileInitials])
  const voiceButtonLabel = voiceRecording ? 'Stop' : voiceProcessing ? 'Listening...' : 'Voice'
  const voiceButtonHint = voiceRecording
    ? 'Tap to stop recording'
    : voiceProcessing
      ? 'Transcribing audio'
      : 'Tap to speak your search'
  const wallId = 'cover-wall-strip'

  useEffect(() => {
    lyricLineRefs.current = []
    setPlayheadSeconds(0)
  }, [detailItem?.id])

  useEffect(() => {
    let cancelled = false
    let objectUrl = ''

    const loadAudio = async () => {
      if (!detailItem?.audio_path || route.view !== 'detail') {
        setAudioSrc('')
        return
      }
      try {
        const blob = await fetchProtectedBlob(detailItem.audio_path)
        if (cancelled) return
        objectUrl = URL.createObjectURL(blob)
        setAudioSrc(objectUrl)
      } catch {
        if (!cancelled) setAudioSrc('')
      }
    }

    void loadAudio()
    return () => {
      cancelled = true
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [detailItem?.audio_path, route.view])

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

  async function submitAuthForm(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setAuthLoading(true)
    setAuthError('')

    try {
      const cleanEmail = authEmail.trim().toLowerCase()
      const cleanPassword = authPassword
      const cleanName = authName.trim()

      const result =
        authMode === 'signup'
          ? await register(cleanEmail, cleanPassword, cleanName)
          : await login(cleanEmail, cleanPassword)

      persistAuth(result.access_token, result.refresh_token)
      setAuthUser(result.user)
      setAuthPassword('')
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : 'Authentication failed')
    } finally {
      setAuthLoading(false)
    }
  }

  async function handleLogout() {
    try {
      if (refreshToken) await logout(refreshToken)
    } catch {
      // Ignore network errors while clearing local session.
    }
    clearAuth()
  }

  async function saveRecordedMemory() {
    if (!recordedBlob || !draftTitle.trim() || !currentSpeakerName) return

    setIsSavingRecord(true)
    setRecordError('')

    try {
      setRecordStatus('Saving recording...')
      const created = await createMemory(recordedBlob, draftTitle.trim(), currentSpeakerName)

      setRecordStatus('Transcribing with ElevenLabs...')
      await transcribeMemory(created.id)

      setRecordStatus('Building story variants with AI agent...')
      await generateStory(created.id, 'Create a warm family storybook chapter based on this memory.')

      setRecordStatus('Designing story cover...')
      await generateCover(created.id, 'Storybook cover with warm, nostalgic family tones')

      await loadMemories()
      setRecordStatus('Saved. Transcript and story are ready.')
      setRecordedBlob(null)
      setDraftTitle('')
      setDraftSpeaker('')
      setSpeakerSelectValue('')
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

  if (!authReady) {
    return (
      <main className="page auth-page">
        <section className="auth-card panel">
          <p className="meta">Checking session...</p>
        </section>
      </main>
    )
  }

  if (!authUser) {
    const isSignup = authMode === 'signup'
    const canSubmit =
      !!authEmail.trim() &&
      authPassword.length >= 10 &&
      (!isSignup || !!authName.trim()) &&
      !authLoading

    return (
      <main className="page auth-page">
        <header className="auth-topbar">
          <div className="auth-brand">V</div>
          <div className="auth-toggle-pill" role="tablist" aria-label="Auth mode">
            <button
              type="button"
              className={authMode === 'signup' ? 'active' : ''}
              onClick={() => {
                setAuthMode('signup')
                setAuthError('')
              }}
            >
              Sign up
            </button>
            <button
              type="button"
              className={authMode === 'login' ? 'active' : ''}
              onClick={() => {
                setAuthMode('login')
                setAuthError('')
              }}
            >
              Log in
            </button>
          </div>
        </header>

        <section className="auth-card panel">
          <h1 className="auth-title">{isSignup ? 'Sign up to begin' : 'Welcome back'}</h1>
          <p className="auth-subtitle">Preserve family stories with secure account access.</p>

          <form className="auth-form" onSubmit={submitAuthForm}>
            {isSignup ? (
              <input
                type="text"
                className="title-input auth-input"
                placeholder="Full name"
                value={authName}
                onChange={(e) => setAuthName(e.target.value)}
                autoComplete="name"
              />
            ) : null}
            <input
              type="email"
              className="title-input auth-input"
              placeholder="Email"
              value={authEmail}
              onChange={(e) => setAuthEmail(e.target.value)}
              autoComplete="email"
            />
            <input
              type="password"
              className="title-input auth-input"
              placeholder="Password"
              value={authPassword}
              onChange={(e) => setAuthPassword(e.target.value)}
              autoComplete={isSignup ? 'new-password' : 'current-password'}
            />
            <button type="submit" className="auth-submit" disabled={!canSubmit}>
              {authLoading ? 'Please wait...' : isSignup ? 'Create account' : 'Log in'}
            </button>
          </form>

          <p className="meta auth-note">Password must be at least 10 characters.</p>
          {authError ? <p className="error-text">{authError}</p> : null}
        </section>
      </main>
    )
  }

  return (
      <main className="page app-shell">
        <header className="hero">
          <div className="hero-row">
	          <button type="button" className="hero-brand hero-home-btn" onClick={() => navigate('/')}>
	            {/* <span className="hero-logo-circle">
	              <img src={virasatLogo} alt="Virasat logo" className="hero-logo-image" />
	            </span> */}
	            <h1>Virasat.ai</h1>
	          </button>
          <div className="profile-menu-wrap" ref={profileMenuRef}>
            <button
              type="button"
              className="profile-avatar-btn"
              aria-label="Open account menu"
              onClick={() => setProfileMenuOpen((prev) => !prev)}
              style={profileAvatarStyle}
            >
              {profileInitials}
            </button>
            {profileMenuOpen ? (
              <div className="profile-menu-card" role="menu" aria-label="Account menu">
                <div className="profile-menu-greeting">
                  <span>Hello,</span>
                  <strong>{authUser.name || authUser.email}</strong>
                </div>
                <button
                  type="button"
                  className="profile-menu-item"
                  onClick={() => {
                    setProfileMenuOpen(false)
                    navigate('/account')
                  }}
                >
                  Account
                </button>
                <button
                  type="button"
                  className="profile-menu-item danger"
                  onClick={() => {
                    setProfileMenuOpen(false)
                    void handleLogout()
                  }}
                >
                  Logout
                </button>
              </div>
            ) : null}
          </div>
        </div>
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
                  <div className="speaker-field">
                    <select
                      className="title-input speaker-select"
                      value={speakerSelectValue}
                      onChange={(e) => setSpeakerSelectValue(e.target.value)}
                      aria-label="Select speaker"
                    >
                      <option value="">Select speaker...</option>
                      {existingSpeakers.map((name) => (
                        <option key={name} value={name}>
                          {name}
                        </option>
                      ))}
                      <option value="__new__">Add new speaker</option>
                    </select>
                    {speakerSelectValue === '__new__' ? (
                      <input
                        type="text"
                        className="title-input speaker-input"
                        placeholder="New speaker name"
                        value={draftSpeaker}
                        onChange={(e) => setDraftSpeaker(e.target.value)}
                        aria-label="New speaker name"
                      />
                    ) : null}
                  </div>
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
                  <h3>Book-Style AI Summary</h3>
                  <p className="detail-summary">
                    {detailItem.ai_summary || 'AI summary not generated yet.'}
                  </p>
                </section>

                <section className="detail-block">
                  <h3>Children's Version</h3>
                  <p className="detail-summary">
                    {detailItem.story_children || 'Children version not generated yet.'}
                  </p>
                </section>

                <section className="detail-block">
                  <h3>Documentary Narration</h3>
                  <p className="detail-summary">
                    {detailItem.story_narration || 'Narration version not generated yet.'}
                  </p>
                </section>

                <section className="detail-block">
                  <h3>Play Audio</h3>
                  <audio
                    ref={audioRef}
                    className="detail-audio"
                    controls
                    preload="metadata"
                    src={audioSrc}
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

      {route.view === 'account' ? (
        <div className="view-shell">
          <section className="panel account-panel">
            <h2>Account</h2>
            <div className="account-row">
              <span>Name</span>
              <strong>{authUser.name || 'Not set'}</strong>
            </div>
            <div className="account-row">
              <span>Email</span>
              <strong>{authUser.email}</strong>
            </div>
            <button type="button" className="record-save-button account-logout-btn" onClick={() => void handleLogout()}>
              Logout
            </button>
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
            {searchLoading ? <p className="meta">Searching...</p> : null}
            {searchError ? <p className="error-text">{searchError}</p> : null}
            {!searchLoading && !searchError && displaySearchResults.length === 0 ? (
              <p className="meta">No search results.</p>
            ) : null}
            {!searchLoading &&
              displaySearchResults.map((item) => (
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
                    <p className="meta">{item.ai_summary || 'No story summary yet.'}</p>
                  </div>
                </button>
              ))}
          </div>
          <div className="actions search-filters">
            <button className={`chip ${filter === 'all' ? 'chip-active' : ''}`} onClick={() => setFilter('all')}>
              All
            </button>
            <button className={`chip ${filter === 'covers' ? 'chip-active' : ''}`} onClick={() => setFilter('covers')}>
              Has Cover
            </button>
            <button className={`chip ${filter === 'stories' ? 'chip-active' : ''}`} onClick={() => setFilter('stories')}>
              Has Story
            </button>
          </div>
          <div className="search-wrap search-bottom">
            <input
              autoFocus
              type="search"
              className="title-input"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  void runTextSearch()
                }
              }}
              placeholder="Search by title or story (or use voice)"
            />
            <button
              type="button"
              className={`voice-search-btn ${voiceRecording ? 'recording' : ''} ${voiceProcessing ? 'processing' : ''}`}
              onClick={() => void startVoiceSearch()}
              disabled={voiceProcessing}
              aria-label={voiceRecording ? 'Stop recording' : 'Voice search'}
              title={voiceButtonHint}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true" className="voice-icon">
                <path
                  fill="currentColor"
                  d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm5.91-3c-.49 0-.9.36-.98.85C16.52 14.2 14.47 16 12 16s-4.52-1.8-4.93-4.15c-.08-.49-.49-.85-.98-.85-.61 0-1.09.54-1 1.14.49 3 2.89 5.35 5.91 5.35s5.42-2.35 5.91-5.35c.1-.6-.39-1.14-1-1.14z"
                />
              </svg>
              <span className="voice-search-label">{voiceButtonLabel}</span>
            </button>
            <button type="button" className="search-submit-btn" onClick={() => void runTextSearch()} disabled={searchLoading || !search.trim()}>
              Search
            </button>
          </div>
        </section>
      ) : null}
    </main>
  )
}
