import { type CSSProperties, type FormEvent, useEffect, useMemo, useRef, useState } from 'react'
import {
  API_BASE,
  addPersonWithEdge,
  createFamilyEdge,
  createMemory,
  deleteFamilyEdge,
  deleteFamilyPerson,
  ensureStoryAudio,
  fetchProtectedBlob,
  geekReplyAs,
  getFamilyTree,
  generateCover,
  generateStory,
  getMe,
  getSpeakers,
  listMemories,
  login,
  logout,
  refreshAuth,
  register,
  createElderRootFamily,
  searchStories,
  searchStoriesWithAudio,
  setAccessToken,
  toAssetUrl,
  transcribeMemory,
  updateFamilyPerson,
} from './api'
import { MemoryMapView } from './components/MemoryMapView'
import { Recorder } from './components/Recorder'
import { FamilyGraphView } from './components/FamilyGraphView'
import virasatLogo from './assets/virasat-logo.png'
import type { FamilySpeaker, FamilyTree, Memory, TranscriptWord, User } from './types'

type View = 'home' | 'record' | 'detail' | 'account' | 'memory-map' | 'family-tree' | 'family-graph'
type AuthMode = 'login' | 'signup'

const ACCESS_TOKEN_KEY = 'virsa_access_token'
const REFRESH_TOKEN_KEY = 'virsa_refresh_token'

function parseHash(): { view: View; id?: string } {
  const hash = window.location.hash.replace(/^#/, '')
  if (!hash || hash === '/') return { view: 'home' }
  if (hash === '/record') return { view: 'record' }
  if (hash === '/memory-map') return { view: 'memory-map' }
  if (hash === '/family-tree') return { view: 'family-tree' }
  if (hash === '/family-graph') return { view: 'family-graph' }
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

function formatMemoryTag(value: string): string {
  return value.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

function animateScrollByX(el: HTMLElement, distance: number) {
  const maxLeft = Math.max(0, el.scrollWidth - el.clientWidth)
  const target = Math.min(maxLeft, Math.max(0, el.scrollLeft + distance))
  el.scrollTo({ left: target, behavior: 'smooth' })
}

function animateRailButtonPress(el: HTMLElement, direction: 'left' | 'right') {
  const shift = direction === 'right' ? 5 : -5
  const base = 'translateY(-50%) translateZ(0)'
  const frames = [
    { transform: `${base} scale(1)` },
    { transform: `translateY(-50%) translateX(${shift}px) translateZ(0) scale(0.92)` },
    { transform: `${base} scale(1)` },
  ]
  el.animate(frames, {
    duration: 220,
    easing: 'cubic-bezier(0.22, 0.9, 0.22, 1)',
  })
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

function trimPreview(text: string, maxChars = 520): string {
  const clean = (text || "").trim().split(/\s+/).join(' ')
  if (!clean) return ''
  if (clean.length <= maxChars) return clean
  return `${clean.slice(0, maxChars - 1).trimEnd()}...`
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
  const railRef = useRef<HTMLDivElement>(null)
  const [showPrev, setShowPrev] = useState(false)

  useEffect(() => {
    const rail = railRef.current
    if (!rail) return

    const updatePrev = () => setShowPrev(rail.scrollLeft > 6)
    updatePrev()
    rail.addEventListener('scroll', updatePrev, { passive: true })
    window.addEventListener('resize', updatePrev)
    return () => {
      rail.removeEventListener('scroll', updatePrev)
      window.removeEventListener('resize', updatePrev)
    }
  }, [items.length])

  function scrollPrev(button: HTMLButtonElement) {
    const rail = railRef.current
    if (!rail) return
    animateRailButtonPress(button, 'left')
    animateScrollByX(rail, -rail.clientWidth * 0.8)
  }

  function scrollNext(button: HTMLButtonElement) {
    const rail = railRef.current
    if (!rail) return
    animateRailButtonPress(button, 'right')
    animateScrollByX(rail, rail.clientWidth * 0.8)
  }

  return (
    <section className="rail-section">
      <h2 className="rail-title">{title}</h2>
      <div className="cover-rail-wrap">
        <div id={railId} ref={railRef} className="cover-rail spring-scroll" data-bounce-axis="y">
          {items.map((item) => (
            <button key={item.id} className="cover-card" onClick={() => navigate(`/recordings/${item.id}`)}>
              {item.cover_path ? (
                <img
                  src={toAssetUrl(`/covers/${item.id}.svg?v=${encodeURIComponent(item.updated_at || '')}`)}
                  alt={item.title}
                  className="cover-image"
                />
              ) : (
                <div className="cover-image placeholder">No cover yet</div>
              )}
              <span>{item.title}</span>
            </button>
          ))}
        </div>
        {showPrev ? (
          <button
            type="button"
            className="rail-next rail-prev"
            onClick={(e) => scrollPrev(e.currentTarget)}
            aria-label={`Scroll ${title} left`}
          >
            &#8249;
          </button>
        ) : null}
        <button type="button" className="rail-next" onClick={(e) => scrollNext(e.currentTarget)} aria-label={`Scroll ${title}`}>
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
  const [existingSpeakers, setExistingSpeakers] = useState<FamilySpeaker[]>([])
  const [selectedSpeakerPersonId, setSelectedSpeakerPersonId] = useState<string>('')
  const [recordStatus, setRecordStatus] = useState('')
  const [recordError, setRecordError] = useState('')
  const [isSavingRecord, setIsSavingRecord] = useState(false)
  const [recordAddOpen, setRecordAddOpen] = useState(false)
  const [recordFamilyTree, setRecordFamilyTree] = useState<FamilyTree | null>(null)
  const [recordFamilyLoading, setRecordFamilyLoading] = useState(false)
  const [recordFamilyError, setRecordFamilyError] = useState('')
  const [recordNewRelativeName, setRecordNewRelativeName] = useState('')
  const [recordRelatedToPersonId, setRecordRelatedToPersonId] = useState('')
  const [recordNewRelationship, setRecordNewRelationship] = useState<'child' | 'parent' | 'partner' | 'sibling'>('child')
  const [recordNewRelationshipType, setRecordNewRelationshipType] = useState<
    'biological' | 'adoptive' | 'step' | 'guardian' | 'unknown'
  >('unknown')
  const [recordNewPartnerType, setRecordNewPartnerType] = useState<
    'married' | 'partner' | 'divorced' | 'separated' | 'unknown'
  >('unknown')
  const [recordNewCertainty, setRecordNewCertainty] = useState<'certain' | 'estimated' | 'unknown'>('unknown')
  const [recordAddingRelative, setRecordAddingRelative] = useState(false)
  const [familyTree, setFamilyTree] = useState<FamilyTree | null>(null)
  const [familyTreeLoading, setFamilyTreeLoading] = useState(false)
  const [familyTreeError, setFamilyTreeError] = useState('')
  const [newRelativeName, setNewRelativeName] = useState('')
  const [relatedToPersonId, setRelatedToPersonId] = useState('')
  const [newRelationship, setNewRelationship] = useState<'child' | 'parent' | 'partner' | 'sibling'>('child')
  const [newRelationshipType, setNewRelationshipType] = useState<
    'biological' | 'adoptive' | 'step' | 'guardian' | 'unknown'
  >('unknown')
  const [newPartnerType, setNewPartnerType] = useState<'married' | 'partner' | 'divorced' | 'separated' | 'unknown'>(
    'unknown'
  )
  const [newCertainty, setNewCertainty] = useState<'certain' | 'estimated' | 'unknown'>('unknown')
  const [addingRelative, setAddingRelative] = useState(false)
  const [editingPersonId, setEditingPersonId] = useState('')
  const [editDisplayName, setEditDisplayName] = useState('')
  const [editGivenName, setEditGivenName] = useState('')
  const [editFamilyName, setEditFamilyName] = useState('')
  const [editSex, setEditSex] = useState<'female' | 'male' | 'other' | 'unknown'>('unknown')
  const [editBirthYear, setEditBirthYear] = useState('')
  const [editDeathYear, setEditDeathYear] = useState('')
  const [editNotes, setEditNotes] = useState('')
  const [editAgeRange, setEditAgeRange] = useState('')
  const [editPreferredLanguage, setEditPreferredLanguage] = useState('')
  const [editHomeRegion, setEditHomeRegion] = useState('')
  const [editConsent, setEditConsent] = useState(false)
  const [savingPersonEdit, setSavingPersonEdit] = useState(false)
  const [deletingPersonId, setDeletingPersonId] = useState('')
  const [deletingEdgeId, setDeletingEdgeId] = useState('')
  const [linkFromPersonId, setLinkFromPersonId] = useState('')
  const [linkToPersonId, setLinkToPersonId] = useState('')
  const [linkKind, setLinkKind] = useState<'parent_child' | 'partner'>('parent_child')
  const [linkRelationshipType, setLinkRelationshipType] = useState<
    'biological' | 'adoptive' | 'step' | 'guardian' | 'unknown'
  >('unknown')
  const [linkPartnerType, setLinkPartnerType] = useState<'married' | 'partner' | 'divorced' | 'separated' | 'unknown'>(
    'unknown'
  )
  const [linkCertainty, setLinkCertainty] = useState<'certain' | 'estimated' | 'unknown'>('unknown')
  const [linkingEdge, setLinkingEdge] = useState(false)
  const [elderModalOpen, setElderModalOpen] = useState(false)
  const [elderSubmitting, setElderSubmitting] = useState(false)
  const [elderSetupError, setElderSetupError] = useState('')
  const [elderDisplayName, setElderDisplayName] = useState('')
  const [elderBirthYear, setElderBirthYear] = useState('')
  const [elderAgeRange, setElderAgeRange] = useState('')
  const [elderPreferredLanguage, setElderPreferredLanguage] = useState('')
  const [elderHomeRegion, setElderHomeRegion] = useState('')
  const [elderConsent, setElderConsent] = useState(false)
  const [familyActionNotice, setFamilyActionNotice] = useState('')
  const [familyActionNoticeKind, setFamilyActionNoticeKind] = useState<'success' | 'error'>('success')
  const [confirmModalOpen, setConfirmModalOpen] = useState(false)
  const [confirmDeleteType, setConfirmDeleteType] = useState<'person' | 'edge' | ''>('')
  const [confirmDeleteId, setConfirmDeleteId] = useState('')
  const [confirmDeleteLabel, setConfirmDeleteLabel] = useState('')
  const [confirmDeleting, setConfirmDeleting] = useState(false)
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
  const [audioDuration, setAudioDuration] = useState(0)
  const [audioPlaying, setAudioPlaying] = useState(false)
  const [audioSrc, setAudioSrc] = useState('')
  const [detailMode, setDetailMode] = useState<'reader' | 'listener' | 'geek'>('reader')
  const [readerVersion, setReaderVersion] = useState<'narration' | 'summary' | 'original' | 'children'>('original')
  const [storyTab, setStoryTab] = useState<'summary' | 'children' | 'narration'>('summary')
  const [storyAudioState, setStoryAudioState] = useState<
    Partial<
      Record<
        'children' | 'narration',
        {
          audio_path: string
          transcript: string
          transcript_timing: TranscriptWord[]
          status: string
          voice_id?: string
        }
      >
    >
  >({})
  const [storyAudioLoading, setStoryAudioLoading] = useState<'' | 'children' | 'narration'>('')
  const [storyAudioError, setStoryAudioError] = useState('')
  const [geekSpeakerPersonId, setGeekSpeakerPersonId] = useState('')
  const [geekQuery, setGeekQuery] = useState('')
  const [geekLoading, setGeekLoading] = useState(false)
  const [geekError, setGeekError] = useState('')
  const [geekReply, setGeekReply] = useState('')
  const [geekRelationshipContext, setGeekRelationshipContext] = useState('')
  const [geekSources, setGeekSources] = useState<Array<{
    memory_id: string
    title: string
    speaker_tag: string
    score: number
    snippet: string
  }>>([])
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const lyricLineRefs = useRef<Array<HTMLButtonElement | null>>([])
  const profileMenuRef = useRef<HTMLDivElement | null>(null)
  const familyId = (authUser?.default_family_id || '').trim()

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

  async function refreshFamilySpeakers() {
    try {
      const speakers = await getSpeakers()
      setExistingSpeakers(speakers)
      setSelectedSpeakerPersonId((prev) =>
        prev && speakers.some((speaker) => speaker.person_id === prev) ? prev : (speakers[0]?.person_id || '')
      )
    } catch {
      setExistingSpeakers([])
      setSelectedSpeakerPersonId('')
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
    if (route.view !== 'family-tree') return
    if (!familyId) {
      setFamilyTree(null)
      setFamilyTreeError('No elder-root family found yet. Set up an elder to start your family tree.')
      return
    }
    let cancelled = false
    setFamilyTreeLoading(true)
    setFamilyTreeError('')
    getFamilyTree(familyId)
      .then((data) => {
        if (cancelled) return
        setFamilyTree(data)
        setRelatedToPersonId((prev) => prev || data.elder_person_id)
        setLinkFromPersonId((prev) => prev || data.elder_person_id)
      })
      .catch((err) => {
        if (cancelled) return
        setFamilyTree(null)
        setFamilyTreeError(err instanceof Error ? err.message : 'Unable to load family tree')
      })
      .finally(() => {
        if (!cancelled) setFamilyTreeLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [route.view, familyId])

  useEffect(() => {
    if (route.view !== 'record') return
    if (!familyId) {
      setRecordFamilyTree(null)
      setRecordFamilyError('No elder-root family found yet. Set up an elder to add speakers.')
      return
    }
    let cancelled = false
    setRecordFamilyLoading(true)
    setRecordFamilyError('')
    getFamilyTree(familyId)
      .then((data) => {
        if (cancelled) return
        setRecordFamilyTree(data)
        setRecordRelatedToPersonId((prev) => prev || data.elder_person_id)
      })
      .catch((err) => {
        if (cancelled) return
        setRecordFamilyTree(null)
        setRecordFamilyError(err instanceof Error ? err.message : 'Unable to load family members')
      })
      .finally(() => {
        if (!cancelled) setRecordFamilyLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [route.view, familyId])

  useEffect(() => {
    if (!search.trim()) {
      setSearchApiResults(null)
      setLastSearchQuery('')
    }
  }, [search])

  useEffect(() => {
    if (!familyActionNotice) return
    const timer = window.setTimeout(() => setFamilyActionNotice(''), 3000)
    return () => window.clearTimeout(timer)
  }, [familyActionNotice])

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
    if (!authUser) {
      setExistingSpeakers([])
      setSelectedSpeakerPersonId('')
      return
    }
    void refreshFamilySpeakers()
  }, [authUser])

  useEffect(() => {
    setGeekSpeakerPersonId((prev) => {
      if (prev && existingSpeakers.some((speaker) => speaker.person_id === prev)) return prev
      if (selectedSpeakerPersonId && existingSpeakers.some((speaker) => speaker.person_id === selectedSpeakerPersonId)) {
        return selectedSpeakerPersonId
      }
      return existingSpeakers[0]?.person_id || ''
    })
  }, [existingSpeakers, selectedSpeakerPersonId])

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

      const bounceAxis = target.dataset.bounceAxis || 'xy'
      const allowXBounce = bounceAxis.includes('x')
      const allowYBounce = bounceAxis.includes('y')

      if (hasX && allowXBounce) {
        const delta = Math.abs(ev.deltaX) > Math.abs(ev.deltaY) ? ev.deltaX : ev.deltaY
        const atStart = target.scrollLeft <= 1
        const atEnd = target.scrollLeft + target.clientWidth >= target.scrollWidth - 1
        if (delta < 0 && atStart) triggerBounce(target, 'x', 1)
        if (delta > 0 && atEnd) triggerBounce(target, 'x', -1)
      }

      if (hasY && allowYBounce) {
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
  const canSaveRecording =
    !!recordedBlob && !!draftTitle.trim() && !!selectedSpeakerPersonId && !isSavingRecord

  const detailItem = route.view === 'detail' ? memories.find((m) => m.id === route.id) : undefined
  const selectedStoryVariant = storyTab === 'children' || storyTab === 'narration' ? storyTab : null
  const selectedStoryAudio =
    selectedStoryVariant
      ? storyAudioState[selectedStoryVariant] || detailItem?.story_audio?.[selectedStoryVariant]
      : null
  const activeTranscriptWords = selectedStoryVariant
    ? selectedStoryAudio?.transcript_timing || []
    : detailItem?.transcript_timing || []
  const activeTranscriptText = selectedStoryVariant
    ? selectedStoryAudio?.transcript || (selectedStoryVariant === 'children' ? detailItem?.story_children : detailItem?.story_narration) || ''
    : detailItem?.transcript || ''
  const activeListenerLabel =
    storyTab === 'summary' ? 'Original Recording' : storyTab === 'children' ? "Children's Narration" : 'Documentary Narration'
  const readerVersionLabel =
    readerVersion === 'narration'
      ? 'Narration Style'
      : readerVersion === 'summary'
        ? 'AI Summary'
        : readerVersion === 'children'
          ? "Children's Version"
          : 'Original Story'
  const readerVersionText =
    readerVersion === 'narration'
      ? detailItem?.story_narration || ''
      : readerVersion === 'summary'
        ? detailItem?.ai_summary || ''
        : readerVersion === 'children'
          ? detailItem?.story_children || ''
          : detailItem?.transcript || ''
  const bookRightTitle =
    detailMode === 'reader' ? readerVersionLabel : detailMode === 'listener' ? `Now Playing: ${activeListenerLabel}` : 'Geek Mode Preview'
  const bookRightBody =
    detailMode === 'reader'
      ? trimPreview(readerVersionText)
      : detailMode === 'listener'
        ? trimPreview(activeTranscriptText || 'Start playback to see synced transcript lines highlighted in listener mode.')
        : 'Placeholder for advanced timeline, model traces, and generation diagnostics.'
  const lyricLines = useMemo(() => buildLyricLines(activeTranscriptWords), [activeTranscriptWords])
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
  const wallRailRef = useRef<HTMLDivElement>(null)
  const [showWallPrev, setShowWallPrev] = useState(false)

  const generationBuckets = useMemo(() => {
    if (!familyTree) return []

    const peopleById = new Map(familyTree.people.map((person) => [person.id, person]))
    const queue: string[] = [familyTree.elder_person_id]
    const levels = new Map<string, number>([[familyTree.elder_person_id, 0]])

    while (queue.length > 0) {
      const current = queue.shift() as string
      const level = levels.get(current) ?? 0
      for (const edge of familyTree.edges) {
        if (edge.kind === 'parent_child') {
          if (edge.from_person_id === current && !levels.has(edge.to_person_id)) {
            levels.set(edge.to_person_id, level + 1)
            queue.push(edge.to_person_id)
          }
          if (edge.to_person_id === current && !levels.has(edge.from_person_id)) {
            levels.set(edge.from_person_id, level - 1)
            queue.push(edge.from_person_id)
          }
        }
        if (edge.kind === 'partner') {
          if (edge.from_person_id === current && !levels.has(edge.to_person_id)) {
            levels.set(edge.to_person_id, level)
            queue.push(edge.to_person_id)
          }
          if (edge.to_person_id === current && !levels.has(edge.from_person_id)) {
            levels.set(edge.from_person_id, level)
            queue.push(edge.from_person_id)
          }
        }
      }
    }

    const bucketMap = new Map<number, Array<{ id: string; level: number }>>()
    for (const person of familyTree.people) {
      const level = levels.get(person.id) ?? 99
      const row = bucketMap.get(level) ?? []
      row.push({ id: person.id, level })
      bucketMap.set(level, row)
    }

    return Array.from(bucketMap.entries())
      .sort((a, b) => a[0] - b[0])
      .map(([level, members]) => ({
        level,
        members: members
          .map(({ id }) => peopleById.get(id))
          .filter((person): person is NonNullable<typeof person> => Boolean(person))
          .sort((a, b) => a.display_name.localeCompare(b.display_name)),
      }))
  }, [familyTree])

  const linkEdgeDuplicate = useMemo(() => {
    if (!familyTree) return false
    const fromId = linkFromPersonId || familyTree.elder_person_id
    const toId = linkToPersonId
    if (!fromId || !toId || fromId === toId) return false

    return familyTree.edges.some((edge) => {
      if (edge.kind !== linkKind) return false
      if (linkKind === 'partner') {
        return (
          (edge.from_person_id === fromId && edge.to_person_id === toId) ||
          (edge.from_person_id === toId && edge.to_person_id === fromId)
        )
      }
      return edge.from_person_id === fromId && edge.to_person_id === toId
    })
  }, [familyTree, linkFromPersonId, linkToPersonId, linkKind])

  useEffect(() => {
    lyricLineRefs.current = []
    setPlayheadSeconds(0)
    setDetailMode('reader')
    setReaderVersion('original')
    setStoryTab('summary')
    setStoryAudioState({})
    setStoryAudioLoading('')
    setStoryAudioError('')
    setGeekQuery('')
    setGeekError('')
    setGeekReply('')
    setGeekRelationshipContext('')
    setGeekSources([])
  }, [detailItem?.id])

  useEffect(() => {
    if (!detailItem || route.view !== 'detail') return
    if (detailMode !== 'listener') return
    if (storyTab !== 'children' && storyTab !== 'narration') return

    const variant = storyTab
    const existing = storyAudioState[variant] || detailItem.story_audio?.[variant]
    if (existing?.audio_path && (existing.transcript_timing?.length || 0) > 0) return

    let cancelled = false
    setStoryAudioLoading(variant)
    setStoryAudioError('')
    ensureStoryAudio(detailItem.id, variant)
      .then((data) => {
        if (cancelled) return
        setStoryAudioState((prev) => ({
          ...prev,
          [variant]: {
            audio_path: data.audio_path,
            transcript: data.transcript,
            transcript_timing: data.transcript_timing,
            status: data.status,
            voice_id: data.voice_id,
          },
        }))
      })
      .catch((err) => {
        if (cancelled) return
        setStoryAudioError(err instanceof Error ? err.message : 'Failed to load AI voice audio')
      })
      .finally(() => {
        if (!cancelled) setStoryAudioLoading('')
      })
    return () => {
      cancelled = true
    }
  }, [detailItem, detailMode, route.view, storyAudioState, storyTab])

  useEffect(() => {
    let cancelled = false
    let objectUrl = ''

    const loadAudio = async () => {
      if (!detailItem || route.view !== 'detail') {
        setAudioSrc('')
        return
      }
      if (detailMode !== 'listener') {
        setAudioSrc('')
        return
      }
      const path =
        storyTab === 'summary' ? detailItem.audio_path : (storyAudioState[storyTab]?.audio_path || detailItem.story_audio?.[storyTab]?.audio_path || '')
      if (!path) {
        setAudioSrc('')
        return
      }
      try {
        const blob = await fetchProtectedBlob(path)
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
  }, [detailItem, detailMode, route.view, storyAudioState, storyTab])

  useEffect(() => {
    if (route.view !== 'detail' || activeLyricIndex < 0) return
    const el = lyricLineRefs.current[activeLyricIndex]
    if (!el) return
    el.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }, [activeLyricIndex, route.view])

  useEffect(() => {
    const audio = audioRef.current
    if (!audio) return
    audio.pause()
    audio.currentTime = 0
    setPlayheadSeconds(0)
    setAudioDuration(0)
    setAudioPlaying(false)
  }, [detailMode, storyTab, detailItem?.id])

  function scrollWallNext(button: HTMLButtonElement) {
    const rail = wallRailRef.current
    if (!rail) return
    animateRailButtonPress(button, 'right')
    animateScrollByX(rail, rail.clientWidth * 0.9)
  }

  function scrollWallPrev(button: HTMLButtonElement) {
    const rail = wallRailRef.current
    if (!rail) return
    animateRailButtonPress(button, 'left')
    animateScrollByX(rail, -rail.clientWidth * 0.9)
  }

  useEffect(() => {
    if (route.view !== 'home') return
    const rail = wallRailRef.current
    if (!rail) return

    const updatePrev = () => setShowWallPrev(rail.scrollLeft > 6)
    updatePrev()
    rail.addEventListener('scroll', updatePrev, { passive: true })
    window.addEventListener('resize', updatePrev)
    return () => {
      rail.removeEventListener('scroll', updatePrev)
      window.removeEventListener('resize', updatePrev)
    }
  }, [route.view, memories.length])

  function openElderSetupModal() {
    setElderSetupError('')
    setElderDisplayName('')
    setElderBirthYear('')
    setElderAgeRange('')
    setElderPreferredLanguage('')
    setElderHomeRegion('')
    setElderConsent(false)
    setElderModalOpen(true)
  }

  async function submitElderSetupForm(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const cleanDisplayName = elderDisplayName.trim()
    if (!cleanDisplayName) {
      setElderSetupError('Elder display name is required.')
      return
    }
    if (!elderConsent) {
      setElderSetupError('Please confirm elder consent to continue.')
      return
    }

    let parsedBirthYear: number | undefined
    const birthYearInput = elderBirthYear.trim()
    if (birthYearInput) {
      const maybeYear = Number(birthYearInput)
      if (!Number.isInteger(maybeYear) || maybeYear < 1800 || maybeYear > 2100) {
        setElderSetupError('Birth year must be between 1800 and 2100.')
        return
      }
      parsedBirthYear = maybeYear
    }

    setElderSubmitting(true)
    setElderSetupError('')
    try {
      await createElderRootFamily({
        display_name: cleanDisplayName,
        birth_year: parsedBirthYear,
        age_range: elderAgeRange.trim(),
        preferred_language: elderPreferredLanguage.trim(),
        home_region: elderHomeRegion.trim(),
        consent: true,
      })
      const me = await getMe()
      setAuthUser(me)
      setElderModalOpen(false)
      setFamilyActionNoticeKind('success')
      setFamilyActionNotice('Elder profile created successfully.')
    } catch (err) {
      setElderSetupError(err instanceof Error ? err.message : 'Failed to set up elder')
    } finally {
      setElderSubmitting(false)
    }
  }

  async function submitAddRelative(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!familyId || !familyTree) return
    const cleanName = newRelativeName.trim()
    const connectTo = relatedToPersonId || familyTree.elder_person_id
    if (!cleanName || !connectTo) return

    setAddingRelative(true)
    setFamilyTreeError('')
    try {
      await addPersonWithEdge(familyId, {
        display_name: cleanName,
        connect_to_person_id: connectTo,
        relationship: newRelationship,
        relationship_type: newRelationshipType,
        partner_type: newPartnerType,
        certainty: newCertainty,
      })
      const updated = await getFamilyTree(familyId)
      setFamilyTree(updated)
      setRelatedToPersonId(updated.elder_person_id)
      setNewRelativeName('')
      setNewRelationship('child')
      setNewRelationshipType('unknown')
      setNewPartnerType('unknown')
      setNewCertainty('unknown')
      setFamilyActionNoticeKind('success')
      setFamilyActionNotice(
        newRelationship === 'sibling'
          ? 'Sibling added. A placeholder parent was created for the sibling link.'
          : 'Relative added successfully.'
      )
    } catch (err) {
      setFamilyTreeError(err instanceof Error ? err.message : 'Failed to add relative')
    } finally {
      setAddingRelative(false)
    }
  }

  function handleRecordRelationshipSelection(nextRelationship: 'child' | 'parent' | 'partner' | 'sibling') {
    setRecordNewRelationship(nextRelationship)
    if (nextRelationship === 'partner') {
      setRecordNewRelationshipType('unknown')
    } else {
      setRecordNewPartnerType('unknown')
    }
  }

  async function submitRecordAddRelative(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!familyId || !recordFamilyTree) return
    const cleanName = recordNewRelativeName.trim()
    const connectTo = recordRelatedToPersonId || recordFamilyTree.elder_person_id
    if (!cleanName || !connectTo) return

    setRecordAddingRelative(true)
    setRecordFamilyError('')
    try {
      const created = await addPersonWithEdge(familyId, {
        display_name: cleanName,
        connect_to_person_id: connectTo,
        relationship: recordNewRelationship,
        relationship_type: recordNewRelationshipType,
        partner_type: recordNewPartnerType,
        certainty: recordNewCertainty,
      })

      const updatedTree = await getFamilyTree(created.family_id || familyId)
      setRecordFamilyTree(updatedTree)
      setRecordRelatedToPersonId(updatedTree.elder_person_id)
      setRecordNewRelativeName('')
      setRecordNewRelationship('child')
      setRecordNewRelationshipType('unknown')
      setRecordNewPartnerType('unknown')
      setRecordNewCertainty('unknown')
      setRecordAddOpen(false)
      await refreshFamilySpeakers()
      setFamilyActionNoticeKind('success')
      setFamilyActionNotice('Family member added and available as speaker.')
    } catch (err) {
      setRecordFamilyError(err instanceof Error ? err.message : 'Failed to add family member')
    } finally {
      setRecordAddingRelative(false)
    }
  }

  function startEditPerson(person: FamilyTree['people'][number]) {
    const personId = person.id
    setEditingPersonId(personId)
    setEditDisplayName(person.display_name || '')
    setEditGivenName(person.given_name || '')
    setEditFamilyName(person.family_name || '')
    setEditSex(person.sex || 'unknown')
    setEditBirthYear(person.birth_year != null ? String(person.birth_year) : '')
    setEditDeathYear(person.death_year != null ? String(person.death_year) : '')
    setEditNotes(person.notes || '')
    setEditAgeRange((person as { age_range?: string }).age_range || '')
    setEditPreferredLanguage((person as { preferred_language?: string }).preferred_language || '')
    setEditHomeRegion((person as { home_region?: string }).home_region || '')
    setEditConsent(Boolean((person as { consent?: boolean }).consent))
  }

  function cancelEditPerson() {
    setEditingPersonId('')
    setEditDisplayName('')
    setEditGivenName('')
    setEditFamilyName('')
    setEditSex('unknown')
    setEditBirthYear('')
    setEditDeathYear('')
    setEditNotes('')
    setEditAgeRange('')
    setEditPreferredLanguage('')
    setEditHomeRegion('')
    setEditConsent(false)
  }

  async function savePersonEdit(personId: string) {
    if (!familyId) return
    const cleanName = editDisplayName.trim()
    if (!cleanName) {
      setFamilyTreeError('Display name is required.')
      return
    }
    setSavingPersonEdit(true)
    setFamilyTreeError('')
    try {
      const parseYearOrNull = (value: string): number | null => {
        const clean = value.trim()
        if (!clean) return null
        const year = Number(clean)
        if (!Number.isInteger(year) || year < 1800 || year > 2100) {
          throw new Error('Year values must be integers between 1800 and 2100.')
        }
        return year
      }

      await updateFamilyPerson(familyId, personId, {
        display_name: cleanName,
        given_name: editGivenName.trim(),
        family_name: editFamilyName.trim(),
        sex: editSex,
        birth_year: parseYearOrNull(editBirthYear),
        death_year: parseYearOrNull(editDeathYear),
        notes: editNotes.trim(),
        age_range: editAgeRange.trim(),
        preferred_language: editPreferredLanguage.trim(),
        home_region: editHomeRegion.trim(),
        consent: editConsent,
      })
      const updated = await getFamilyTree(familyId)
      setFamilyTree(updated)
      cancelEditPerson()
      setFamilyActionNoticeKind('success')
      setFamilyActionNotice('Person updated successfully.')
    } catch (err) {
      setFamilyTreeError(err instanceof Error ? err.message : 'Failed to update person')
    } finally {
      setSavingPersonEdit(false)
    }
  }

  async function handleDeletePerson(personId: string) {
    if (!familyId) return

    setDeletingPersonId(personId)
    setFamilyTreeError('')
    try {
      await deleteFamilyPerson(familyId, personId)
      const updated = await getFamilyTree(familyId)
      setFamilyTree(updated)
      if (editingPersonId === personId) cancelEditPerson()
      setFamilyActionNoticeKind('success')
      setFamilyActionNotice('Member deleted successfully.')
    } catch (err) {
      setFamilyTreeError(err instanceof Error ? err.message : 'Failed to delete person')
    } finally {
      setDeletingPersonId('')
    }
  }

  async function handleDeleteEdge(edgeId: string) {
    if (!familyId) return
    setDeletingEdgeId(edgeId)
    setFamilyTreeError('')
    try {
      await deleteFamilyEdge(familyId, edgeId)
      const updated = await getFamilyTree(familyId)
      setFamilyTree(updated)
      setFamilyActionNoticeKind('success')
      setFamilyActionNotice('Relationship deleted successfully.')
    } catch (err) {
      setFamilyTreeError(err instanceof Error ? err.message : 'Failed to delete relationship')
    } finally {
      setDeletingEdgeId('')
    }
  }

  async function submitLinkExistingPeople(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!familyId || !familyTree) return
    const fromId = linkFromPersonId || familyTree.elder_person_id
    const toId = linkToPersonId
    if (!toId) {
      setFamilyTreeError('Select both people to create a relationship.')
      return
    }
    if (fromId === toId) {
      setFamilyTreeError('Choose two different people for a relationship.')
      return
    }

    setLinkingEdge(true)
    setFamilyTreeError('')
    try {
      await createFamilyEdge(familyId, {
        kind: linkKind,
        from_person_id: fromId,
        to_person_id: toId,
        relationship_type: linkRelationshipType,
        partner_type: linkPartnerType,
        certainty: linkCertainty,
      })
      const updated = await getFamilyTree(familyId)
      setFamilyTree(updated)
      setLinkToPersonId('')
      setLinkKind('parent_child')
      setLinkRelationshipType('unknown')
      setLinkPartnerType('unknown')
      setLinkCertainty('unknown')
      setFamilyActionNoticeKind('success')
      setFamilyActionNotice('Relationship created successfully.')
    } catch (err) {
      setFamilyTreeError(err instanceof Error ? err.message : 'Failed to create relationship')
    } finally {
      setLinkingEdge(false)
    }
  }

  function requestDeletePerson(personId: string, displayName: string) {
    setConfirmDeleteType('person')
    setConfirmDeleteId(personId)
    setConfirmDeleteLabel(displayName)
    setConfirmModalOpen(true)
  }

  function requestDeleteEdge(edgeId: string, label: string) {
    setConfirmDeleteType('edge')
    setConfirmDeleteId(edgeId)
    setConfirmDeleteLabel(label)
    setConfirmModalOpen(true)
  }

  async function confirmDeleteAction() {
    if (!confirmDeleteType || !confirmDeleteId) return
    setConfirmDeleting(true)
    try {
      if (confirmDeleteType === 'person') {
        await handleDeletePerson(confirmDeleteId)
      } else {
        await handleDeleteEdge(confirmDeleteId)
      }
      setConfirmModalOpen(false)
      setConfirmDeleteType('')
      setConfirmDeleteId('')
      setConfirmDeleteLabel('')
    } finally {
      setConfirmDeleting(false)
    }
  }

  function handleRelationshipSelection(nextRelationship: 'child' | 'parent' | 'partner' | 'sibling') {
    setNewRelationship(nextRelationship)
    if (nextRelationship === 'partner') {
      setNewRelationshipType('unknown')
    } else {
      setNewPartnerType('unknown')
    }
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
      if (authMode === 'signup') {
        openElderSetupModal()
      }
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
    if (!recordedBlob || !draftTitle.trim() || !selectedSpeakerPersonId) return

    setIsSavingRecord(true)
    setRecordError('')

    try {
      setRecordStatus('Saving recording...')
      const created = await createMemory(recordedBlob, draftTitle.trim(), selectedSpeakerPersonId)

      setRecordStatus('Transcribing with ElevenLabs...')
      await transcribeMemory(created.id)

      setRecordStatus('Building story variants with AI agent...')
      await generateStory(created.id, 'Create a warm family storybook chapter based on this memory.')

      setRecordStatus('Designing story cover...')
      const coverResult = await generateCover(created.id, 'Storybook cover with warm, nostalgic family tones')

      await loadMemories()
      if ((coverResult.cover_status || '').startsWith('generated_fallback')) {
        setRecordStatus('Saved. Story ready. Cover used fallback strategy.')
      } else {
        setRecordStatus('Saved. Transcript, story, and Vertex cover are ready.')
      }
      setRecordedBlob(null)
      setDraftTitle('')
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

  function seekToPlayback(seconds: number) {
    const audio = audioRef.current
    if (!audio) return
    const max = audioDuration > 0 ? audioDuration : Number.POSITIVE_INFINITY
    const clamped = Math.max(0, Math.min(seconds, max))
    audio.currentTime = clamped
    setPlayheadSeconds(clamped)
  }

  async function toggleListenerPlayback() {
    const audio = audioRef.current
    if (!audio || !audioSrc) return
    if (audio.paused) {
      try {
        await audio.play()
      } catch {
        // Ignore autoplay constraints if browser blocks playback.
      }
      return
    }
    audio.pause()
  }

  async function runGeekReplyAs() {
    if (!geekSpeakerPersonId || !geekQuery.trim() || !detailItem?.id) return
    setGeekLoading(true)
    setGeekError('')
    try {
      const result = await geekReplyAs({
        query: geekQuery.trim(),
        speaker_person_id: geekSpeakerPersonId,
        top_k: 8,
        anchor_memory_id: detailItem.id,
      })
      setGeekReply(result.reply || '')
      setGeekRelationshipContext(result.relationship_context || '')
      setGeekSources(result.sources || [])
    } catch (err) {
      setGeekError(err instanceof Error ? err.message : 'Failed to run reply-as query')
      setGeekReply('')
      setGeekRelationshipContext('')
      setGeekSources([])
    } finally {
      setGeekLoading(false)
    }
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
      (isSignup ? authPassword.length >= 10 : authPassword.length > 0) &&
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

          {isSignup ? <p className="meta auth-note">Password must be at least 10 characters.</p> : null}
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
          <section className="panel family-tree-cta">
            <div>
              <h2>Family Tree</h2>
              <p className="meta">Build and explore your elder-root family graph.</p>
            </div>
            <button type="button" className="record-save-button" onClick={() => navigate('/family-tree')}>
              View Family Tree
            </button>
          </section>

          <section className="panel">
            <div className="section-head">
              <h2>Cover Wall</h2>
              <a href={`${API_BASE}/api/health`} target="_blank" rel="noreferrer">API status</a>
            </div>
            {loading ? <p className="meta">Loading memories...</p> : null}
            {!loading && memories.length === 0 ? <p className="meta">No stories yet.</p> : null}
            <div className="cover-wall-wrap">
              <div id={wallId} ref={wallRailRef} className="cover-wall spring-scroll" data-bounce-axis="y">
                {memories.map((item) => (
                  <button key={item.id} className="cover-wall-item" onClick={() => navigate(`/recordings/${item.id}`)}>
                    {item.cover_path ? (
                      <img
                        src={toAssetUrl(`/covers/${item.id}.svg?v=${encodeURIComponent(item.updated_at || '')}`)}
                        alt={item.title}
                        className="cover-image"
                      />
                    ) : (
                      <div className="cover-image placeholder">No cover</div>
                    )}
                    <span>{item.title}</span>
                  </button>
                ))}
              </div>
              {showWallPrev ? (
                <button
                  type="button"
                  className="rail-next rail-prev rail-prev-wall"
                  onClick={(e) => scrollWallPrev(e.currentTarget)}
                  aria-label="Scroll cover wall left"
                >
                  &#8249;
                </button>
              ) : null}
              <button
                type="button"
                className="rail-next rail-next-wall"
                onClick={(e) => scrollWallNext(e.currentTarget)}
                aria-label="Scroll cover wall"
              >
                &#8250;
              </button>
            </div>
          </section>
        </div>
      ) : null}

      {route.view === 'record' ? (
        <div className="view-shell record-view">
          <section className="panel recorder-panel">
            <div className="record-prep-card">
              <h3>Who is speaking?</h3>
              <p className="meta">
                {recordAddOpen ? 'Add a family member first, then select them as speaker.' : 'Choose an existing family member before recording.'}
              </p>
              {!recordAddOpen ? (
                <div className="speaker-field">
                  <select
                    className="title-input speaker-select"
                    value={selectedSpeakerPersonId}
                    onChange={(e) => setSelectedSpeakerPersonId(e.target.value)}
                    aria-label="Select speaker"
                  >
                    <option value="">Select family member...</option>
                    {existingSpeakers.map((speaker) => (
                      <option key={speaker.person_id} value={speaker.person_id}>
                        {speaker.display_name}
                        {speaker.is_elder_root ? ' (Elder)' : ''}
                      </option>
                    ))}
                  </select>
                  <button type="button" className="btn" onClick={() => setRecordAddOpen(true)}>
                    Speaker not listed? Add Family Member
                  </button>
                  {existingSpeakers.length === 0 ? (
                    <p className="meta">No family members found. Add one below.</p>
                  ) : null}
                </div>
              ) : null}
              {recordFamilyLoading ? <p className="meta">Loading family members...</p> : null}
              {recordFamilyError ? <p className="error-text">{recordFamilyError}</p> : null}
              {recordAddOpen && recordFamilyTree ? (
                <form className="record-add-member-form" onSubmit={submitRecordAddRelative}>
                  <input
                    type="text"
                    className="title-input"
                    placeholder="Family member name"
                    value={recordNewRelativeName}
                    onChange={(e) => setRecordNewRelativeName(e.target.value)}
                  />
                  <select
                    className="title-input"
                    value={recordRelatedToPersonId || recordFamilyTree.elder_person_id}
                    onChange={(e) => setRecordRelatedToPersonId(e.target.value)}
                  >
                    {recordFamilyTree.people.map((person) => (
                      <option key={person.id} value={person.id}>
                        Related to: {person.display_name}
                      </option>
                    ))}
                  </select>
                  <select
                    className="title-input"
                    value={recordNewRelationship}
                    onChange={(e) =>
                      handleRecordRelationshipSelection(e.target.value as 'child' | 'parent' | 'partner' | 'sibling')
                    }
                  >
                    <option value="child">Child of</option>
                    <option value="parent">Parent of</option>
                    <option value="partner">Partner/Spouse of</option>
                    <option value="sibling">Sibling of</option>
                  </select>
                  {recordNewRelationship !== 'partner' ? (
                    <select
                      className="title-input"
                      value={recordNewRelationshipType}
                      onChange={(e) =>
                        setRecordNewRelationshipType(
                          e.target.value as 'biological' | 'adoptive' | 'step' | 'guardian' | 'unknown'
                        )
                      }
                    >
                      <option value="unknown">Relationship type: unknown</option>
                      <option value="biological">Biological</option>
                      <option value="adoptive">Adoptive</option>
                      <option value="step">Step</option>
                      <option value="guardian">Guardian</option>
                    </select>
                  ) : (
                    <select
                      className="title-input"
                      value={recordNewPartnerType}
                      onChange={(e) =>
                        setRecordNewPartnerType(
                          e.target.value as 'married' | 'partner' | 'divorced' | 'separated' | 'unknown'
                        )
                      }
                    >
                      <option value="unknown">Partner type: unknown</option>
                      <option value="married">Married</option>
                      <option value="partner">Partner</option>
                      <option value="separated">Separated</option>
                      <option value="divorced">Divorced</option>
                    </select>
                  )}
                  <select
                    className="title-input"
                    value={recordNewCertainty}
                    onChange={(e) => setRecordNewCertainty(e.target.value as 'certain' | 'estimated' | 'unknown')}
                  >
                    <option value="unknown">Certainty: unknown</option>
                    <option value="certain">Certain</option>
                    <option value="estimated">Estimated</option>
                  </select>
                  <button
                    type="submit"
                    className="record-save-button"
                    disabled={recordAddingRelative || !recordNewRelativeName.trim()}
                  >
                    {recordAddingRelative ? 'Adding...' : 'Add Member'}
                  </button>
                  <button type="button" className="btn" onClick={() => setRecordAddOpen(false)} disabled={recordAddingRelative}>
                    Cancel
                  </button>
                </form>
              ) : null}
            </div>
            {!recordAddOpen ? (
              <Recorder
                disabled={!selectedSpeakerPersonId}
                disabledReason="Select a speaker first to start recording."
                onReady={(blob) => {
                  setRecordedBlob(blob)
                  setRecordError('')
                  setRecordStatus('')
                }}
              />
            ) : (
              <p className="meta">Finish adding the family member to unlock recording.</p>
            )}
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
                  <p className="meta">
                    Speaker:{' '}
                    {existingSpeakers.find((speaker) => speaker.person_id === selectedSpeakerPersonId)?.display_name ||
                      'Select speaker above before saving'}
                  </p>
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

      {route.view === 'family-tree' ? (
        <div className="view-shell family-tree-view spring-scroll">
          <section className="panel family-tree-panel">
            <div className="section-head">
              <h2>Family Tree</h2>
              <div className="family-tree-head-actions">
                <button type="button" className="btn" onClick={() => navigate('/family-graph')} disabled={!familyId}>
                  Graph View
                </button>
                <button type="button" className="btn btn-primary detail-back" onClick={() => navigate('/')}>
                  Back Home
                </button>
              </div>
            </div>
            {familyActionNotice ? (
              <p className={`status-banner ${familyActionNoticeKind === 'error' ? 'error' : 'success'}`}>
                {familyActionNotice}
              </p>
            ) : null}
            {familyTreeLoading ? <p className="meta">Loading family tree...</p> : null}
            {familyTreeError ? <p className="error-text">{familyTreeError}</p> : null}
            {!familyTreeLoading && !familyId ? (
              <button
                type="button"
                className="record-save-button"
                onClick={openElderSetupModal}
              >
                Set Up Elder
              </button>
            ) : null}
            {familyTree ? (
              <>
                <div className="family-tree-grid spring-scroll">
                  {generationBuckets.map((bucket) => (
                    <section key={`gen-${bucket.level}`} className="family-gen-column">
                      <h3>
                        {bucket.level === 0
                          ? 'Elder'
                          : bucket.level < 0
                            ? `Ancestors ${Math.abs(bucket.level)}`
                            : bucket.level === 99
                              ? 'Unplaced'
                              : `Descendants ${bucket.level}`}
                      </h3>
                      <div className="family-gen-list">
                        {bucket.members.map((person) => {
                          const childCount = familyTree.edges.filter(
                            (edge) => edge.kind === 'parent_child' && edge.from_person_id === person.id
                          ).length
                          const partnerCount = familyTree.edges.filter(
                            (edge) =>
                              edge.kind === 'partner' &&
                              (edge.from_person_id === person.id || edge.to_person_id === person.id)
                          ).length
                          return (
                            <article key={person.id} className={`family-person-card ${person.is_elder_root ? 'elder' : ''}`}>
                              {editingPersonId === person.id ? (
                                <div className="person-edit-form">
                                  <input
                                    type="text"
                                    className="title-input"
                                    placeholder="Display name"
                                    value={editDisplayName}
                                    onChange={(e) => setEditDisplayName(e.target.value)}
                                  />
                                  <input
                                    type="text"
                                    className="title-input"
                                    placeholder="Given name"
                                    value={editGivenName}
                                    onChange={(e) => setEditGivenName(e.target.value)}
                                  />
                                  <input
                                    type="text"
                                    className="title-input"
                                    placeholder="Family name"
                                    value={editFamilyName}
                                    onChange={(e) => setEditFamilyName(e.target.value)}
                                  />
                                  <select
                                    className="title-input"
                                    value={editSex}
                                    onChange={(e) => setEditSex(e.target.value as 'female' | 'male' | 'other' | 'unknown')}
                                  >
                                    <option value="unknown">Sex: unknown</option>
                                    <option value="female">Female</option>
                                    <option value="male">Male</option>
                                    <option value="other">Other</option>
                                  </select>
                                  <input
                                    type="number"
                                    min={1800}
                                    max={2100}
                                    className="title-input"
                                    placeholder="Birth year"
                                    value={editBirthYear}
                                    onChange={(e) => setEditBirthYear(e.target.value)}
                                  />
                                  <input
                                    type="number"
                                    min={1800}
                                    max={2100}
                                    className="title-input"
                                    placeholder="Death year"
                                    value={editDeathYear}
                                    onChange={(e) => setEditDeathYear(e.target.value)}
                                  />
                                  <input
                                    type="text"
                                    className="title-input"
                                    placeholder="Age range"
                                    value={editAgeRange}
                                    onChange={(e) => setEditAgeRange(e.target.value)}
                                  />
                                  <input
                                    type="text"
                                    className="title-input"
                                    placeholder="Preferred language"
                                    value={editPreferredLanguage}
                                    onChange={(e) => setEditPreferredLanguage(e.target.value)}
                                  />
                                  <input
                                    type="text"
                                    className="title-input"
                                    placeholder="Home region"
                                    value={editHomeRegion}
                                    onChange={(e) => setEditHomeRegion(e.target.value)}
                                  />
                                  <textarea
                                    className="title-input"
                                    rows={3}
                                    placeholder="Notes"
                                    value={editNotes}
                                    onChange={(e) => setEditNotes(e.target.value)}
                                  />
                                  <label className="consent-row">
                                    <input
                                      type="checkbox"
                                      checked={editConsent}
                                      onChange={(e) => setEditConsent(e.target.checked)}
                                    />
                                    <span>Consent confirmed</span>
                                  </label>
                                  <div className="person-edit-actions">
                                    <button type="button" className="btn" onClick={cancelEditPerson} disabled={savingPersonEdit}>
                                      Cancel
                                    </button>
                                    <button
                                      type="button"
                                      className="btn family-danger-btn"
                                      onClick={() => requestDeletePerson(person.id, person.display_name)}
                                      disabled={savingPersonEdit || deletingPersonId === person.id || person.is_elder_root}
                                    >
                                      {deletingPersonId === person.id ? 'Deleting...' : 'Delete Member'}
                                    </button>
                                    <button
                                      type="button"
                                      className="record-save-button"
                                      onClick={() => void savePersonEdit(person.id)}
                                      disabled={savingPersonEdit || !editDisplayName.trim()}
                                    >
                                      {savingPersonEdit ? 'Saving...' : 'Save'}
                                    </button>
                                  </div>
                                </div>
                              ) : (
                                <>
                                  <strong>{person.display_name}</strong>
                                  <p className="meta">
                                    {person.birth_year ? `Born ${person.birth_year}` : 'Birth year unknown'}
                                  </p>
                                  <p className="meta">
                                    Children: {childCount} | Partners: {partnerCount}
                                  </p>
                                  <button
                                    type="button"
                                    className="btn family-inline-btn"
                                    onClick={() => startEditPerson(person)}
                                  >
                                    Edit
                                  </button>
                                </>
                              )}
                            </article>
                          )
                        })}
                      </div>
                    </section>
                  ))}
                </div>
              </>
            ) : null}
          </section>
          {familyTree ? (
            <section className="panel family-add-panel">
              <form className="family-add-form" onSubmit={submitAddRelative}>
                <h3>Add Relative</h3>
                <div className="form-step">
                  <label className="form-step-label">1. What is this person&apos;s name?</label>
                  <input
                    type="text"
                    className="title-input"
                    placeholder="Relative name"
                    value={newRelativeName}
                    onChange={(e) => setNewRelativeName(e.target.value)}
                  />
                </div>

                {newRelativeName.trim() ? (
                  <div className="form-step">
                    <label className="form-step-label">2. Who are they related to?</label>
                    {familyTree.people.length === 1 ? (
                      <p className="form-step-help">
                        This is your first relative. They will be linked to {familyTree.people[0].display_name}.
                      </p>
                    ) : (
                      <select
                        className="title-input"
                        value={relatedToPersonId || familyTree.elder_person_id}
                        onChange={(e) => setRelatedToPersonId(e.target.value)}
                      >
                        {familyTree.people.map((person) => (
                          <option key={person.id} value={person.id}>
                            {person.display_name}
                          </option>
                        ))}
                      </select>
                    )}
                  </div>
                ) : null}

                {newRelativeName.trim() ? (
                  <div className="form-step">
                    <label className="form-step-label">3. How are they related?</label>
                    <select
                      className="title-input"
                      value={newRelationship}
                      onChange={(e) =>
                        handleRelationshipSelection(e.target.value as 'child' | 'parent' | 'partner' | 'sibling')
                      }
                    >
                      <option value="child">Child of</option>
                      <option value="parent">Parent of</option>
                      <option value="partner">Partner/Spouse of</option>
                      <option value="sibling">Sibling of</option>
                    </select>
                    <p className="form-step-help">
                      {newRelativeName.trim()} will be added as{' '}
                      {newRelationship === 'partner' ? 'a partner/spouse' : `a ${newRelationship}`}{' '}
                      of{' '}
                      {familyTree.people.find((person) => person.id === (relatedToPersonId || familyTree.elder_person_id))
                        ?.display_name || 'selected person'}
                      .
                    </p>
                  </div>
                ) : null}

                {newRelativeName.trim() && newRelationship !== 'partner' ? (
                  <div className="form-step">
                    <label className="form-step-label">4. Relationship type</label>
                    <select
                      className="title-input"
                      value={newRelationshipType}
                      onChange={(e) =>
                        setNewRelationshipType(
                          e.target.value as 'biological' | 'adoptive' | 'step' | 'guardian' | 'unknown'
                        )
                      }
                    >
                      <option value="unknown">Unknown</option>
                      <option value="biological">Biological</option>
                      <option value="adoptive">Adoptive</option>
                      <option value="step">Step</option>
                      <option value="guardian">Guardian</option>
                    </select>
                  </div>
                ) : null}

                {newRelativeName.trim() && newRelationship === 'partner' ? (
                  <div className="form-step">
                    <label className="form-step-label">4. Partner/Spouse status</label>
                    <select
                      className="title-input"
                      value={newPartnerType}
                      onChange={(e) =>
                        setNewPartnerType(
                          e.target.value as 'married' | 'partner' | 'divorced' | 'separated' | 'unknown'
                        )
                      }
                    >
                      <option value="unknown">Unknown</option>
                      <option value="married">Married</option>
                      <option value="partner">Partner (not married)</option>
                      <option value="separated">Separated</option>
                      <option value="divorced">Divorced</option>
                    </select>
                  </div>
                ) : null}

                {newRelativeName.trim() ? (
                  <div className="form-step">
                    <label className="form-step-label">5. Certainty (optional)</label>
                    <select
                      className="title-input"
                      value={newCertainty}
                      onChange={(e) => setNewCertainty(e.target.value as 'certain' | 'estimated' | 'unknown')}
                    >
                      <option value="unknown">Unknown</option>
                      <option value="certain">Certain</option>
                      <option value="estimated">Estimated</option>
                    </select>
                  </div>
                ) : null}
                <button
                  type="submit"
                  className="record-save-button"
                  disabled={addingRelative || !newRelativeName.trim()}
                >
                  {addingRelative ? 'Adding...' : 'Add Relative'}
                </button>
              </form>
            </section>
          ) : null}
          {familyTree ? (
            <section className="panel family-relations-panel">
              <h3>Relationships</h3>
              <div className="family-relations-list spring-scroll">
                {familyTree.edges.length === 0 ? <p className="meta">No relationships yet.</p> : null}
                {familyTree.edges.map((edge) => {
                  const fromName =
                    familyTree.people.find((person) => person.id === edge.from_person_id)?.display_name || edge.from_person_id
                  const toName =
                    familyTree.people.find((person) => person.id === edge.to_person_id)?.display_name || edge.to_person_id
                  const relText =
                    edge.kind === 'partner'
                      ? `${fromName} ↔ ${toName} (${edge.partner_type || 'unknown'})`
                      : `${fromName} → ${toName} (${edge.relationship_type || 'unknown'})`
                  return (
                    <div key={edge.id} className="family-relation-item">
                      <p className="meta">{relText}</p>
                      <button
                        type="button"
                        className="btn family-danger-btn"
                        onClick={() => requestDeleteEdge(edge.id, relText)}
                        disabled={deletingEdgeId === edge.id}
                      >
                        {deletingEdgeId === edge.id ? 'Deleting...' : 'Delete'}
                      </button>
                    </div>
                  )
                })}
              </div>
            </section>
          ) : null}
          {familyTree ? (
            <section className="panel family-link-panel">
              <h3>Link Existing People</h3>
              <form className="family-link-form" onSubmit={submitLinkExistingPeople}>
                <select
                  className="title-input"
                  value={linkFromPersonId || familyTree.elder_person_id}
                  onChange={(e) => setLinkFromPersonId(e.target.value)}
                >
                  {familyTree.people.map((person) => (
                    <option key={person.id} value={person.id}>
                      From: {person.display_name}
                    </option>
                  ))}
                </select>
                <select
                  className="title-input"
                  value={linkToPersonId}
                  onChange={(e) => setLinkToPersonId(e.target.value)}
                >
                  <option value="">To person...</option>
                  {familyTree.people.map((person) => (
                    <option key={person.id} value={person.id}>
                      {person.display_name}
                    </option>
                  ))}
                </select>
                <select
                  className="title-input"
                  value={linkKind}
                  onChange={(e) => setLinkKind(e.target.value as 'parent_child' | 'partner')}
                >
                  <option value="parent_child">Parent → Child</option>
                  <option value="partner">Partner ↔ Partner</option>
                </select>
                {linkKind === 'parent_child' ? (
                  <select
                    className="title-input"
                    value={linkRelationshipType}
                    onChange={(e) =>
                      setLinkRelationshipType(
                        e.target.value as 'biological' | 'adoptive' | 'step' | 'guardian' | 'unknown'
                      )
                    }
                  >
                    <option value="unknown">Relationship type: unknown</option>
                    <option value="biological">Biological</option>
                    <option value="adoptive">Adoptive</option>
                    <option value="step">Step</option>
                    <option value="guardian">Guardian</option>
                  </select>
                ) : (
                  <select
                    className="title-input"
                    value={linkPartnerType}
                    onChange={(e) =>
                      setLinkPartnerType(
                        e.target.value as 'married' | 'partner' | 'divorced' | 'separated' | 'unknown'
                      )
                    }
                  >
                    <option value="unknown">Partner type: unknown</option>
                    <option value="married">Married</option>
                    <option value="partner">Partner</option>
                    <option value="separated">Separated</option>
                    <option value="divorced">Divorced</option>
                  </select>
                )}
                <select
                  className="title-input"
                  value={linkCertainty}
                  onChange={(e) => setLinkCertainty(e.target.value as 'certain' | 'estimated' | 'unknown')}
                >
                  <option value="unknown">Certainty: unknown</option>
                  <option value="certain">Certain</option>
                  <option value="estimated">Estimated</option>
                </select>
                {linkEdgeDuplicate ? (
                  <p className="meta">This relationship already exists for the selected people.</p>
                ) : null}
                <button
                  type="submit"
                  className="record-save-button"
                  disabled={linkingEdge || !linkToPersonId || linkEdgeDuplicate}
                >
                  {linkingEdge ? 'Linking...' : 'Create Relationship'}
                </button>
              </form>
            </section>
          ) : null}
        </div>
      ) : null}

      {route.view === 'memory-map' ? (
        <MemoryMapView onNavigate={navigate} />
      ) : null}

      {route.view === 'family-graph' ? (
        familyId ? (
          <FamilyGraphView familyId={familyId} onBack={() => navigate('/family-tree')} />
        ) : (
          <div className="view-shell">
            <section className="panel">
              <h2>Family Graph</h2>
              <p className="meta">Set up an elder profile before viewing the graph.</p>
              <button type="button" className="record-save-button" onClick={openElderSetupModal}>
                Set Up Elder
              </button>
            </section>
          </div>
        )
      ) : null}

      {route.view === 'detail' ? (
        <div className="view-shell">
          <section className="panel recording-detail">
            {detailItem ? (
              <>
                <div className="detail-head">
                  <h2>{detailItem.title}</h2>
                  <p className="meta">{new Date(detailItem.created_at).toLocaleString()}</p>
                  {(detailItem.mood_tag?.trim() || (detailItem.themes?.length ?? 0) > 0) ? (
                    <div className="memory-tags memory-tags-detail">
                      {detailItem.mood_tag?.trim() ? (
                        <span className="memory-tag memory-tag-mood">{formatMemoryTag(detailItem.mood_tag)}</span>
                      ) : null}
                      {(detailItem.themes ?? []).map((t) => (
                        <span key={t} className="memory-tag memory-tag-theme">{formatMemoryTag(t)}</span>
                      ))}
                    </div>
                  ) : null}
                </div>

                <section className="detail-block detail-mode-shell">
                  <div className="detail-toolbar">
                    <div className="detail-modes" role="tablist" aria-label="Record modes">
                      <button
                        type="button"
                        role="tab"
                        aria-selected={detailMode === 'reader'}
                        className={`detail-mode-tab ${detailMode === 'reader' ? 'active' : ''}`}
                        onClick={() => setDetailMode('reader')}
                      >
                        Reader Mode
                      </button>
                      <button
                        type="button"
                        role="tab"
                        aria-selected={detailMode === 'listener'}
                        className={`detail-mode-tab ${detailMode === 'listener' ? 'active' : ''}`}
                        onClick={() => setDetailMode('listener')}
                      >
                        Listener Mode
                      </button>
                      <button
                        type="button"
                        role="tab"
                        aria-selected={detailMode === 'geek'}
                        className={`detail-mode-tab ${detailMode === 'geek' ? 'active' : ''}`}
                        onClick={() => setDetailMode('geek')}
                      >
                        Geek Mode
                      </button>
                    </div>
                    {detailMode === 'reader' ? (
                      <div className="detail-versions" role="tablist" aria-label="Reader versions">
                        <button
                          type="button"
                          role="tab"
                          aria-selected={readerVersion === 'narration'}
                          className={`detail-mode-tab ${readerVersion === 'narration' ? 'active' : ''}`}
                          onClick={() => setReaderVersion('narration')}
                        >
                          Narration Style
                        </button>
                        <button
                          type="button"
                          role="tab"
                          aria-selected={readerVersion === 'summary'}
                          className={`detail-mode-tab ${readerVersion === 'summary' ? 'active' : ''}`}
                          onClick={() => setReaderVersion('summary')}
                        >
                          AI Summary
                        </button>
                        <button
                          type="button"
                          role="tab"
                          aria-selected={readerVersion === 'original'}
                          className={`detail-mode-tab ${readerVersion === 'original' ? 'active' : ''}`}
                          onClick={() => setReaderVersion('original')}
                        >
                          Original
                        </button>
                        <button
                          type="button"
                          role="tab"
                          aria-selected={readerVersion === 'children'}
                          className={`detail-mode-tab ${readerVersion === 'children' ? 'active' : ''}`}
                          onClick={() => setReaderVersion('children')}
                        >
                          Children
                        </button>
                      </div>
                    ) : detailMode === 'listener' ? (
                      <div className="detail-versions" role="tablist" aria-label="Listener versions">
                        <button
                          type="button"
                          role="tab"
                          aria-selected={storyTab === 'summary'}
                          className={`detail-mode-tab ${storyTab === 'summary' ? 'active' : ''}`}
                          onClick={() => setStoryTab('summary')}
                        >
                          Original Recording
                        </button>
                        <button
                          type="button"
                          role="tab"
                          aria-selected={storyTab === 'children'}
                          className={`detail-mode-tab ${storyTab === 'children' ? 'active' : ''}`}
                          onClick={() => setStoryTab('children')}
                        >
                          Children&apos;s Narration
                        </button>
                        <button
                          type="button"
                          role="tab"
                          aria-selected={storyTab === 'narration'}
                          className={`detail-mode-tab ${storyTab === 'narration' ? 'active' : ''}`}
                          onClick={() => setStoryTab('narration')}
                        >
                          Documentary Narration
                        </button>
                      </div>
                    ) : null}
                  </div>

                  <div className="open-book">
                    <article className="book-page book-page-cover">
                      {detailItem.cover_path ? (
                        <img
                          src={toAssetUrl(`/covers/${detailItem.id}.svg?v=${encodeURIComponent(detailItem.updated_at || '')}`)}
                          alt={`${detailItem.title} cover`}
                          className="detail-cover"
                        />
                      ) : (
                        <div className="detail-cover placeholder">Cover photo not available yet.</div>
                      )}
                    </article>
                    <article className={`book-page book-page-content ${detailMode === 'listener' ? 'book-page-content-listener' : ''}`}>
                      {detailMode === 'listener' ? (
                        <div className="book-listener-content">
                          <h3>{bookRightTitle}</h3>
                          {lyricLines.length > 0 ? (
                            <div className="lyrics-panel spring-scroll" role="list">
                              {lyricLines.map((line, idx) => {
                                const isActive = idx === activeLyricIndex
                                const isPast = idx < activeLyricIndex
                                const state = isActive ? 'active' : isPast ? 'past' : 'upcoming'
                                return (
                                  <button
                                    key={`${line.start}-${idx}`}
                                    ref={(element) => {
                                      lyricLineRefs.current[idx] = element
                                    }}
                                    type="button"
                                    className={`lyric-line lyric-line-${state}`}
                                    onClick={() => seekToLyric(line.start)}
                                    role="listitem"
                                  >
                                    <span className="lyric-line-text">{line.text}</span>
                                  </button>
                                )
                              })}
                            </div>
                          ) : (
                            <p className="detail-transcript-fallback">
                              {activeTranscriptText ||
                                'Transcript for this selected listener version is not available yet.'}
                            </p>
                          )}
                          <div className="listener-now-playing">
                            <input
                              className="listener-seek-line"
                              type="range"
                              min={0}
                              max={Math.max(audioDuration, 0)}
                              step={0.1}
                              value={Math.min(playheadSeconds, audioDuration || playheadSeconds)}
                              onChange={(event) => seekToPlayback(Number(event.target.value))}
                              disabled={!audioSrc || audioDuration <= 0}
                              aria-label="Seek recording position"
                            />
                            <button
                              type="button"
                              className="listener-play-toggle"
                              onClick={() => void toggleListenerPlayback()}
                              disabled={!audioSrc}
                              aria-label={audioPlaying ? 'Pause audio' : 'Play audio'}
                            >
                              <span aria-hidden="true" className="listener-play-icon">
                                {audioPlaying ? '❚❚' : '▶'}
                              </span>
                            </button>
                            <audio
                              ref={audioRef}
                              className="listener-audio-native"
                              preload="metadata"
                              src={audioSrc}
                              onTimeUpdate={(event) => setPlayheadSeconds(event.currentTarget.currentTime)}
                              onSeeked={(event) => setPlayheadSeconds(event.currentTarget.currentTime)}
                              onLoadedMetadata={(event) => {
                                setPlayheadSeconds(event.currentTarget.currentTime)
                                setAudioDuration(Number.isFinite(event.currentTarget.duration) ? event.currentTarget.duration : 0)
                              }}
                              onDurationChange={(event) =>
                                setAudioDuration(Number.isFinite(event.currentTarget.duration) ? event.currentTarget.duration : 0)
                              }
                              onPlay={() => setAudioPlaying(true)}
                              onPause={() => setAudioPlaying(false)}
                              onEnded={() => setAudioPlaying(false)}
                            >
                              Your browser does not support the audio element.
                            </audio>
                          </div>
                        </div>
                      ) : (
                        <>
                          <h3>{bookRightTitle}</h3>
                          <p className="book-page-text">{bookRightBody}</p>
                        </>
                      )}
                    </article>
                  </div>

                  {detailMode === 'geek' ? (
                    <section className="detail-block geek-mode-panel">
                      <h3>Geek Mode · Reply As (RAG + Relationships)</h3>
                      <div className="geek-controls">
                        <label className="meta" htmlFor="geek-speaker">Reply As Speaker</label>
                        <select
                          id="geek-speaker"
                          className="title-input"
                          value={geekSpeakerPersonId}
                          onChange={(event) => setGeekSpeakerPersonId(event.target.value)}
                        >
                          {existingSpeakers.map((speaker) => (
                            <option key={speaker.person_id} value={speaker.person_id}>
                              {speaker.display_name}
                            </option>
                          ))}
                        </select>
                        <label className="meta" htmlFor="geek-query">Question</label>
                        <textarea
                          id="geek-query"
                          className="title-input geek-query-input"
                          value={geekQuery}
                          onChange={(event) => setGeekQuery(event.target.value)}
                          placeholder="Ask something like: How would you describe this memory to your grandchildren?"
                        />
                        <button
                          type="button"
                          className="record-save-button"
                          onClick={() => void runGeekReplyAs()}
                          disabled={geekLoading || !geekSpeakerPersonId || !geekQuery.trim()}
                        >
                          {geekLoading ? 'Running...' : 'Run Reply-As'}
                        </button>
                      </div>

                      {geekError ? <p className="meta">{geekError}</p> : null}

                      {geekReply ? (
                        <article className="geek-output">
                          <h4>Model Reply</h4>
                          <p>{geekReply}</p>
                        </article>
                      ) : null}

                      {geekRelationshipContext ? (
                        <article className="geek-output">
                          <h4>Relationship Context Used</h4>
                          <pre>{geekRelationshipContext}</pre>
                        </article>
                      ) : null}

                      {geekSources.length > 0 ? (
                        <article className="geek-output">
                          <h4>Retrieved Sources</h4>
                          <div className="geek-sources">
                            {geekSources.map((source) => (
                              <div key={source.memory_id} className="geek-source-item">
                                <strong>{source.title}</strong>
                                <p className="meta">Speaker: {source.speaker_tag} · Score: {source.score.toFixed(4)}</p>
                                <p>{source.snippet}</p>
                              </div>
                            ))}
                          </div>
                        </article>
                      ) : null}
                    </section>
                  ) : null}
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
            <button type="button" className="record-save-button" onClick={() => navigate('/family-tree')}>
              View Family Tree
            </button>
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
          <span
            className={`nav-indicator ${
              route.view === 'record'
                ? 'is-record'
                : route.view === 'memory-map'
                  ? 'is-memory-map'
                  : route.view === 'family-tree' || route.view === 'family-graph'
                    ? 'is-family-tree'
                    : 'is-home'
            }`}
          />
          <button className={route.view === 'home' ? 'active' : ''} onClick={() => navigate('/')}>Home</button>
          <button
            className={route.view === 'family-tree' || route.view === 'family-graph' ? 'active' : ''}
            onClick={() => navigate('/family-tree')}
          >
            Family Tree
          </button>
          <button
            className={route.view === 'memory-map' ? 'active' : ''}
            onClick={() => navigate('/memory-map')}
          >
            Memory Map
          </button>
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
                    <img
                      src={toAssetUrl(`/covers/${item.id}.svg?v=${encodeURIComponent(item.updated_at || '')}`)}
                      alt={item.title}
                      className="search-result-cover"
                    />
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

      {elderModalOpen ? (
        <div className="modal-backdrop" role="presentation" onClick={() => !elderSubmitting && setElderModalOpen(false)}>
          <section
            className="panel elder-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="elder-setup-title"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 id="elder-setup-title">Set Up Elder</h2>
            <p className="meta">Create the elder root profile for your family tree.</p>
            <form className="elder-form" onSubmit={submitElderSetupForm}>
              <input
                type="text"
                className="title-input"
                placeholder="Elder display name"
                value={elderDisplayName}
                onChange={(e) => setElderDisplayName(e.target.value)}
              />
              <input
                type="number"
                min={1800}
                max={2100}
                className="title-input"
                placeholder="Birth year (optional)"
                value={elderBirthYear}
                onChange={(e) => setElderBirthYear(e.target.value)}
              />
              <input
                type="text"
                className="title-input"
                placeholder="Age range (optional)"
                value={elderAgeRange}
                onChange={(e) => setElderAgeRange(e.target.value)}
              />
              <input
                type="text"
                className="title-input"
                placeholder="Preferred language (optional)"
                value={elderPreferredLanguage}
                onChange={(e) => setElderPreferredLanguage(e.target.value)}
              />
              <input
                type="text"
                className="title-input"
                placeholder="Home region (optional)"
                value={elderHomeRegion}
                onChange={(e) => setElderHomeRegion(e.target.value)}
              />
              <label className="consent-row">
                <input
                  type="checkbox"
                  checked={elderConsent}
                  onChange={(e) => setElderConsent(e.target.checked)}
                />
                <span>I confirm elder consent for this project.</span>
              </label>
              {elderSetupError ? <p className="error-text">{elderSetupError}</p> : null}
              <div className="elder-form-actions">
                <button
                  type="button"
                  className="btn"
                  onClick={() => setElderModalOpen(false)}
                  disabled={elderSubmitting}
                >
                  Cancel
                </button>
                <button type="submit" className="record-save-button" disabled={elderSubmitting}>
                  {elderSubmitting ? 'Saving...' : 'Save Elder'}
                </button>
              </div>
            </form>
          </section>
        </div>
      ) : null}

      {confirmModalOpen ? (
        <div className="modal-backdrop" role="presentation" onClick={() => !confirmDeleting && setConfirmModalOpen(false)}>
          <section
            className="panel elder-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="confirm-delete-title"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 id="confirm-delete-title">
              {confirmDeleteType === 'person' ? 'Delete Member' : 'Delete Relationship'}
            </h2>
            <p className="meta">
              {confirmDeleteType === 'person'
                ? `Delete ${confirmDeleteLabel}? This also removes connected relationships.`
                : `Delete this relationship: ${confirmDeleteLabel}?`}
            </p>
            <div className="elder-form-actions">
              <button
                type="button"
                className="btn"
                onClick={() => setConfirmModalOpen(false)}
                disabled={confirmDeleting}
              >
                Cancel
              </button>
              <button
                type="button"
                className="record-save-button"
                onClick={() => void confirmDeleteAction()}
                disabled={confirmDeleting}
              >
                {confirmDeleting ? 'Deleting...' : 'Confirm Delete'}
              </button>
            </div>
          </section>
        </div>
      ) : null}
    </main>
  )
}
