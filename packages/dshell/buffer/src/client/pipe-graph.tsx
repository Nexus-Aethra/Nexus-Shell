/**
 * The pipe graph: sessions as nodes, established pipes as edges, drawn with
 * React Flow (@xyflow/react) so the graph is a real working surface — nodes
 * drag, dragging from one node's handle to another creates the pipe for real
 * (through the same authority-checked service the list view uses), and a
 * selected edge offers detail and release.
 *
 * The graph is an undirected picture of the data: React Flow edges carry a
 * source and a target internally, but no arrowheads are drawn and creation
 * works from either end, so the rendering reads as the symmetric relation the
 * links are.
 */

import {
  Background, Handle, Position, ReactFlow, ReactFlowProvider,
  type Edge, type Node, type NodeChange, type NodeProps,
} from '@xyflow/react'
import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactElement } from 'react'
import type { BufferLink, BufferTicket } from '../protocol.js'
import { FLOW_CSS } from './flow-css.js'

/** One session node's data as the graph renders it. */
export interface GraphSession {
  readonly id: string
  readonly label: string
  readonly sub: string | undefined
  /** Whether the session currently has a running turn. */
  readonly active: boolean
  /** Whether the session hosts this browser's current view. */
  readonly current: boolean
}

/** The graph's props: derived data plus the three actions a real surface needs. */
export interface PipeGraphProps {
  readonly sessions: readonly GraphSession[]
  readonly links: readonly BufferLink[]
  readonly tickets: readonly BufferTicket[]
  /** Create a pipe for real; the caller owns validation feedback. */
  readonly onConnect: (a: string, b: string) => void
  /** Release one pipe for real. */
  readonly onUnlink: (linkId: string) => void
  /** Open a pipe's ticket detail (in the list pane). */
  readonly onOpenDetail: (linkId: string) => void
}

const nodeStyle: CSSProperties = {
  minWidth: 150,
  border: '0.5px solid var(--dsw-alias-border-l4)',
  borderRadius: 10,
  background: 'var(--dsw-alias-bg-layer-2)',
  color: 'var(--dsw-alias-label-primary)',
  fontSize: 12,
  padding: '7px 10px',
  boxShadow: '0 2px 10px rgba(0,0,0,.25)',
}
const nodeActiveStyle: CSSProperties = {
  ...nodeStyle,
  borderColor: 'var(--dsw-static-deepseek-500, #4f6bed)',
}
const nodeTitleStyle: CSSProperties = {
  fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
}
const nodeSubStyle: CSSProperties = {
  fontSize: 11, opacity: 0.6, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
}
const handleStyle: CSSProperties = {
  width: 9, height: 9, background: 'var(--dsw-alias-label-tertiary)',
  border: 'none',
}

/** One session node: title, optional cwd line, an active dot, two handles. */
function SessionNode(props: NodeProps): ReactElement {
  const data = props.data as {
    label: string; sub: string | undefined; active: boolean; current: boolean
  }
  return (
    <div style={data.active ? nodeActiveStyle : nodeStyle}>
      <Handle type="target" position={Position.Top} style={handleStyle} />
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        {data.current
          ? <span title="当前会话" style={{
            width: 7, height: 7, borderRadius: 999, flex: '0 0 auto',
            background: 'var(--dsw-static-deepseek-500, #4f6bed)',
          }} />
          : null}
        <span style={nodeTitleStyle}>{data.label}</span>
      </div>
      {data.sub === undefined ? null : <div style={nodeSubStyle}>{data.sub}</div>}
      <Handle type="source" position={Position.Bottom} style={handleStyle} />
    </div>
  )
}

const nodeTypes = { session: SessionNode }

/** localStorage key for the user's node arrangement. */
const POSITIONS_KEY = 'dshell-pipe-graph-positions'

type NodePositions = Record<string, { x: number; y: number }>

/**
 * The arrangement the user dragged nodes into, kept across dialog opens.
 *
 * localStorage is the right home rather than the host state document: this is
 * one browser's view preference, not shared feature state, and the graph must
 * still render when the store is unavailable.
 */
function loadPositions(): NodePositions {
  try {
    const raw = localStorage.getItem(POSITIONS_KEY)
    if (raw === null) return {}
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return {}
    const out: NodePositions = {}
    for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (
        typeof value === 'object' && value !== null
        && typeof (value as { x?: unknown }).x === 'number'
        && typeof (value as { y?: unknown }).y === 'number'
      ) {
        const { x, y } = value as { x: number; y: number }
        out[id] = { x, y }
      }
    }
    return out
  } catch {
    return {}
  }
}

function savePositions(positions: NodePositions): void {
  try {
    localStorage.setItem(POSITIONS_KEY, JSON.stringify(positions))
  } catch { /* a store that refuses writes just means no memory */ }
}

/** Count a link's unsettled tickets, for the animated-edge signal. */
function openCount(tickets: readonly BufferTicket[], linkId: string): number {
  return tickets.filter(ticket => ticket.linkId === linkId
    && (ticket.state === 'queued' || ticket.state === 'running')).length
}

/** The graph pane. Wrap with {@link PipeGraphProvider} at the call site. */
function PipeGraphInner(props: PipeGraphProps): ReactElement {
  const [positions, setPositions] = useState<NodePositions>(loadPositions)
  // Mirror for the drag-stop handler, which needs the live map to persist the
  // merged arrangement without reading state inside a state updater.
  const positionsRef = useRef(positions)
  positionsRef.current = positions
  // The selected edge: clicking one highlights it and floats the action chip.
  const [selected, setSelected] = useState<string | undefined>(undefined)
  // Inject React Flow's stylesheet once: the bundle loader mounts only this
  // package's client.js, so a sibling css file would never reach the page.
  useEffect(() => {
    if (document.querySelector('style[data-dshell-flow-css]') !== null) return
    const style = document.createElement('style')
    style.setAttribute('data-dshell-flow-css', '')
    style.textContent = FLOW_CSS
    document.head.append(style)
  }, [])

  // Ring layout for sessions the user has not dragged yet: even angles, a
  // radius that grows with the count so labels never overlap.
  const nodes = useMemo<Node[]>(() => props.sessions.map((session, index) => {
    const count = props.sessions.length
    const radius = Math.max(190, count * 46)
    const angle = -Math.PI / 2 + (2 * Math.PI * index) / Math.max(1, count)
    const fallback = { x: Math.round(radius * Math.cos(angle)), y: Math.round(radius * Math.sin(angle) * 0.78) }
    return {
      id: session.id,
      type: 'session',
      position: positions[session.id] ?? fallback,
      data: { label: session.label, sub: session.sub, active: session.active, current: session.current },
    }
  }), [props.sessions, positions])

  const edges = useMemo<Edge[]>(() => props.links.map(link => {
    const open = openCount(props.tickets, link.id)
    return {
      id: link.id,
      source: link.a,
      target: link.b,
      type: 'straight',
      selected: selected === link.id,
      label: `${link.label ?? '管道'}${open > 0 ? ` · ${String(open)} 单` : ''}`,
      animated: open > 0,
      style: {
        stroke: selected === link.id
          ? 'var(--dsw-static-deepseek-300, #7d9bff)'
          : open > 0 ? 'var(--dsw-static-deepseek-500, #4f6bed)' : 'var(--dsw-alias-border-l3)',
        strokeWidth: selected === link.id || open > 0 ? 2 : 1.2,
      },
      labelStyle: { fill: 'var(--dsw-alias-label-secondary)', fontSize: 11 },
      labelBgStyle: { fill: 'var(--dsw-alias-bg-layer-2)' },
    }
  }), [props.links, props.tickets, selected])

  const onNodesChange = (changes: NodeChange[]): void => {
    // Only drags matter here: the node set is derived from the snapshot, so a
    // removed/added node recomposes on the next render anyway. Positions are
    // the one piece of local state — the user's arrangement outlives polls,
    // and the drop event (below) also writes it to localStorage.
    setPositions(current => {
      let changed = false
      const next = { ...current }
      for (const change of changes) {
        if (change.type === 'position' && change.position !== undefined) {
          next[change.id] = change.position
          changed = true
        }
      }
      return changed ? next : current
    })
  }

  /** A drop ends the drag: persist the arrangement, pruned to current sessions. */
  const onNodeDragStop = (_event: unknown, node: Node): void => {
    const keep = new Set(props.sessions.map(session => session.id))
    const next: NodePositions = {}
    for (const [id, position] of Object.entries(positionsRef.current)) {
      if (keep.has(id)) next[id] = position
    }
    next[node.id] = node.position
    positionsRef.current = next
    savePositions(next)
  }

  return (
    <div style={{ position: 'absolute', inset: 0 }}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        colorMode='dark'
        fitView
        fitViewOptions={{ padding: 0.35 }}
        minZoom={0.4}
        maxZoom={1.6}
        nodesConnectable
        onNodesChange={onNodesChange}
        onNodeDragStop={onNodeDragStop}
        onConnect={(connection) => {
          if (connection.source === undefined || connection.target === undefined) return
          if (connection.source === connection.target) return
          props.onConnect(connection.source, connection.target)
        }}
        onEdgeClick={(_, edge) => { setSelected(current => (current === edge.id ? undefined : edge.id)) }}
        onPaneClick={() => { setSelected(undefined) }}
        proOptions={{ hideAttribution: true }}
      >
        <Background color='var(--dsw-alias-border-l3)' gap={22} />
      </ReactFlow>
      {selected === undefined ? null : (
        <div style={chipStyle}>
          <span style={chipDimStyle}>已选中管道</span>
          <button style={chipButtonStyle} onClick={() => { props.onOpenDetail(selected) }}>详情</button>
          <button
            style={chipButtonStyle}
            onClick={() => { props.onUnlink(selected); setSelected(undefined) }}
          >解除</button>
          <button style={chipButtonStyle} onClick={() => { setSelected(undefined) }}>✕</button>
        </div>
      )}
      <div style={resetStyle}>
        <button
          style={chipButtonStyle}
          title='清空记忆的节点位置，全部回到环形排布'
          onClick={() => {
            try { localStorage.removeItem(POSITIONS_KEY) } catch { /* same as empty */ }
            setPositions({})
          }}
        >重置布局</button>
      </div>
    </div>
  )
}

const chipStyle: CSSProperties = {
  position: 'absolute', top: 10, right: 10, zIndex: 5,
  display: 'flex', alignItems: 'center', gap: 6,
  border: '0.5px solid var(--dsw-alias-border-l4)',
  borderRadius: 8,
  background: 'var(--dsw-alias-bg-layer-2)',
  padding: '5px 8px', fontSize: 12,
  color: 'var(--dsw-alias-label-primary)',
  boxShadow: '0 4px 14px rgba(0,0,0,.3)',
}
const chipDimStyle: CSSProperties = { opacity: 0.6, marginRight: 2 }
const chipButtonStyle: CSSProperties = {
  border: '0.5px solid var(--dsw-alias-border-l4)', background: 'transparent', color: 'inherit',
  cursor: 'pointer', fontSize: 12, padding: '2px 8px', borderRadius: 6,
}
const resetStyle: CSSProperties = {
  position: 'absolute', bottom: 10, right: 10, zIndex: 5,
  border: '0.5px solid var(--dsw-alias-border-l4)',
  borderRadius: 8,
  background: 'var(--dsw-alias-bg-layer-2)',
  padding: '3px 6px',
  boxShadow: '0 4px 14px rgba(0,0,0,.3)',
}

/** The graph pane with the provider React Flow needs for measured layout. */
export function PipeGraph(props: PipeGraphProps): ReactElement {
  return <ReactFlowProvider><PipeGraphInner {...props} /></ReactFlowProvider>
}
