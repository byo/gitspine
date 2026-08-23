import type { ExternalRole, FeatureSubgraph, SpineNode } from '../api/types'

/** Baseline spacing between spine commits (node centers). */
export const ROW = 34
/** Compressed spacing while a feature is expanded (all dots still shown). */
export const ROW_COMPACT = 15
/** Anchors keep a bit more air than plain dots when compressed. */
export const ROW_COMPACT_ANCHOR = 22
/** Vertical first-parent rail. */
export const RAIL_X = 200
export const NODE_R = 7
export const MERGE_R = 9
/** Short oid + subject just right of the rail node (main-line labels). */
export const SUBJECT_X = RAIL_X + MERGE_R + 14
export const SUBJECT_MAX_W = 480
/**
 * Feature lane X. Keep a real gutter from the rail so H–V–H elbows have room
 * for visible corner radii (too close → sharp polyline fallback).
 */
export const LANE_GUTTER = 52
export const LANE_X = RAIL_X + LANE_GUTTER
/**
 * Context column for commits outside the feature (base / sync).
 * Keep far enough right that right-side L elbows clear feature labels.
 */
export const EXTERNAL_X = LANE_X + 210
/** Feature subject text is drawn up to roughly LANE_X + this width. */
export const FEATURE_LABEL_W = 150
export const TOP_PAD = 48
/** Small pad under the last loaded commit (not a fake multi-page desert). */
export const SPINE_STREAM_TAIL_ROWS = 3
/**
 * Vertical room reserved under a merge while its feature expand request is in flight.
 * Fits the spinner row plus breathing room so the next spine commit is pushed down.
 */
export const FEATURE_LOADING_GAP = ROW * 2.5

export type LayoutHit =
  | { kind: 'spine'; oid: string; index: number }
  | { kind: 'feature'; oid: string; mergeOid: string }
  | { kind: 'external'; oid: string; mergeOid: string; role: ExternalRole }

export type SpineLayout = {
  nodes: SpineNode[]
  yOf: Map<string, number>
  /** OIDs highlighted as related to the open feature (landing, M¹, externals…). */
  anchors: Set<string>
  /** 0 = normal spacing/labels, 1 = fully compressed feature-focus mode. */
  compressT: number
  totalHeight: number
  gapAfterIndex: number | null
  gapPx: number
  featureYs: Map<string, number>
  externalYs: Map<string, number>
  externalXs: Map<string, number>
  externalRoles: Map<string, ExternalRole>
}

/** Merge with feature history that can be expanded. */
export function isExpandable(n: SpineNode): boolean {
  if (!n.commit.isMerge && n.commit.parents.length < 2) return false
  // Exact capsule count may be omitted for perf (countExact=false / missing).
  if (n.capsule && n.capsule.countExact && n.capsule.commitCount === 0) return false
  return true
}

/** Spine commits related to the focused feature (for emphasis, not for hiding). */
export function spineAnchorOids(
  focusMergeOid: string | null,
  feature: FeatureSubgraph | null,
): Set<string> {
  const keep = new Set<string>()
  if (!focusMergeOid) return keep
  keep.add(focusMergeOid)
  if (feature?.firstParent) keep.add(feature.firstParent)
  for (const ext of feature?.externals ?? []) {
    keep.add(ext.commit.oid)
  }
  for (const e of feature?.edges ?? []) {
    if (e.kind === 'boundary' && e.to) keep.add(e.to)
  }
  return keep
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * clamp01(t)
}

/**
 * Row pitch while streaming. Kept uniform within a window so expand/scroll
 * stay stable (absolute spineIndex×row over the whole kernel history would
 * create multi‑million‑pixel canvases and break expand).
 */
export function spineRowPitch(compressT: number): number {
  // Mild pack only — never as tight as 15px for the whole window (unreadable + scroll bugs).
  return lerp(ROW, 26, clamp01(compressT) * 0.5)
}

/**
 * Layout the *loaded window* top‑down (newest first in the array after sort).
 * Streaming keeps only a sliding window of commits in `nodes`; Y is relative
 * to that window so expand always stays near the clicked merge.
 *
 * @param openT 0 = collapsed feature, 1 = expanded
 * @param hasMoreOlder extra scroll room under the window
 * @param featureLoading reserve a placeholder gap under the focused merge while expand is in flight
 */
export function layoutSpine(
  nodes: SpineNode[],
  focusMergeOid: string | null,
  feature: FeatureSubgraph | null,
  openT = 1,
  _streamEndIndex = 0,
  hasMoreOlder = false,
  featureLoading = false,
): SpineLayout {
  const t = clamp01(openT)
  const compressT = focusMergeOid && feature ? t : 0
  const anchors = spineAnchorOids(focusMergeOid, feature)
  const row = spineRowPitch(compressT)

  const yOf = new Map<string, number>()
  const featureYs = new Map<string, number>()
  const externalYs = new Map<string, number>()
  const externalXs = new Map<string, number>()
  const externalRoles = new Map<string, ExternalRole>()

  const loadingPlaceholder =
    Boolean(featureLoading && focusMergeOid && !feature)

  const fullGap =
    focusMergeOid && feature && feature.commits.length > 0
      ? feature.commits.length * ROW + 12
      : loadingPlaceholder
        ? FEATURE_LOADING_GAP
        : 0
  // Loading gap is fully open immediately (no openT animation yet).
  const gapPx = loadingPlaceholder ? FEATURE_LOADING_GAP : fullGap * t

  const sorted = [...nodes].sort((a, b) => a.spineIndex - b.spineIndex)

  let gapAfterLocal: number | null = null
  if (focusMergeOid) {
    const li = sorted.findIndex((n) => n.commit.oid === focusMergeOid)
    if (li >= 0) gapAfterLocal = li
  }

  let y = TOP_PAD
  for (let i = 0; i < sorted.length; i++) {
    const n = sorted[i]
    yOf.set(n.commit.oid, y)
    y += row
    if (gapAfterLocal === i && focusMergeOid && gapPx > 0) {
      if (feature) {
        const mergeY = yOf.get(focusMergeOid)!
        let restY = y
        for (const c of feature.commits) {
          featureYs.set(c.oid, mergeY + (restY - mergeY) * t)
          restY += ROW
        }
      }
      y += gapPx
    }
  }

  const tailPad = hasMoreOlder ? SPINE_STREAM_TAIL_ROWS * row : row
  const totalHeight = y + tailPad + TOP_PAD

  if (focusMergeOid && feature && feature.externals?.length && t > 0) {
    const linkYs = new Map<string, number[]>()
    for (const e of feature.edges) {
      if (e.kind !== 'boundary') continue
      const fy = featureYs.get(e.from)
      if (fy == null) continue
      const arr = linkYs.get(e.to) ?? []
      arr.push(fy)
      linkYs.set(e.to, arr)
    }
    if (feature.firstParent) {
      const my = yOf.get(focusMergeOid)
      if (my != null) {
        const arr = linkYs.get(feature.firstParent) ?? []
        arr.push(my)
        linkYs.set(feature.firstParent, arr)
      }
    }

    let featureBottom = yOf.get(focusMergeOid) ?? TOP_PAD
    for (const fy of featureYs.values()) {
      if (fy > featureBottom) featureBottom = fy
    }

    const usedOffSpine: number[] = []
    for (const ext of feature.externals) {
      const oid = ext.commit.oid
      externalRoles.set(oid, ext.role)
      const onSpine = yOf.has(oid)
      if (onSpine) {
        externalXs.set(oid, RAIL_X)
        externalYs.set(oid, yOf.get(oid)!)
        continue
      }
      externalXs.set(oid, EXTERNAL_X)
      const links = linkYs.get(oid)

      let targetY: number
      if (ext.role === 'base') {
        const linkMax =
          links && links.length ? Math.max(...links) : featureBottom
        targetY = Math.max(linkMax, featureBottom) + ROW
      } else if (links && links.length) {
        targetY = links.reduce((a, b) => a + b, 0) / links.length
      } else {
        targetY = featureBottom + ROW
      }

      for (let guard = 0; guard < 8; guard++) {
        const clash = usedOffSpine.some((uy) => Math.abs(uy - targetY) < ROW - 4)
        if (!clash) break
        targetY += ROW
      }
      usedOffSpine.push(targetY)
      const mergeY = yOf.get(focusMergeOid) ?? targetY
      externalYs.set(oid, mergeY + (targetY - mergeY) * t)
    }
  }

  return {
    nodes: sorted,
    yOf,
    anchors,
    compressT,
    totalHeight,
    gapAfterIndex: gapAfterLocal,
    gapPx,
    featureYs,
    externalYs,
    externalXs,
    externalRoles,
  }
}

export function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v))
}

export function easeInOutCubic(t: number): number {
  const x = clamp01(t)
  return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2
}

export function hitTest(
  layout: SpineLayout,
  focusMergeOid: string | null,
  x: number,
  y: number,
): LayoutHit | null {
  const packed = layout.compressT > 0.3
  const inSpineColumn = x < LANE_X - 4

  // 1) Spine hits first in the main column (click toggles expand in App).
  if (inSpineColumn || !focusMergeOid) {
    const circle = hitSpineCircle(layout, x, y, packed)
    if (circle) return circle
  }

  // 2) Feature / external context (right of the rail).
  if (focusMergeOid) {
    for (const [oid, ey] of layout.externalYs) {
      const ex = layout.externalXs.get(oid) ?? EXTERNAL_X
      if (ex === RAIL_X) continue
      const dx = x - ex
      const dy = y - ey
      if (dx * dx + dy * dy <= (NODE_R + 8) ** 2) {
        return {
          kind: 'external',
          oid,
          mergeOid: focusMergeOid,
          role: layout.externalRoles.get(oid) ?? 'base',
        }
      }
      if (x >= ex + 10 && x <= ex + 200 && Math.abs(y - ey) <= ROW / 2 - 2) {
        return {
          kind: 'external',
          oid,
          mergeOid: focusMergeOid,
          role: layout.externalRoles.get(oid) ?? 'base',
        }
      }
    }

    for (const [oid, fy] of layout.featureYs) {
      const dx = x - LANE_X
      const dy = y - fy
      if (dx * dx + dy * dy <= (NODE_R + 6) ** 2) {
        return { kind: 'feature', oid, mergeOid: focusMergeOid }
      }
      if (x >= LANE_X + 12 && x <= LANE_X + 150 && Math.abs(y - fy) <= ROW / 2 - 2) {
        return { kind: 'feature', oid, mergeOid: focusMergeOid }
      }
    }
  }

  // 3) Spine label column.
  const spineBand = hitSpineBand(layout, x, y, packed)
  if (spineBand) return spineBand

  // 4) Spine circles even when pointer is slightly into the feature column.
  if (focusMergeOid && !inSpineColumn) {
    const circle = hitSpineCircle(layout, x, y, packed)
    if (circle) return circle
  }

  return null
}

function hitSpineCircle(
  layout: SpineLayout,
  x: number,
  y: number,
  packed: boolean,
): LayoutHit | null {
  let best: LayoutHit | null = null
  let bestDist = Infinity

  for (const n of layout.nodes) {
    const cy = layout.yOf.get(n.commit.oid)
    if (cy == null) continue
    const dx = x - RAIL_X
    const dy = y - cy
    const dist = Math.hypot(dx, dy)
    const baseR = n.commit.isMerge ? MERGE_R : NODE_R
    const hitR = baseR + (packed ? 6 : 5)
    if (dist <= hitR && dist < bestDist) {
      bestDist = dist
      best = { kind: 'spine', oid: n.commit.oid, index: n.spineIndex }
    }
  }

  // Forgiving Y-snap near the rail.
  if (!best && x >= RAIL_X - 24 && x <= SUBJECT_X + 40) {
    for (const n of layout.nodes) {
      const cy = layout.yOf.get(n.commit.oid)
      if (cy == null) continue
      const dy = Math.abs(y - cy)
      const rowH = packed ? ROW_COMPACT : ROW
      if (dy <= rowH / 2 + 2 && dy < bestDist) {
        bestDist = dy
        best = { kind: 'spine', oid: n.commit.oid, index: n.spineIndex }
      }
    }
  }

  return best
}

function hitSpineBand(
  layout: SpineLayout,
  x: number,
  y: number,
  packed: boolean,
): LayoutHit | null {
  // Subject/oid column — important when messages are faded but the row is still there.
  if (x < SUBJECT_X - 4 || x > SUBJECT_X + SUBJECT_MAX_W) return null
  const rowH = packed ? ROW_COMPACT : ROW
  let best: LayoutHit | null = null
  let bestDy = Infinity
  for (const n of layout.nodes) {
    const cy = layout.yOf.get(n.commit.oid)
    if (cy == null) continue
    const dy = Math.abs(y - cy)
    if (dy <= rowH / 2 + 1 && dy < bestDy) {
      bestDy = dy
      best = { kind: 'spine', oid: n.commit.oid, index: n.spineIndex }
    }
  }
  return best
}
