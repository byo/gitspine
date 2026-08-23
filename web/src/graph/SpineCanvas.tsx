import { useCallback, useEffect, useRef, useState } from 'react'
import type { FeatureSubgraph, SpineNode } from '../api/types'
import {
  EXTERNAL_X,
  FEATURE_LABEL_W,
  FEATURE_LOADING_GAP,
  LANE_X,
  MERGE_R,
  NODE_R,
  RAIL_X,
  ROW,
  SUBJECT_MAX_W,
  SUBJECT_X,
  easeInOutCubic,
  hitTest,
  layoutSpine,
  type LayoutHit,
} from './layout'
import type { ExternalRole } from '../api/types'
import {
  REF_CHIP_RADIUS,
  REF_GUTTER_PAD,
  hitRefRow,
  layoutRefChips,
  type RefChipRow,
} from './refs'

const EXPAND_MS = 320
const COLLAPSE_MS = 260
/** Fixed radius / height of corner curves on feature↔main (and boundary) links. */
const ELBOW_R = 12

const COLORS = {
  bg: '#0f1419',
  rail: '#6b8cae',
  railDim: '#3a4a5a',
  node: '#e7ecf3',
  nodeDim: '#6a7585',
  merge: '#f0c674',
  mergeRing: '#d4a84b',
  feature: '#7ec8e3',
  featureEdge: '#5aa8c4',
  boundary: 'rgba(160, 160, 160, 0.45)',
  select: '#ff7b72',
  text: 'rgba(230, 236, 245, 0.92)',
  textDim: 'rgba(160, 172, 188, 0.7)',
  gutter: 'rgba(120, 140, 160, 0.55)',
  chipFill: 'rgba(88, 70, 140, 0.45)',
  chipStroke: 'rgba(163, 113, 247, 0.75)',
  chipText: 'rgba(230, 220, 255, 0.95)',
  chipOverflowFill: 'rgba(60, 80, 100, 0.55)',
  chipOverflowStroke: 'rgba(160, 180, 200, 0.55)',
  chipOverflowText: 'rgba(200, 214, 230, 0.9)',
  chipDim: 'rgba(100, 100, 120, 0.25)',
  // External context roles
  roleBase: '#e3b341',
  roleBaseEdge: 'rgba(227, 179, 65, 0.75)',
  roleSync: '#3fb950',
  roleSyncEdge: 'rgba(63, 185, 80, 0.7)',
  roleIntegration: '#a371f7',
  roleIntegrationEdge: 'rgba(163, 113, 247, 0.75)',
}

type Props = {
  nodes: SpineNode[]
  focusMergeOid: string | null
  feature: FeatureSubgraph | null
  /** Expand request in flight — dim spine and pulse the merge before data arrives. */
  featureLoading?: boolean
  selectedOid: string | null
  onHit: (hit: LayoutHit | null) => void
  /** Exclusive end of the loaded stream (max spineIndex+1 seen). */
  streamEndIndex?: number
  hasMoreOlder?: boolean
}

type TooltipState =
  | { kind: 'refs'; refs: string[]; left: number; top: number }
  | {
      kind: 'commit'
      shortOid: string
      subject: string
      author: string
      when: string
      left: number
      top: number
    }

/** Distinct colors for parallel landing/boundary elbows so they don't blend. */
const EDGE_COLORS = [
  '#7ec8e3',
  '#d2a8ff',
  '#7ee787',
  '#ffa657',
  '#ff7b72',
  '#79c0ff',
  '#e3b341',
  '#f778ba',
]

function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
  )
}

export function SpineCanvas({
  nodes,
  focusMergeOid,
  feature,
  featureLoading = false,
  selectedOid,
  onHit,
  streamEndIndex = 0,
  hasMoreOlder = false,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const layoutRef = useRef(layoutSpine(nodes, null, null, 0, 0, false))
  const refRowsRef = useRef<RefChipRow[]>([])
  const [tooltip, setTooltip] = useState<TooltipState | null>(null)

  // Animated display state (kept during collapse after props clear).
  const openTRef = useRef(0)
  const displayFocusRef = useRef<string | null>(null)
  const displayFeatureRef = useRef<FeatureSubgraph | null>(null)
  const nodesRef = useRef(nodes)
  const selectedRef = useRef(selectedOid)
  const propFocusRef = useRef(focusMergeOid)
  const featureLoadingRef = useRef(featureLoading)
  const streamEndRef = useRef(streamEndIndex)
  const hasMoreOlderRef = useRef(hasMoreOlder)
  const loadSpinRafRef = useRef(0)
  nodesRef.current = nodes
  selectedRef.current = selectedOid
  propFocusRef.current = focusMergeOid
  featureLoadingRef.current = featureLoading
  streamEndRef.current = streamEndIndex
  hasMoreOlderRef.current = hasMoreOlder

  const rafRef = useRef(0)
  const animRef = useRef<{
    from: number
    to: number
    start: number
    duration: number
    onDone?: () => void
  } | null>(null)

  const paint = useCallback(() => {
    const canvas = canvasRef.current
    const wrap = wrapRef.current
    if (!canvas || !wrap) return

    const dpr = window.devicePixelRatio || 1
    const width = wrap.clientWidth
    const openT = openTRef.current
    const dFocus = displayFocusRef.current
    const dFeature = displayFeatureRef.current
    const ns = nodesRef.current
    const sel = selectedRef.current

    const pendingLoad = featureLoadingRef.current
    // While expand is in flight, layout against the requested merge so a gap opens
    // under it (displayFocus is still null until the subgraph arrives).
    const layoutFocus = dFocus ?? (pendingLoad ? propFocusRef.current : null)
    const layout = layoutSpine(
      ns,
      layoutFocus,
      dFeature,
      openT,
      streamEndRef.current,
      hasMoreOlderRef.current,
      pendingLoad,
    )
    layoutRef.current = layout
    const height = Math.max(wrap.clientHeight, layout.totalHeight)

    canvas.width = Math.floor(width * dpr)
    canvas.height = Math.floor(height * dpr)
    canvas.style.width = `${width}px`
    canvas.style.height = `${height}px`

    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

    ctx.fillStyle = COLORS.bg
    ctx.fillRect(0, 0, width, height)

    const pendingOid = featureLoadingRef.current ? propFocusRef.current : null
    // Dim as soon as expand is requested (before subgraph arrives).
    const dimSpine = (openT > 0.05 && Boolean(dFocus)) || Boolean(pendingOid)
    const featureAlpha = openT
    const compressT = layout.compressT
    const refRows: RefChipRow[] = []
    const chipRight = RAIL_X - MERGE_R - REF_GUTTER_PAD
    const chipLeftLimit = 88

    // Rail between consecutive spine commits (layout order = spineIndex order).
    const drawNodes = layout.nodes
    for (let i = 0; i < drawNodes.length - 1; i++) {
      const y1 = layout.yOf.get(drawNodes[i].commit.oid)
      const y2 = layout.yOf.get(drawNodes[i + 1].commit.oid)
      if (y1 == null || y2 == null) continue
      ctx.beginPath()
      ctx.strokeStyle = dimSpine ? COLORS.railDim : COLORS.rail
      ctx.lineWidth = compressT > 0.4 ? 2 : 3
      ctx.moveTo(RAIL_X, y1)
      ctx.lineTo(RAIL_X, y2)
      ctx.stroke()
    }

    if (dFocus && dFeature && openT > 0.001) {
      ctx.save()
      ctx.globalAlpha = featureAlpha
      const my = layout.yOf.get(dFocus)

      const posOf = (oid: string): { x: number; y: number } | null => {
        if (oid === dFocus && my != null) return { x: RAIL_X, y: my }
        const fy = layout.featureYs.get(oid)
        if (fy != null) return { x: LANE_X, y: fy }
        const ey = layout.externalYs.get(oid)
        if (ey != null) {
          return { x: layout.externalXs.get(oid) ?? EXTERNAL_X, y: ey }
        }
        const sy = layout.yOf.get(oid)
        if (sy != null) return { x: RAIL_X, y: sy }
        return null
      }

      // Landing / boundary: H–V–H through a dedicated gutter (never on the spine rail).
      // Horizontal legs sit at each endpoint's Y so you can see which commit is which.
      type ElbowDraw = {
        e: (typeof dFeature.edges)[number]
        from: { x: number; y: number }
        to: { x: number; y: number }
        featureY: number
      }
      const elbows: ElbowDraw[] = []
      for (const e of dFeature.edges) {
        if (e.kind !== 'landing' && e.kind !== 'boundary') continue
        const from = posOf(e.from)
        const to = posOf(e.to)
        if (!from || !to) continue
        const featureY =
          Math.abs(from.x - LANE_X) <= Math.abs(to.x - LANE_X) ? from.y : to.y
        elbows.push({ e, from, to, featureY })
      }
      elbows.sort((a, b) => a.featureY - b.featureY)
      const channelOf = new Map<string, number>()
      elbows.forEach((item, i) => {
        channelOf.set(`${item.e.from}->${item.e.to}:${item.e.kind}`, i)
      })
      const elbowCount = Math.max(1, elbows.length)

      for (const e of dFeature.edges) {
        const from = posOf(e.from)
        const to = posOf(e.to)
        if (!from || !to) continue

        const isElbow = e.kind === 'landing' || e.kind === 'boundary'
        const channel = isElbow
          ? (channelOf.get(`${e.from}->${e.to}:${e.kind}`) ?? 0)
          : 0

        ctx.beginPath()
        if (e.kind === 'boundary') {
          ctx.setLineDash([4, 3])
          ctx.strokeStyle = roleEdgeColor(e.role ?? layout.externalRoles.get(e.to))
          ctx.lineWidth = 1.5
        } else if (e.kind === 'landing') {
          ctx.setLineDash([])
          ctx.strokeStyle = EDGE_COLORS[channel % EDGE_COLORS.length]
          ctx.lineWidth = 2
        } else {
          ctx.setLineDash([])
          ctx.strokeStyle = COLORS.featureEdge
          ctx.lineWidth = 1.75
        }

        if (isElbow) {
          strokeGutterElbow(
            ctx,
            from.x,
            from.y,
            to.x,
            to.y,
            ELBOW_R,
            channel,
            elbowCount,
          )
        } else {
          ctx.moveTo(from.x, from.y)
          ctx.lineTo(to.x, to.y)
        }
        ctx.stroke()
        ctx.setLineDash([])
      }

      // Soft vertical guide through the feature column.
      const foids = dFeature.commits.map((c) => c.oid)
      for (let i = 0; i < foids.length - 1; i++) {
        const y1 = layout.featureYs.get(foids[i])
        const y2 = layout.featureYs.get(foids[i + 1])
        if (y1 == null || y2 == null) continue
        ctx.beginPath()
        ctx.strokeStyle = COLORS.featureEdge
        ctx.lineWidth = 2
        ctx.globalAlpha = featureAlpha * 0.85
        ctx.moveTo(LANE_X, y1)
        ctx.lineTo(LANE_X, y2)
        ctx.stroke()
        ctx.globalAlpha = featureAlpha
      }

      for (const c of dFeature.commits) {
        const fy = layout.featureYs.get(c.oid)
        if (fy == null) continue
        ctx.beginPath()
        ctx.fillStyle = COLORS.feature
        ctx.arc(LANE_X, fy, NODE_R - 1, 0, Math.PI * 2)
        ctx.fill()
        if (sel === c.oid) {
          ctx.strokeStyle = COLORS.select
          ctx.lineWidth = 2
          ctx.stroke()
        }
        ctx.fillStyle = COLORS.text
        ctx.font = '12px ui-monospace, SFMono-Regular, Menlo, monospace'
        const oidText = c.shortOid
        ctx.fillText(oidText, LANE_X + 14, fy + 4)
        const oidW = ctx.measureText(oidText + '  ').width
        ctx.fillStyle = COLORS.textDim
        ctx.font = '12px system-ui, sans-serif'
        // Keep labels short so the right-side elbow gutter stays clear.
        ctx.fillText(
          fitText(ctx, c.subject, FEATURE_LABEL_W - oidW),
          LANE_X + 14 + oidW,
          fy + 4,
        )
      }

      // Off-spine external context (branch base, sync merges). On-spine roles drawn later.
      for (const ext of dFeature.externals ?? []) {
        const oid = ext.commit.oid
        const ey = layout.externalYs.get(oid)
        const ex = layout.externalXs.get(oid)
        if (ey == null || ex == null) continue
        if (ex === RAIL_X) continue
        drawExternalNode(ctx, ex, ey, ext.role, sel === oid, false)
        const badge = roleBadge(ext.role)
        ctx.font = '10px system-ui, sans-serif'
        ctx.fillStyle = roleColor(ext.role)
        ctx.fillText(badge, ex + 12, ey - 8)
        ctx.fillStyle = COLORS.text
        ctx.font = '12px ui-monospace, SFMono-Regular, Menlo, monospace'
        ctx.fillText(ext.commit.shortOid, ex + 12, ey + 4)
        const oidW = ctx.measureText(ext.commit.shortOid + ' ').width
        ctx.fillStyle = COLORS.textDim
        ctx.font = '11px system-ui, sans-serif'
        ctx.fillText(fitText(ctx, ext.commit.subject, 160), ex + 12 + oidW, ey + 4)
      }

      if (openT > 0.7) {
        drawFeatureLegend(ctx, width)
      }

      ctx.restore()
    }

    for (const n of drawNodes) {
      const y = layout.yOf.get(n.commit.oid)
      if (y == null) continue
      const isPendingFocus = pendingOid === n.commit.oid
      const isFocus = (dFocus === n.commit.oid && openT > 0.2) || isPendingFocus
      const isAnchor = layout.anchors.has(n.commit.oid) || isPendingFocus
      const isDim = dimSpine && !isFocus && !isPendingFocus
      // When feature is open or loading, fade labels (hover shows full message).
      const labelAlpha =
        !dimSpine && compressT < 0.05
          ? 1
          : pendingOid
            ? isPendingFocus || sel === n.commit.oid
              ? 1
              : 0.28
            : compressT < 0.05
              ? 1
              : sel === n.commit.oid || isFocus
                ? 1
                : isAnchor
                  ? 0.55 + (1 - compressT) * 0.35
                  : 0.2 + (1 - compressT) * 0.65
      const nodeScale = compressT > 0.4 && !isAnchor && !isFocus ? 0.9 : 1

      // Dates: hide when tightly packed unless anchor/selected
      if (compressT < 0.35 || isAnchor || sel === n.commit.oid || isFocus || pendingOid) {
        ctx.globalAlpha =
          pendingOid && !isPendingFocus && sel !== n.commit.oid
            ? 0.28
            : compressT > 0.35
              ? labelAlpha
              : 1
        ctx.fillStyle = COLORS.gutter
        ctx.font = '11px ui-monospace, monospace'
        ctx.fillText(n.commit.authorTime.slice(0, 10), 8, y + 4)
        ctx.globalAlpha = 1
      }

      if (n.commit.refs?.length && (compressT < 0.4 || isAnchor || isFocus || isPendingFocus)) {
        const chips = layoutRefChips(
          ctx,
          n.commit.oid,
          n.commit.refs,
          y,
          chipRight,
          chipLeftLimit,
        )
        if (chips) {
          refRows.push(chips)
          for (const chip of chips.chips) {
            drawRefChip(ctx, chip, isDim && !isAnchor)
          }
        }
      }

      ctx.beginPath()
      const r = (n.commit.isMerge ? MERGE_R : NODE_R) * nodeScale
      ctx.fillStyle = isDim && !isAnchor
        ? COLORS.nodeDim
        : n.commit.isMerge
          ? COLORS.merge
          : COLORS.node
      ctx.arc(RAIL_X, y, r, 0, Math.PI * 2)
      ctx.fill()
      if (n.commit.isMerge) {
        ctx.strokeStyle = isDim && !isAnchor ? COLORS.nodeDim : COLORS.mergeRing
        ctx.lineWidth = 2
        ctx.beginPath()
        ctx.arc(RAIL_X, y, r + 3 * nodeScale, 0, Math.PI * 2)
        ctx.stroke()
      }
      if (sel === n.commit.oid || isFocus) {
        ctx.strokeStyle = COLORS.select
        ctx.lineWidth = 2
        ctx.beginPath()
        ctx.arc(RAIL_X, y, r + 6, 0, Math.PI * 2)
        ctx.stroke()
      } else if (isAnchor && compressT > 0.3) {
        ctx.strokeStyle = 'rgba(126, 200, 227, 0.55)'
        ctx.lineWidth = 1.5
        ctx.beginPath()
        ctx.arc(RAIL_X, y, r + 5, 0, Math.PI * 2)
        ctx.stroke()
      }

      ctx.globalAlpha = labelAlpha
      ctx.fillStyle = isDim && !isAnchor ? COLORS.textDim : COLORS.text
      ctx.font = '12px ui-monospace, monospace'
      const oidText = n.commit.shortOid
      // When highly compressed, only show short oid for anchors/selection; others omit text.
      if (compressT < 0.55 || isAnchor || sel === n.commit.oid || isFocus || pendingOid) {
        ctx.fillText(oidText, SUBJECT_X, y + 4)
        if (compressT < 0.5 || isFocus || sel === n.commit.oid || isPendingFocus) {
          const oidW = ctx.measureText(oidText + '  ').width
          ctx.font = '12px system-ui, sans-serif'
          const subject = fitText(ctx, n.commit.subject, Math.max(40, SUBJECT_MAX_W - oidW))
          ctx.fillText(subject, SUBJECT_X + oidW, y + 4)
        }
      }
      ctx.globalAlpha = 1
    }

    // Loading indicator in the reserved gap under the merge (feature lane).
    if (pendingOid) {
      const py = layout.yOf.get(pendingOid)
      if (py != null) {
        // Center of the loading placeholder gap (layout pushes the next spine commit down).
        const loadY = py + ROW + FEATURE_LOADING_GAP * 0.35
        // Soft stub from merge into the open feature slot.
        ctx.beginPath()
        ctx.strokeStyle = 'rgba(126, 200, 227, 0.35)'
        ctx.lineWidth = 1.5
        ctx.setLineDash([3, 3])
        ctx.moveTo(RAIL_X + MERGE_R + 2, py)
        ctx.lineTo(LANE_X, py)
        ctx.lineTo(LANE_X, loadY - 10)
        ctx.stroke()
        ctx.setLineDash([])

        drawExpandSpinner(ctx, LANE_X, loadY, performance.now())
        ctx.fillStyle = COLORS.feature
        ctx.font = '12px system-ui, sans-serif'
        ctx.fillText('Loading feature…', LANE_X + 16, loadY + 4)
      }
    }

    // On-spine external roles (e.g. integration parent of the expanded merge).
    if (dFocus && dFeature && openT > 0.2) {
      ctx.save()
      ctx.globalAlpha = Math.min(1, openT)
      for (const ext of dFeature.externals ?? []) {
        const oid = ext.commit.oid
        const ex = layout.externalXs.get(oid)
        const ey = layout.externalYs.get(oid)
        if (ex !== RAIL_X || ey == null) continue
        drawExternalNode(ctx, RAIL_X, ey, ext.role, sel === oid, true)
        ctx.font = '10px system-ui, sans-serif'
        ctx.fillStyle = roleColor(ext.role)
        const badge = roleBadge(ext.role)
        const tw = ctx.measureText(badge).width
        ctx.fillText(badge, RAIL_X - 14 - tw, ey - 14)
      }
      ctx.restore()
    }

    refRowsRef.current = refRows

    ctx.fillStyle = COLORS.textDim
    ctx.font = '11px system-ui, sans-serif'
    const hint = pendingOid
      ? 'Loading feature… — click the merge again (or Esc) to cancel'
      : openT > 0.5
        ? 'Feature expanded — click the same merge again (or Esc) to collapse · hover for messages'
        : 'Main spine — click a merge commit to expand its feature history · hover for messages'
    ctx.fillText(hint, 16, 20)
  }, [])

  const stopAnim = useCallback(() => {
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current)
      rafRef.current = 0
    }
    animRef.current = null
  }, [])

  const animateTo = useCallback(
    (to: number, duration: number, onDone?: () => void) => {
      stopAnim()
      if (prefersReducedMotion() || duration <= 0) {
        openTRef.current = to
        onDone?.()
        paint()
        return
      }
      animRef.current = {
        from: openTRef.current,
        to,
        start: performance.now(),
        duration,
        onDone,
      }
      const tick = (now: number) => {
        const a = animRef.current
        if (!a) return
        const u = Math.min(1, (now - a.start) / a.duration)
        openTRef.current = a.from + (a.to - a.from) * easeInOutCubic(u)
        paint()
        if (u < 1) {
          rafRef.current = requestAnimationFrame(tick)
        } else {
          openTRef.current = a.to
          animRef.current = null
          rafRef.current = 0
          a.onDone?.()
          paint()
        }
      }
      rafRef.current = requestAnimationFrame(tick)
    },
    [paint, stopAnim],
  )

  // Drive expand / collapse from props.
  useEffect(() => {
    if (focusMergeOid && feature && feature.mergeOid === focusMergeOid) {
      const switching =
        displayFocusRef.current != null &&
        displayFocusRef.current !== focusMergeOid &&
        openTRef.current > 0.05

      if (switching) {
        // Collapse previous, then open the new feature.
        animateTo(0, COLLAPSE_MS * 0.75, () => {
          displayFocusRef.current = focusMergeOid
          displayFeatureRef.current = feature
          openTRef.current = 0
          animateTo(1, EXPAND_MS)
        })
      } else {
        displayFocusRef.current = focusMergeOid
        displayFeatureRef.current = feature
        animateTo(1, EXPAND_MS)
      }
      return
    }

    if (!focusMergeOid) {
      // Keep last feature subgraph until fold finishes.
      animateTo(0, COLLAPSE_MS, () => {
        displayFocusRef.current = null
        displayFeatureRef.current = null
        paint()
      })
      return
    }

    // Focus set but still loading: collapse any previous expand visuals,
    // keep spine dimmed via featureLoading (no feature geometry yet).
    if (featureLoading) {
      if (openTRef.current > 0.05) {
        animateTo(0, COLLAPSE_MS * 0.6, () => {
          displayFocusRef.current = null
          displayFeatureRef.current = null
          paint()
        })
      } else {
        displayFocusRef.current = null
        displayFeatureRef.current = null
        paint()
      }
    }
  }, [focusMergeOid, feature, featureLoading, animateTo, paint])

  // Spin the loading indicator while expand is in flight.
  useEffect(() => {
    if (!featureLoading) {
      if (loadSpinRafRef.current) {
        cancelAnimationFrame(loadSpinRafRef.current)
        loadSpinRafRef.current = 0
      }
      return
    }
    const tick = () => {
      paint()
      loadSpinRafRef.current = requestAnimationFrame(tick)
    }
    loadSpinRafRef.current = requestAnimationFrame(tick)
    return () => {
      if (loadSpinRafRef.current) {
        cancelAnimationFrame(loadSpinRafRef.current)
        loadSpinRafRef.current = 0
      }
    }
  }, [featureLoading, paint])

  useEffect(() => {
    paint()
    const onResize = () => paint()
    window.addEventListener('resize', onResize)
    return () => {
      window.removeEventListener('resize', onResize)
      stopAnim()
      if (loadSpinRafRef.current) {
        cancelAnimationFrame(loadSpinRafRef.current)
        loadSpinRafRef.current = 0
      }
    }
  }, [paint, stopAnim, nodes, selectedOid, streamEndIndex, hasMoreOlder, featureLoading])

  const localPoint = (e: React.MouseEvent) => {
    const canvas = canvasRef.current
    if (!canvas) return null
    const rect = canvas.getBoundingClientRect()
    return { x: e.clientX - rect.left, y: e.clientY - rect.top }
  }

  const onClick = (e: React.MouseEvent) => {
    const p = localPoint(e)
    if (!p) return
    // Hit-test against current animated layout; feature hits only when mostly open.
    const focusForHit =
      openTRef.current > 0.4 ? displayFocusRef.current : propFocusRef.current
    onHit(hitTest(layoutRef.current, focusForHit, p.x, p.y))
  }

  const onMove = (e: React.MouseEvent) => {
    const p = localPoint(e)
    if (!p) return
    const row = hitRefRow(refRowsRef.current, p.x, p.y)
    if (row) {
      setTooltip({
        kind: 'refs',
        refs: row.allRefs,
        left: row.x,
        top: row.y + row.h + 6,
      })
      return
    }

    const focusForHit =
      openTRef.current > 0.4 ? displayFocusRef.current : propFocusRef.current
    const hit = hitTest(layoutRef.current, focusForHit, p.x, p.y)
    if (hit?.kind === 'spine') {
      const c =
        nodesRef.current.find((n) => n.commit.oid === hit.oid)?.commit ??
        displayFeatureRef.current?.commits.find((x) => x.oid === hit.oid)
      if (c) {
        const cy = layoutRef.current.yOf.get(c.oid) ?? p.y
        setTooltip({
          kind: 'commit',
          shortOid: c.shortOid,
          subject: c.subject,
          author: c.authorName,
          when: c.authorTime.slice(0, 19).replace('T', ' '),
          left: SUBJECT_X,
          top: cy + 14,
        })
        return
      }
    }
    if (hit?.kind === 'feature' || hit?.kind === 'external') {
      const c =
        displayFeatureRef.current?.commits.find((x) => x.oid === hit.oid) ??
        displayFeatureRef.current?.externals?.find((x) => x.commit.oid === hit.oid)
          ?.commit
      if (c) {
        setTooltip({
          kind: 'commit',
          shortOid: c.shortOid,
          subject: c.subject,
          author: c.authorName,
          when: c.authorTime.slice(0, 19).replace('T', ' '),
          left: p.x + 12,
          top: p.y + 12,
        })
        return
      }
    }
    setTooltip(null)
  }

  const onLeave = () => setTooltip(null)

  return (
    <div ref={wrapRef} className="canvas-wrap">
      <canvas
        ref={canvasRef}
        onClick={onClick}
        onMouseMove={onMove}
        onMouseLeave={onLeave}
      />
      {tooltip?.kind === 'refs' && (
        <div
          className="ref-tooltip"
          style={{ left: tooltip.left, top: tooltip.top }}
          role="tooltip"
        >
          <div className="ref-tooltip-title">
            {tooltip.refs.length} reference{tooltip.refs.length === 1 ? '' : 's'}
          </div>
          <ul>
            {tooltip.refs.map((r) => (
              <li key={r}>
                <code>{r}</code>
              </li>
            ))}
          </ul>
        </div>
      )}
      {tooltip?.kind === 'commit' && (
        <div
          className="ref-tooltip commit-tooltip"
          style={{ left: tooltip.left, top: tooltip.top }}
          role="tooltip"
        >
          <div className="ref-tooltip-title">
            <code>{tooltip.shortOid}</code>
          </div>
          <div className="commit-tooltip-subject">{tooltip.subject}</div>
          <div className="commit-tooltip-meta">
            {tooltip.author} · {tooltip.when}
          </div>
        </div>
      )}
    </div>
  )
}

/** Arc spinner drawn at the feature lane while expand is in flight. */
function drawExpandSpinner(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  nowMs: number,
) {
  const r = 7
  const angle = (nowMs / 1000) * Math.PI * 2
  ctx.save()
  ctx.strokeStyle = COLORS.feature
  ctx.lineWidth = 2.25
  ctx.lineCap = 'round'
  ctx.beginPath()
  ctx.arc(x, y, r, angle, angle + Math.PI * 1.35)
  ctx.stroke()
  ctx.strokeStyle = 'rgba(126, 200, 227, 0.25)'
  ctx.beginPath()
  ctx.arc(x, y, r, 0, Math.PI * 2)
  ctx.stroke()
  ctx.restore()
}

function drawRefChip(
  ctx: CanvasRenderingContext2D,
  chip: { label: string; isOverflow: boolean; x: number; y: number; w: number; h: number },
  dim: boolean,
) {
  ctx.beginPath()
  if (dim) {
    ctx.fillStyle = COLORS.chipDim
    ctx.strokeStyle = COLORS.chipDim
  } else if (chip.isOverflow) {
    ctx.fillStyle = COLORS.chipOverflowFill
    ctx.strokeStyle = COLORS.chipOverflowStroke
  } else {
    ctx.fillStyle = COLORS.chipFill
    ctx.strokeStyle = COLORS.chipStroke
  }
  ctx.lineWidth = 1
  roundRect(ctx, chip.x, chip.y, chip.w, chip.h, REF_CHIP_RADIUS)
  ctx.fill()
  ctx.stroke()

  ctx.fillStyle = dim
    ? COLORS.textDim
    : chip.isOverflow
      ? COLORS.chipOverflowText
      : COLORS.chipText
  ctx.font = '11px ui-monospace, SFMono-Regular, Menlo, monospace'
  ctx.textBaseline = 'middle'
  ctx.fillText(chip.label, chip.x + 6, chip.y + chip.h / 2 + 0.5)
  ctx.textBaseline = 'alphabetic'
}

/**
 * Orthogonal connector for landing / boundary edges with visible corner radii.
 *
 * Left (feature ↔ main) — H–V–H in the gutter between rail and feature lane:
 *
 *   feature ●──╮
 *              │  gutter (not on the spine)
 *   main    ●──╯
 *
 * Right (feature → branch base) — L with vertical beside the base node:
 *
 *   feature ●──────────╮
 *                      │
 *               base ◆─╯
 */
function strokeGutterElbow(
  ctx: CanvasRenderingContext2D,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  r: number,
  channel: number,
  channelCount: number,
) {
  const dx = x1 - x0
  const dy = y1 - y0

  if (Math.abs(dx) < 0.5 || Math.abs(dy) < 0.5) {
    ctx.moveTo(x0, y0)
    ctx.lineTo(x1, y1)
    return
  }

  const minX = Math.min(x0, x1)
  const maxX = Math.max(x0, x1)
  const touchesSpine = minX <= RAIL_X + 12
  const touchesExternal = maxX >= EXTERNAL_X - 24

  const minR = 8
  const wantR = Math.max(r, minR)

  // --- Right side: feature ↔ external / branch base ---
  if (touchesExternal && !touchesSpine) {
    const featureIs0 = Math.abs(x0 - LANE_X) <= Math.abs(x1 - LANE_X)
    const fx = featureIs0 ? x0 : x1
    const fy = featureIs0 ? y0 : y1
    const ex = featureIs0 ? x1 : x0
    const ey = featureIs0 ? y1 : y0

    const slots = Math.max(channelCount, 1)
    const inset = 16 + (slots > 1 ? (channel / slots) * 18 : 0)
    const vx = ex - inset

    let rr = Math.min(
      wantR,
      Math.abs(vx - fx) - 2,
      Math.abs(ey - fy) / 2 - 1,
      Math.abs(ex - vx) - 2,
    )
    if (!Number.isFinite(rr) || rr < minR) rr = Math.min(minR, Math.abs(ey - fy) / 2)

    ctx.moveTo(fx, fy)
    ctx.arcTo(vx, fy, vx, ey, Math.max(3, rr))
    ctx.arcTo(vx, ey, ex, ey, Math.max(3, rr))
    ctx.lineTo(ex, ey)
    return
  }

  // --- Left side: feature ↔ main (gutter between rail and lane) ---
  const gLeft = RAIL_X + 18
  const gRight = LANE_X - 14
  const gutterW = gRight - gLeft

  if (gutterW < 20) {
    // Should not happen if LANE_GUTTER is set; still try a curved midpoint.
    const mx = (x0 + x1) / 2
    const rr = Math.min(wantR, Math.abs(dx) / 2 - 1, Math.abs(dy) / 2 - 1)
    ctx.moveTo(x0, y0)
    ctx.arcTo(mx, y0, mx, y1, Math.max(3, rr))
    ctx.arcTo(mx, y1, x1, y1, Math.max(3, rr))
    ctx.lineTo(x1, y1)
    return
  }

  const slots = Math.max(channelCount, 1)
  const t = slots === 1 ? 0.5 : (channel + 1) / (slots + 1)
  const midX = gLeft + gutterW * t

  let rr = Math.min(
    wantR,
    Math.abs(midX - x0) - 2,
    Math.abs(x1 - midX) - 2,
    Math.abs(dy) / 2 - 1,
  )
  if (!Number.isFinite(rr) || rr < minR) {
    rr = Math.min(minR, Math.abs(dy) / 2 - 1, gutterW / 2 - 2)
  }
  rr = Math.max(4, rr)

  ctx.moveTo(x0, y0)
  ctx.arcTo(midX, y0, midX, y1, rr)
  ctx.arcTo(midX, y1, x1, y1, rr)
  ctx.lineTo(x1, y1)
}

function roleColor(role?: ExternalRole): string {
  switch (role) {
    case 'integration':
      return COLORS.roleIntegration
    case 'synced':
      return COLORS.roleSync
    case 'base':
    default:
      return COLORS.roleBase
  }
}

function roleEdgeColor(role?: ExternalRole): string {
  switch (role) {
    case 'integration':
      return COLORS.roleIntegrationEdge
    case 'synced':
      return COLORS.roleSyncEdge
    case 'base':
    default:
      return COLORS.roleBaseEdge
  }
}

function roleBadge(role?: ExternalRole): string {
  switch (role) {
    case 'integration':
      return 'on main'
    case 'synced':
      return 'synced in'
    case 'base':
    default:
      return 'branch base'
  }
}

function drawExternalNode(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  role: ExternalRole,
  selected: boolean,
  onSpine: boolean,
) {
  const color = roleColor(role)
  ctx.save()
  if (onSpine) {
    // Halo around existing spine node.
    ctx.beginPath()
    ctx.strokeStyle = color
    ctx.lineWidth = 2
    ctx.setLineDash([3, 2])
    ctx.arc(x, y, MERGE_R + 9, 0, Math.PI * 2)
    ctx.stroke()
    ctx.setLineDash([])
  } else if (role === 'synced') {
    // Square — “brought in from outside”
    const s = NODE_R + 1
    ctx.fillStyle = color
    ctx.strokeStyle = color
    ctx.lineWidth = 1.5
    ctx.fillRect(x - s, y - s, s * 2, s * 2)
    ctx.strokeRect(x - s, y - s, s * 2, s * 2)
  } else {
    // Diamond — branch base / starting point
    const s = NODE_R + 2
    ctx.beginPath()
    ctx.moveTo(x, y - s)
    ctx.lineTo(x + s, y)
    ctx.lineTo(x, y + s)
    ctx.lineTo(x - s, y)
    ctx.closePath()
    ctx.fillStyle = color
    ctx.fill()
  }
  if (selected) {
    ctx.beginPath()
    ctx.strokeStyle = COLORS.select
    ctx.lineWidth = 2
    ctx.arc(x, y, NODE_R + 8, 0, Math.PI * 2)
    ctx.stroke()
  }
  ctx.restore()
}

function drawFeatureLegend(ctx: CanvasRenderingContext2D, canvasW: number) {
  const items: { label: string; color: string; shape: 'circle' | 'diamond' | 'square' | 'halo' }[] = [
    { label: 'feature', color: COLORS.feature, shape: 'circle' },
    { label: 'branch base', color: COLORS.roleBase, shape: 'diamond' },
    { label: 'synced in', color: COLORS.roleSync, shape: 'square' },
    { label: 'on main', color: COLORS.roleIntegration, shape: 'halo' },
  ]
  const x0 = Math.max(EXTERNAL_X, canvasW - 320)
  let x = x0
  const y = 36
  ctx.font = '10px system-ui, sans-serif'
  for (const it of items) {
    if (it.shape === 'circle') {
      ctx.beginPath()
      ctx.fillStyle = it.color
      ctx.arc(x, y, 4, 0, Math.PI * 2)
      ctx.fill()
    } else if (it.shape === 'diamond') {
      ctx.beginPath()
      ctx.fillStyle = it.color
      ctx.moveTo(x, y - 5)
      ctx.lineTo(x + 5, y)
      ctx.lineTo(x, y + 5)
      ctx.lineTo(x - 5, y)
      ctx.closePath()
      ctx.fill()
    } else if (it.shape === 'square') {
      ctx.fillStyle = it.color
      ctx.fillRect(x - 4, y - 4, 8, 8)
    } else {
      ctx.beginPath()
      ctx.strokeStyle = it.color
      ctx.lineWidth = 1.5
      ctx.setLineDash([2, 2])
      ctx.arc(x, y, 5, 0, Math.PI * 2)
      ctx.stroke()
      ctx.setLineDash([])
    }
    ctx.fillStyle = COLORS.textDim
    ctx.fillText(it.label, x + 10, y + 3)
    x += 10 + ctx.measureText(it.label).width + 14
  }
}

function fitText(ctx: CanvasRenderingContext2D, s: string, maxW: number): string {
  if (ctx.measureText(s).width <= maxW) return s
  const ell = '…'
  let lo = 0
  let hi = s.length
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    if (ctx.measureText(s.slice(0, mid) + ell).width <= maxW) lo = mid
    else hi = mid - 1
  }
  return lo <= 0 ? ell : s.slice(0, lo) + ell
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
) {
  ctx.moveTo(x + r, y)
  ctx.arcTo(x + w, y, x + w, y + h, r)
  ctx.arcTo(x + w, y + h, x, y + h, r)
  ctx.arcTo(x, y + h, x, y, r)
  ctx.arcTo(x, y, x + w, y, r)
  ctx.closePath()
}
