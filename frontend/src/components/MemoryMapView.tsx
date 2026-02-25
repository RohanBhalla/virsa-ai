import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import ForceGraph2D, { type ForceGraphMethods, type LinkObject, type NodeObject } from 'react-force-graph-2d'
import { getMemoryGraph, getRelatedMemories, toAssetUrl } from '../api'
import type { Memory, MemoryGraph } from '../types'

type MemoryNode = Memory & { id: string }
type GraphLink = { source: string; target: string; score: number }

interface MemoryMapViewProps {
  onNavigate: (path: string) => void
}

const THEME_PALETTE: string[] = [
  '#8b5a2b',
  '#2d5a27',
  '#1e4d6b',
  '#5a2d5a',
  '#8b4513',
  '#2d6b5a',
  '#4a2d6b',
]

function themeToColor(theme: string): string {
  let h = 0
  for (let i = 0; i < theme.length; i++) h = (h << 5) - h + theme.charCodeAt(i)
  const idx = Math.abs(h) % THEME_PALETTE.length
  return THEME_PALETTE[idx] ?? '#6b5344'
}

export function MemoryMapView({ onNavigate }: MemoryMapViewProps) {
  const [graph, setGraph] = useState<MemoryGraph | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [themeFilter, setThemeFilter] = useState<string>('')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [related, setRelated] = useState<{ memory: Memory; score: number }[]>([])
  const [trail, setTrail] = useState<string[]>([])
  const graphWrapRef = useRef<HTMLDivElement>(null)
  const fgRef = useRef<ForceGraphMethods<NodeObject<MemoryNode>, LinkObject<MemoryNode, GraphLink>> | undefined>(undefined)
  const [graphSize, setGraphSize] = useState({ width: 600, height: 400 })

  useEffect(() => {
    const wrap = graphWrapRef.current
    if (!wrap) return
    const update = () => {
      const w = Math.max(200, wrap.offsetWidth)
      const h = Math.max(200, wrap.offsetHeight)
      setGraphSize({ width: w, height: h })
    }
    update()
    const ro = new ResizeObserver(update)
    ro.observe(wrap)
    return () => ro.disconnect()
  }, [graph])

  const fetchGraph = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const data = await getMemoryGraph({
        theme: themeFilter || undefined,
        limit: 100,
      })
      setGraph(data)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load graph')
      setGraph(null)
    } finally {
      setLoading(false)
    }
  }, [themeFilter])

  useEffect(() => {
    fetchGraph()
  }, [fetchGraph])

  const themes = useMemo(() => {
    if (!graph?.nodes) return []
    const set = new Set<string>()
    for (const n of graph.nodes) {
      (n.themes ?? []).forEach((t) => set.add(t))
    }
    return Array.from(set).sort()
  }, [graph?.nodes])

  const graphData = useMemo(() => {
    if (!graph) return { nodes: [] as MemoryNode[], links: [] as GraphLink[] }
    const nodes: MemoryNode[] = graph.nodes.map((n) => ({ ...n, id: n.id }))
    const links: GraphLink[] = graph.edges.map((e) => ({
      source: e.source,
      target: e.target,
      score: e.score,
    }))
    return { nodes, links }
  }, [graph])

  const themeClusterPositions = useMemo(() => {
    const nodes = graphData.nodes
    if (nodes.length === 0) return new Map<string, { x: number; y: number }>()
    const themeSet = new Set<string>()
    nodes.forEach((n) => (n.themes ?? []).forEach((t) => themeSet.add(t)))
    const themeList = Array.from(themeSet).sort()
    const positions = new Map<string, { x: number; y: number }>()
    const R = 160
    themeList.forEach((t, i) => {
      const angle = (2 * Math.PI * i) / Math.max(1, themeList.length)
      positions.set(t, { x: R * Math.cos(angle), y: R * Math.sin(angle) })
    })
    positions.set('_other', { x: 0, y: 0 })
    return positions
  }, [graphData.nodes])

  useEffect(() => {
    const fg = fgRef.current
    if (!fg || graphData.nodes.length === 0) return
    const positions = themeClusterPositions
    const getTarget = (node: MemoryNode) =>
      positions.get((node.themes ?? [])[0] ?? '_other') ?? { x: 0, y: 0 }
    let nodes: MemoryNode[] = []
    const strength = 0.22
    function forceCluster(alpha: number) {
      for (const node of nodes) {
        const t = getTarget(node)
        const n = node as MemoryNode & { x?: number; y?: number; vx?: number; vy?: number }
        const x = n.x ?? 0
        const y = n.y ?? 0
        n.vx = (n.vx ?? 0) + (t.x - x) * strength * alpha
        n.vy = (n.vy ?? 0) + (t.y - y) * strength * alpha
      }
    }
    forceCluster.initialize = (n: unknown[]) => {
      nodes = n as MemoryNode[]
    }
    type ForceFn = ((alpha: number) => void) & { initialize?: (nodes: unknown[]) => void }
    fg.d3Force('themeCluster', forceCluster as ForceFn)
    fg.d3ReheatSimulation?.()
    return () => {
      fg.d3Force('themeCluster', null as unknown as ForceFn)
    }
  }, [graphData, themeClusterPositions])

  const handleNodeClick = useCallback(
    (node: MemoryNode) => {
      onNavigate(`/recordings/${node.id}`)
    },
    [onNavigate]
  )

  const handleNodeRightClick = useCallback((node: MemoryNode) => {
    setSelectedId(node.id)
    getRelatedMemories(node.id, 8).then((res) => setRelated(res.items.map((i) => ({ memory: i.memory, score: i.score }))))
    setTrail([])
  }, [])

  const buildTrail = useCallback(() => {
    if (!selectedId || !graph) return
    const edges = graph.edges
    const idSet = new Set(graph.nodes.map((n) => n.id))
    const steps = 3
    const path: string[] = [selectedId]
    let current = selectedId
    for (let i = 0; i < steps; i++) {
      const next = edges.find((e) => e.source === current && idSet.has(e.target))?.target
        ?? edges.find((e) => e.target === current && idSet.has(e.source))?.source
      if (!next || path.includes(next)) break
      path.push(next)
      current = next
    }
    setTrail(path)
  }, [selectedId, graph])

  const nodeColor = useCallback((node: MemoryNode) => {
    const t = (node.themes ?? [])[0]
    return t ? themeToColor(t) : '#6b5344'
  }, [])

  const linkWidth = useCallback((link: GraphLink) => {
    return Math.max(0.5, Math.min(2, link.score * 2))
  }, [])

  const nodeCanvasObject = useCallback(
    (node: MemoryNode, ctx: CanvasRenderingContext2D, globalScale: number) => {
      const x = (node as { x?: number }).x ?? 0
      const y = (node as { y?: number }).y ?? 0
      const label = node.title?.trim() || node.id || 'Untitled'
      const fontSize = 10
      const padding = 6
      const maxTextWidth = 100
      ctx.font = `${fontSize}px sans-serif`
      let shortLabel = label
      if (ctx.measureText(label).width > maxTextWidth) {
        let n = label.length
        while (n > 0 && ctx.measureText(label.slice(0, n) + '…').width > maxTextWidth) n -= 1
        shortLabel = (n > 0 ? label.slice(0, n) + '…' : '…')
      }
      const h = fontSize + padding * 2
      const r = Math.max(12, Math.min(20, 8 + (globalScale > 1 ? 4 : 0)))
      ctx.beginPath()
      ctx.arc(x, y, r, 0, 2 * Math.PI)
      ctx.fillStyle = nodeColor(node)
      ctx.fill()
      ctx.strokeStyle = 'rgba(255,255,255,0.4)'
      ctx.lineWidth = 1
      ctx.stroke()
      ctx.fillStyle = 'rgba(24,21,18,0.9)'
      ctx.font = `${fontSize}px sans-serif`
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText(shortLabel, x, y + r + h / 2 + 2)
    },
    [nodeColor]
  )

  if (loading) {
    return (
      <div className="view-shell memory-map-view">
        <div className="memory-map-loading">
          <p className="meta">Loading Memory Map...</p>
        </div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="view-shell memory-map-view">
        <div className="memory-map-error panel">
          <p className="error-text">{error}</p>
          <button type="button" className="btn btn-primary" onClick={fetchGraph}>Retry</button>
        </div>
      </div>
    )
  }

  if (!graph || graph.nodes.length === 0) {
    return (
      <div className="view-shell memory-map-view">
        <div className="memory-map-empty panel">
          <p className="meta">No memories to map. Transcribe some stories to see connections.</p>
          <button type="button" className="btn btn-primary" onClick={() => onNavigate('/record')}>Record</button>
        </div>
      </div>
    )
  }

  return (
    <div className="view-shell memory-map-view">
      <div className="memory-map-toolbar">
        <label className="memory-map-theme-label">
          Theme:
          <select
            className="memory-map-theme-select"
            value={themeFilter}
            onChange={(e) => setThemeFilter(e.target.value)}
            aria-label="Filter by theme"
          >
            <option value="">All themes</option>
            {themes.map((t) => (
              <option key={t} value={t}>{t}</option>
            ))}
          </select>
        </label>
        {selectedId ? (
          <>
            <button type="button" className="btn btn-secondary memory-map-trail-btn" onClick={buildTrail}>
              Build trail from selected
            </button>
            <button type="button" className="btn btn-secondary" onClick={() => { setSelectedId(null); setRelated([]); setTrail([]); }}>
              Clear selection
            </button>
          </>
        ) : null}
      </div>
      <div className="memory-map-graph-wrap" ref={graphWrapRef}>
        <ForceGraph2D
          ref={fgRef}
          graphData={graphData}
          nodeId="id"
          nodeLabel={(n) => (n as MemoryNode).title ?? n.id}
          nodeColor={nodeColor}
          nodeRelSize={6}
          nodeCanvasObjectMode="replace"
          nodeCanvasObject={nodeCanvasObject}
          linkSource="source"
          linkTarget="target"
          linkWidth={linkWidth}
          linkDirectionalArrowLength={0}
          onNodeClick={(n) => handleNodeClick(n as MemoryNode)}
          onNodeRightClick={(node, event) => { event.preventDefault(); handleNodeRightClick(node as MemoryNode); }}
          width={graphSize.width}
          height={graphSize.height}
          backgroundColor="rgba(255,255,255,0.02)"
          d3VelocityDecay={0.35}
          cooldownTicks={100}
          cooldownTime={3000}
        />
      </div>
      {(related.length > 0 || trail.length > 0) && (
        <div className="memory-map-sidebar panel">
          {related.length > 0 && (
            <div className="memory-map-related">
              <h3>Related stories</h3>
              <ul className="memory-map-related-list">
                {related.map(({ memory, score }) => (
                  <li key={memory.id}>
                    <button
                      type="button"
                      className="memory-map-related-item"
                      onClick={() => onNavigate(`/recordings/${memory.id}`)}
                    >
                      {memory.cover_path ? (
                        <img src={toAssetUrl(`/covers/${memory.id}.svg`)} alt="" className="memory-map-related-cover" />
                      ) : (
                        <div className="memory-map-related-cover placeholder">No cover</div>
                      )}
                      <span className="memory-map-related-title">{memory.title}</span>
                      <span className="memory-map-related-score">{score.toFixed(2)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {trail.length > 0 && (
            <div className="memory-map-trail">
              <h3>Narrative trail</h3>
              <ol className="memory-map-trail-list">
                {trail.map((id, idx) => {
                  const node = graphData.nodes.find((n) => n.id === id)
                  return (
                    <li key={id}>
                      <button
                        type="button"
                        className="memory-map-trail-item"
                        onClick={() => node && onNavigate(`/recordings/${id}`)}
                      >
                        {idx + 1}. {node?.title ?? id}
                      </button>
                    </li>
                  )
                })}
              </ol>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
