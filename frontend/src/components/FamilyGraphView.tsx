import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { forceCollide, forceX, forceY } from 'd3-force-3d'
import ForceGraph2D from 'react-force-graph-2d'
import { addPersonWithEdge, createFamilyEdge, getFamilyTree } from '../api'
import type { FamilyTree } from '../types'

type GraphNode = {
  id: string
  label: string
  isElder: boolean
  generationLevel: number
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

function drawSquircle(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const left = x - w / 2
  const top = y - h / 2
  const right = x + w / 2
  const bottom = y + h / 2
  const radius = Math.min(r, w / 2, h / 2)

  ctx.beginPath()
  ctx.moveTo(left + radius, top)
  ctx.lineTo(right - radius, top)
  ctx.quadraticCurveTo(right, top, right, top + radius)
  ctx.lineTo(right, bottom - radius)
  ctx.quadraticCurveTo(right, bottom, right - radius, bottom)
  ctx.lineTo(left + radius, bottom)
  ctx.quadraticCurveTo(left, bottom, left, bottom - radius)
  ctx.lineTo(left, top + radius)
  ctx.quadraticCurveTo(left, top, left + radius, top)
  ctx.closePath()
}

function ellipsizeLabel(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
  if (ctx.measureText(text).width <= maxWidth) return text
  let out = text
  while (out.length > 1 && ctx.measureText(`${out}…`).width > maxWidth) {
    out = out.slice(0, -1)
  }
  return `${out}…`
}

function estimateNodeWidth(label: string): number {
  return Math.min(170, Math.max(84, 54 + label.length * 5.3))
}

function collisionRadius(node: GraphNode): number {
  const width = estimateNodeWidth(node.label || '')
  const height = node.isElder ? 42 : 38
  const diagonal = Math.sqrt(width * width + height * height)
  return diagonal * 0.52 + 8
}

export function FamilyGraphView({ familyId, onBack }: FamilyGraphViewProps) {
  const [tree, setTree] = useState<FamilyTree | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [actionError, setActionError] = useState('')
  const [actionNotice, setActionNotice] = useState('')
  const [selectedPersonId, setSelectedPersonId] = useState('')
  const [actionMode, setActionMode] = useState<'' | 'existing' | 'new'>('')
  const [existingTargetId, setExistingTargetId] = useState('')
  const [existingRelation, setExistingRelation] = useState<'child' | 'parent' | 'partner'>('child')
  const [existingRelationshipType, setExistingRelationshipType] = useState<
    'biological' | 'adoptive' | 'step' | 'guardian' | 'unknown'
  >('unknown')
  const [existingPartnerType, setExistingPartnerType] = useState<'married' | 'partner' | 'divorced' | 'separated' | 'unknown'>(
    'unknown'
  )
  const [existingCertainty, setExistingCertainty] = useState<'certain' | 'estimated' | 'unknown'>('unknown')
  const [linkingExisting, setLinkingExisting] = useState(false)
  const [newRelativeName, setNewRelativeName] = useState('')
  const [newRelationship, setNewRelationship] = useState<'child' | 'parent' | 'partner' | 'sibling'>('child')
  const [newRelationshipType, setNewRelationshipType] = useState<
    'biological' | 'adoptive' | 'step' | 'guardian' | 'unknown'
  >('unknown')
  const [newPartnerType, setNewPartnerType] = useState<'married' | 'partner' | 'divorced' | 'separated' | 'unknown'>(
    'unknown'
  )
  const [newCertainty, setNewCertainty] = useState<'certain' | 'estimated' | 'unknown'>('unknown')
  const [addingMember, setAddingMember] = useState(false)
  const graphWrapRef = useRef<HTMLDivElement>(null)
  const graphRef = useRef<{
    d3ReheatSimulation: () => void
    refresh: () => void
  } | null>(null)
  const [graphSize, setGraphSize] = useState({ width: 600, height: 420 })
  const TIER_SPACING = 128

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
    if (!tree) return
    setSelectedPersonId((prev) => (prev && tree.people.some((p) => p.id === prev) ? prev : tree.elder_person_id))
    setActionMode('')
  }, [tree])

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

    const levels = new Map<string, number>([[tree.elder_person_id, 0]])
    const queue: string[] = [tree.elder_person_id]
    while (queue.length > 0) {
      const current = queue.shift() as string
      const level = levels.get(current) ?? 0
      for (const edge of tree.edges) {
        if (edge.kind === 'parent_child') {
          if (edge.from_person_id === current && !levels.has(edge.to_person_id)) {
            levels.set(edge.to_person_id, level + 1)
            queue.push(edge.to_person_id)
          }
          if (edge.to_person_id === current && !levels.has(edge.from_person_id)) {
            levels.set(edge.from_person_id, level - 1)
            queue.push(edge.from_person_id)
          }
        } else {
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

    const nodes: GraphNode[] = tree.people.map((person) => ({
      id: person.id,
      label: person.display_name || person.id,
      isElder: person.id === tree.elder_person_id,
      generationLevel: levels.get(person.id) ?? 99,
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
          d3Force: (name: string, force?: unknown) => unknown
          d3ReheatSimulation: () => void
          refresh: () => void
        }
      | null

    const linkForce = graph?.d3Force('link') as
      | { distance?: (fn: (link: GraphLink) => void | number) => void; strength?: (fn: (link: GraphLink) => void | number) => void }
      | null
    if (!linkForce) return

    linkForce.distance?.((link: GraphLink) => (link.kind === 'partner' ? 96 : 105))
    linkForce.strength?.((link: GraphLink) => (link.kind === 'partner' ? 0.92 : 0.58))
    graph?.d3Force(
      'y',
      forceY<GraphNode>((node: GraphNode) =>
        node.generationLevel === 99
          ? graphSize.height / 2 + TIER_SPACING * 3
          : graphSize.height / 2 + node.generationLevel * TIER_SPACING
      ).strength(0.24)
    )
    graph?.d3Force('x', forceX<GraphNode>(graphSize.width / 2).strength(0.06))
    graph?.d3Force('collide', forceCollide<GraphNode>((node: GraphNode) => collisionRadius(node)).iterations(3))
    graph?.d3ReheatSimulation()
  }, [graphData, graphSize.height, graphSize.width])

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

  useEffect(() => {
    if (!selectedPersonId) return
    let rafId = 0
    const tick = () => {
      graphRef.current?.refresh()
      rafId = window.requestAnimationFrame(tick)
    }
    rafId = window.requestAnimationFrame(tick)
    return () => window.cancelAnimationFrame(rafId)
  }, [selectedPersonId])

  const selectedPerson = useMemo(
    () => tree?.people.find((person) => person.id === selectedPersonId) || null,
    [tree, selectedPersonId]
  )

  async function refreshTreeKeepSelection() {
    const updated = await getFamilyTree(familyId)
    setTree(updated)
    setSelectedPersonId((prev) => (prev && updated.people.some((p) => p.id === prev) ? prev : updated.elder_person_id))
  }

  async function submitLinkExisting(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!selectedPerson || !existingTargetId) return
    if (existingTargetId === selectedPerson.id) {
      setActionError('Choose two different members.')
      return
    }
    setLinkingExisting(true)
    setActionError('')
    setActionNotice('')
    try {
      const fromId =
        existingRelation === 'child' || existingRelation === 'partner' ? selectedPerson.id : existingTargetId
      const toId = existingRelation === 'child' ? existingTargetId : existingRelation === 'parent' ? selectedPerson.id : existingTargetId
      const kind = existingRelation === 'partner' ? 'partner' : 'parent_child'

      await createFamilyEdge(familyId, {
        kind,
        from_person_id: fromId,
        to_person_id: toId,
        relationship_type: kind === 'parent_child' ? existingRelationshipType : 'unknown',
        partner_type: kind === 'partner' ? existingPartnerType : 'unknown',
        certainty: existingCertainty,
      })
      await refreshTreeKeepSelection()
      setExistingTargetId('')
      setActionNotice('Relationship created.')
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to create relationship')
    } finally {
      setLinkingExisting(false)
    }
  }

  async function submitAddRelative(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!selectedPerson || !newRelativeName.trim()) return
    setAddingMember(true)
    setActionError('')
    setActionNotice('')
    try {
      await addPersonWithEdge(familyId, {
        display_name: newRelativeName.trim(),
        connect_to_person_id: selectedPerson.id,
        relationship: newRelationship,
        relationship_type: newRelationshipType,
        partner_type: newPartnerType,
        certainty: newCertainty,
      })
      await refreshTreeKeepSelection()
      setNewRelativeName('')
      setNewRelationship('child')
      setNewRelationshipType('unknown')
      setNewPartnerType('unknown')
      setNewCertainty('unknown')
      setActionNotice('Family member added and linked.')
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to add family member')
    } finally {
      setAddingMember(false)
    }
  }

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
        <p className="meta">Generations are tiered vertically from the elder anchor. Drag nodes to organize within tiers.</p>
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
        <div className="family-graph-main">
          <div className="family-graph-wrap" ref={graphWrapRef}>
            <ForceGraph2D
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            ref={graphRef as any}
            graphData={graphData}
            nodeId="id"
            nodeLabel={(n) => (n as GraphNode).label}
            nodeRelSize={19}
            nodeColor={(n) => ((n as GraphNode).isElder ? '#c9730c' : '#3e5f7d')}
            nodeCanvasObjectMode={() => 'replace'}
            nodeCanvasObject={(node, ctx, globalScale) => {
              const n = node as GraphNode
              const x = n.x ?? 0
              const y = n.y ?? 0
              const label = n.label || ''
              const fontSize = (n.isElder ? 12.4 : 11.8) / globalScale
              const nodeHeight = (n.isElder ? 42 : 38) / globalScale
              const nodeWidth = estimateNodeWidth(label) / globalScale
              const cornerRadius = nodeHeight * 0.34
              const isSelected = n.id === selectedPersonId
              const baseColor = n.isElder ? '#c9730c' : '#3e5f7d'
              ctx.font = `600 ${fontSize}px "Avenir Next", "SF Pro Text", "Segoe UI", sans-serif`

              if (isSelected) {
                const pulse = (Math.sin(performance.now() / 260) + 1) / 2
                const glowExpand = (8 + pulse * 6) / globalScale
                const glowAlpha = 0.16 + pulse * 0.2
                ctx.save()
                drawSquircle(ctx, x, y, nodeWidth + glowExpand * 2, nodeHeight + glowExpand * 2, cornerRadius + glowExpand)
                ctx.fillStyle = `rgba(255, 190, 90, ${glowAlpha})`
                ctx.shadowColor = 'rgba(255, 178, 66, 0.85)'
                ctx.shadowBlur = 14 + pulse * 10
                ctx.fill()
                ctx.restore()
              }

              const top = y - nodeHeight / 2
              const bottom = y + nodeHeight / 2
              const frosted = ctx.createLinearGradient(x, top, x, bottom)
              frosted.addColorStop(0, 'rgba(255, 255, 255, 0.52)')
              frosted.addColorStop(1, 'rgba(255, 255, 255, 0.18)')

              const tint = ctx.createLinearGradient(x, top, x, bottom)
              if (n.isElder) {
                tint.addColorStop(0, 'rgba(236, 159, 22, 0.8)')
                tint.addColorStop(1, 'rgba(194, 110, 7, 0.74)')
              } else {
                tint.addColorStop(0, 'rgba(87, 142, 186, 0.72)')
                tint.addColorStop(1, 'rgba(54, 95, 132, 0.68)')
              }

              ctx.save()
              drawSquircle(ctx, x, y, nodeWidth, nodeHeight, cornerRadius)
              ctx.shadowColor = 'rgba(24, 20, 14, 0.22)'
              ctx.shadowBlur = 10 / globalScale
              ctx.fillStyle = frosted
              ctx.fill()
              ctx.restore()

              drawSquircle(ctx, x, y, nodeWidth, nodeHeight, cornerRadius)
              ctx.fillStyle = tint
              ctx.fill()

              if (isSelected) {
                drawSquircle(ctx, x, y, nodeWidth + (4 / globalScale), nodeHeight + (4 / globalScale), cornerRadius + (2 / globalScale))
                ctx.strokeStyle = '#ffd173'
                ctx.lineWidth = 2.2 / globalScale
                ctx.stroke()
              }

              drawSquircle(ctx, x, y, nodeWidth, nodeHeight, cornerRadius)
              ctx.strokeStyle = 'rgba(255, 255, 255, 0.62)'
              ctx.lineWidth = 1.1 / globalScale
              ctx.stroke()

              ctx.textAlign = 'center'
              ctx.textBaseline = 'middle'
              ctx.fillStyle = '#fffefb'
              const clipped = ellipsizeLabel(ctx, label, nodeWidth - (20 / globalScale))
              ctx.fillText(clipped, x, y + 0.4 / globalScale)
            }}
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
            onNodeClick={(node) => {
              setSelectedPersonId((node as GraphNode).id)
              setActionMode('')
            }}
            width={graphSize.width}
            height={graphSize.height}
            backgroundColor="rgba(255,255,255,0.03)"
            />
          </div>
          <aside className="family-graph-side">
            <h3>Member Details</h3>
            {!selectedPerson ? <p className="meta">Click a node to inspect this member.</p> : null}
            {selectedPerson ? (
              <div className="family-graph-member">
                <strong>{selectedPerson.display_name}</strong>
                <p className="meta">{selectedPerson.is_elder_root ? 'Elder Root' : 'Family Member'}</p>
                <p className="meta">{selectedPerson.birth_year ? `Born ${selectedPerson.birth_year}` : 'Birth year unknown'}</p>
                {selectedPerson.notes ? <p className="meta">{selectedPerson.notes}</p> : null}
              </div>
            ) : null}

            {actionNotice ? <p className="status-banner success">{actionNotice}</p> : null}
            {actionError ? <p className="error-text">{actionError}</p> : null}

            {selectedPerson ? (
              <div className="family-graph-action-choice">
                <p className="meta">For {selectedPerson.display_name}, what would you like to do?</p>
                <div className="family-graph-action-buttons">
                  <button
                    type="button"
                    className={`family-graph-choice-btn ${actionMode === 'new' ? 'active' : ''}`}
                    onClick={() => setActionMode('new')}
                  >
                    Add New Family Member
                  </button>
                  <button
                    type="button"
                    className={`family-graph-choice-btn ${actionMode === 'existing' ? 'active' : ''}`}
                    onClick={() => setActionMode('existing')}
                  >
                    Create Relationship
                  </button>
                </div>
              </div>
            ) : null}

            {selectedPerson && actionMode === 'existing' ? (
              <form className="family-graph-form" onSubmit={submitLinkExisting}>
                <h4>Create Relationship</h4>
                <select
                  className="title-input"
                  value={existingTargetId}
                  onChange={(e) => setExistingTargetId(e.target.value)}
                >
                  <option value="">Select member...</option>
                  {tree?.people
                    .filter((person) => person.id !== selectedPerson.id)
                    .map((person) => (
                      <option key={person.id} value={person.id}>
                        {person.display_name}
                      </option>
                    ))}
                </select>
                <select
                  className="title-input"
                  value={existingRelation}
                  onChange={(e) => setExistingRelation(e.target.value as 'child' | 'parent' | 'partner')}
                >
                  <option value="child">Selected is parent of target</option>
                  <option value="parent">Selected is child of target</option>
                  <option value="partner">Selected is partner of target</option>
                </select>
                {existingRelation !== 'partner' ? (
                  <select
                    className="title-input"
                    value={existingRelationshipType}
                    onChange={(e) =>
                      setExistingRelationshipType(
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
                    value={existingPartnerType}
                    onChange={(e) =>
                      setExistingPartnerType(
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
                  value={existingCertainty}
                  onChange={(e) => setExistingCertainty(e.target.value as 'certain' | 'estimated' | 'unknown')}
                >
                  <option value="unknown">Certainty: unknown</option>
                  <option value="certain">Certain</option>
                  <option value="estimated">Estimated</option>
                </select>
                <button type="submit" className="record-save-button" disabled={linkingExisting || !existingTargetId}>
                  {linkingExisting ? 'Creating...' : 'Create Relationship'}
                </button>
              </form>
            ) : null}

            {selectedPerson && actionMode === 'new' ? (
              <form className="family-graph-form" onSubmit={submitAddRelative}>
                <h4>Add Family Member</h4>
                <input
                  type="text"
                  className="title-input"
                  placeholder="Name"
                  value={newRelativeName}
                  onChange={(e) => setNewRelativeName(e.target.value)}
                />
                <select
                  className="title-input"
                  value={newRelationship}
                  onChange={(e) => setNewRelationship(e.target.value as 'child' | 'parent' | 'partner' | 'sibling')}
                >
                  <option value="child">Child of selected</option>
                  <option value="parent">Parent of selected</option>
                  <option value="partner">Partner of selected</option>
                  <option value="sibling">Sibling of selected</option>
                </select>
                {newRelationship !== 'partner' ? (
                  <select
                    className="title-input"
                    value={newRelationshipType}
                    onChange={(e) =>
                      setNewRelationshipType(
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
                    value={newPartnerType}
                    onChange={(e) =>
                      setNewPartnerType(e.target.value as 'married' | 'partner' | 'divorced' | 'separated' | 'unknown')
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
                  value={newCertainty}
                  onChange={(e) => setNewCertainty(e.target.value as 'certain' | 'estimated' | 'unknown')}
                >
                  <option value="unknown">Certainty: unknown</option>
                  <option value="certain">Certain</option>
                  <option value="estimated">Estimated</option>
                </select>
                <button type="submit" className="record-save-button" disabled={addingMember || !newRelativeName.trim()}>
                  {addingMember ? 'Adding...' : 'Add Member'}
                </button>
              </form>
            ) : null}
          </aside>
        </div>
      </section>
    </div>
  )
}
