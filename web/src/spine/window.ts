import type { SpineNode } from '../api/types'

/** Max commits retained in the browser at once (sliding window). */
export const SPINE_WINDOW_MAX = 250
export const SPINE_PAGE = 50

/** Merge two pages, sort by spineIndex, dedupe by oid. */
export function mergeSpineNodes(
  existing: SpineNode[],
  incoming: SpineNode[],
): SpineNode[] {
  const byOid = new Map<string, SpineNode>()
  for (const n of existing) byOid.set(n.commit.oid, n)
  for (const n of incoming) byOid.set(n.commit.oid, n)
  return [...byOid.values()].sort((a, b) => a.spineIndex - b.spineIndex)
}

export function spineIndexRange(nodes: SpineNode[]): {
  min: number
  max: number
} {
  if (!nodes.length) return { min: 0, max: -1 }
  let min = nodes[0].spineIndex
  let max = nodes[0].spineIndex
  for (const n of nodes) {
    if (n.spineIndex < min) min = n.spineIndex
    if (n.spineIndex > max) max = n.spineIndex
  }
  return { min, max }
}

export type TrimResult = {
  nodes: SpineNode[]
  /** How many commits were removed from the *start* (newest side). */
  droppedFromStart: number
  /** How many commits were removed from the *end* (oldest side). */
  droppedFromEnd: number
}

/**
 * Keep at most `max` commits as a contiguous slice.
 * - direction 'older': we just loaded older history → drop from start if needed
 * - direction 'newer': we just loaded newer history → drop from end if needed
 * Pinned oids are retained even if the window grows slightly.
 */
export function trimSpineWindowDirectional(
  nodes: SpineNode[],
  max: number,
  direction: 'older' | 'newer' | 'none',
  pinnedOids: Iterable<string> = [],
): TrimResult {
  const sorted = [...nodes].sort((a, b) => a.spineIndex - b.spineIndex)
  if (sorted.length <= max) {
    return { nodes: sorted, droppedFromStart: 0, droppedFromEnd: 0 }
  }

  const pinned = new Set(pinnedOids)
  let start = 0
  let end = sorted.length

  if (direction === 'older') {
    // Prefer keeping the older tail (what the user just scrolled toward).
    start = sorted.length - max
    end = sorted.length
  } else if (direction === 'newer') {
    // Prefer keeping the newer head.
    start = 0
    end = max
  } else {
    start = Math.floor((sorted.length - max) / 2)
    end = start + max
  }

  // Pull pins into range.
  for (let i = 0; i < sorted.length; i++) {
    if (!pinned.has(sorted[i].commit.oid)) continue
    if (i < start) {
      const grow = start - i
      start = i
      end = Math.min(sorted.length, end + grow)
    } else if (i >= end) {
      end = i + 1
      start = Math.max(0, end - max)
    }
  }

  const out = sorted.slice(start, end)
  return {
    nodes: out,
    droppedFromStart: start,
    droppedFromEnd: sorted.length - end,
  }
}
