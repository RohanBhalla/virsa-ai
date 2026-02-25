import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import ForceGraph2D from 'react-force-graph-2d'
import { getFamilyTree } from '../api'
import type { FamilyTree } from '../types'

type GraphNode = {
  id: string
  label: string
  isElder: boolean
  x?: number
  y?: number
  vx?: number
  vy?: number
  fx?: number
  fy?: number
}

type GraphLink = {
  id: string
  source: string
  target: string
  kind: 'parent_child' | 'partner'
  relationshipType: 'biological' | 'adoptive' | 'step' | 'guardian' | 'unknown'
  partnerType: 'married' | 'partner' | 'divorced' | 'separated' | 'unknown'
  certainty: 'certain' | 'estimated' | 'unknown'
}

interface FamilyGraphViewProps {
  familyId: string
  onBack: () => void
}

type StoredPos = Record<string, { x: number; y: number }>

function layoutStorageKey(familyId: string): string {
  return `family_graph_layout:${familyId}`
}

export function FamilyGraphView({ familyId, onBack }: FamilyGraphViewProps) {
  const [tree, setTree] = useState<FamilyTree | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const graphWrapRef = useRef<HTMLDivElement>(null)
  const graphRef = useRef<{
    d3ReheatSimulation: () => void
  } | null>(null)
  const [graphSize, setGraphSize] = useState({ width: 600, height: 420 })

  const parentChildColorByType: Record<GraphLink['relationshipType'], string> = {
    biological: '#2f8f5b',
    adoptive: '#1f6fb2',
    step: '#b86a1b',
    guardian: '#6a4d9a',
    unknown: '#6f5f4a',
  }

  const partnerColorByType: Record<GraphLink['partnerType'], string> = {
    married: '#b0176b',
    partner: '#8b2f95',
    separated: '#b36b00',
    divorced: '#9b1b2b',
    unknown: '#9b4c8a',
  }

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError('')
    getFamilyTree(familyId)
      .then((data) => {
        if (!cancelled) setTree(data)
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load family graph')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [familyId])

  useEffect(() => {
    if (loading) return
    const wrap = graphWrapRef.current
    if (!wrap) return
    const update = () => {
      const w = Math.max(260, wrap.clientWidth)
      const h = Math.max(300, wrap.clientHeight)
      setGraphSize({ width: w, height: h })
    }
    const rafId = window.requestAnimationFrame(update)
    const ro = new ResizeObserver(update)
    ro.observe(wrap)
    return () => {
      window.cancelAnimationFrame(rafId)
      ro.disconnect()
    }
  }, [loading])

  const graphData = useMemo(() => {
    if (!tree) return { nodes: [] as GraphNode[], links: [] as GraphLink[] }
    let stored: StoredPos = {}
    try {
      const raw = localStorage.getItem(layoutStorageKey(familyId))
      stored = raw ? (JSON.parse(raw) as StoredPos) : {}
    } catch {
      stored = {}
    }

    const nodes: GraphNode[] = tree.people.map((person) => ({
      id: person.id,
      label: person.display_name || person.id,
      isElder: person.id === tree.elder_person_id,
      x: stored[person.id]?.x,
      y: stored[person.id]?.y,
    }))
    const links: GraphLink[] = tree.edges.map((edge) => ({
      id: edge.id,
      source: edge.from_person_id,
      target: edge.to_person_id,
      kind: edge.kind,
      relationshipType: edge.relationship_type || 'unknown',
      partnerType: edge.partner_type || 'unknown',
      certainty: edge.certainty || 'unknown',
    }))
    return { nodes, links }
  }, [tree, familyId])

  useEffect(() => {
    const graph = graphRef.current as
      | {
          d3Force: (name: string) => {
            distance?: (fn: (link: GraphLink) => number) => void
            strength?: (fn: (link: GraphLink) => number) => void
          } | null
          d3ReheatSimulation: () => void
        }
      | null

    const linkForce = graph?.d3Force('link')
    if (!linkForce) return

    linkForce.distance?.((link: GraphLink) => (link.kind === 'partner' ? 55 : 105))
    linkForce.strength?.((link: GraphLink) => (link.kind === 'partner' ? 0.92 : 0.58))
    graph?.d3ReheatSimulation()
  }, [graphData])

  const edgeColor = useCallback(
    (link: GraphLink): string =>
      link.kind === 'partner'
        ? partnerColorByType[link.partnerType]
        : parentChildColorByType[link.relationshipType],
    [parentChildColorByType, partnerColorByType]
  )

  const edgeDash = useCallback((link: GraphLink): number[] | null => {
    if (link.certainty === 'certain') return null
    if (link.certainty === 'estimated') return [6, 4]
    return [2, 5]
  }, [])

  const saveLayout = useCallback(() => {
    if (!graphData.nodes.length) return
    const out: StoredPos = {}
    for (const node of graphData.nodes) {
      if (typeof node.x === 'number' && typeof node.y === 'number') {
        out[node.id] = { x: node.x, y: node.y }
      }
    }
    localStorage.setItem(layoutStorageKey(familyId), JSON.stringify(out))
  }, [graphData.nodes, familyId])

  const resetLayout = useCallback(() => {
    localStorage.removeItem(layoutStorageKey(familyId))
    graphRef.current?.d3ReheatSimulation()
  }, [familyId])

  if (loading) {
    return (
      <div className="view-shell family-graph-view">
        <section className="panel">
          <p className="meta">Loading family graph...</p>
        </section>
      </div>
    )
  }

  if (error) {
    return (
      <div className="view-shell family-graph-view">
        <section className="panel">
          <p className="error-text">{error}</p>
          <button type="button" className="btn btn-primary" onClick={onBack}>
            Back to Family Tree
          </button>
        </section>
      </div>
    )
  }

  return (
    <div className="view-shell family-graph-view">
      <section className="panel family-graph-panel">
        <div className="section-head">
          <h2>Family Graph</h2>
          <div className="family-graph-actions">
            <button type="button" className="btn" onClick={resetLayout}>
              Reset Layout
            </button>
            <button type="button" className="btn btn-primary" onClick={onBack}>
              Back to Family Tree
            </button>
          </div>
        </div>
        <p className="meta">Drag nodes to organize. Positions are saved for this family.</p>
        <div className="family-graph-legend">
          <span><i style={{ background: '#2f8f5b' }} />Parent-Child: Biological</span>
          <span><i style={{ background: '#1f6fb2' }} />Parent-Child: Adoptive</span>
          <span><i style={{ background: '#b86a1b' }} />Parent-Child: Step</span>
          <span><i style={{ background: '#6a4d9a' }} />Parent-Child: Guardian</span>
          <span><i style={{ background: '#b0176b' }} />Partner: Married</span>
          <span><i style={{ background: '#8b2f95' }} />Partner: Partner</span>
          <span><i style={{ background: '#9b1b2b' }} />Partner: Divorced</span>
          <span><i style={{ background: '#b36b00' }} />Partner: Separated</span>
          <span className="family-graph-legend-note">Dashed = estimated, dotted = unknown certainty</span>
        </div>
        <div className="family-graph-wrap" ref={graphWrapRef}>
          <ForceGraph2D
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            ref={graphRef as any}
            graphData={graphData}
            nodeId="id"
            nodeLabel={(n) => (n as GraphNode).label}
            nodeRelSize={15}
            nodeColor={(n) => ((n as GraphNode).isElder ? '#c9730c' : '#3e5f7d')}
            linkSource="source"
            linkTarget="target"
            linkColor={(l) => edgeColor(l as GraphLink)}
            linkWidth={(l) => ((l as GraphLink).kind === 'partner' ? 3.4 : 2.8)}
            linkLineDash={(l) => edgeDash(l as GraphLink)}
            linkDirectionalArrowLength={(l) => ((l as GraphLink).kind === 'partner' ? 0 : 4)}
            linkDirectionalArrowRelPos={1}
            linkDirectionalParticles={(l) => ((l as GraphLink).kind === 'partner' ? 0 : 1)}
            linkLabel={(l) => {
              const link = l as GraphLink
              return link.kind === 'partner'
                ? `Partner: ${link.partnerType} (${link.certainty})`
                : `Parent-Child: ${link.relationshipType} (${link.certainty})`
            }}
            d3AlphaDecay={0.035}
            d3VelocityDecay={0.32}
            onNodeDragEnd={() => saveLayout()}
            onEngineStop={() => saveLayout()}
            width={graphSize.width}
            height={graphSize.height}
            backgroundColor="rgba(255,255,255,0.03)"
          />
        </div>
      </section>
    </div>
  )
}
