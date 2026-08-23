/** Layout helpers for ref/tag chips in the left gutter. */

export const REF_CHIP_H = 18
export const REF_CHIP_PAD_X = 6
export const REF_CHIP_GAP = 4
export const REF_CHIP_RADIUS = 5
/** Max chips drawn (last may be a "+N" overflow chip). */
export const REF_MAX_VISIBLE = 2
/** Soft cap on a single chip's label width. */
export const REF_MAX_CHIP_W = 88
/** Space reserved left of the rail for chips (right edge of chip row). */
export const REF_GUTTER_PAD = 12

export type RefChip = {
  /** Display label (may be truncated or "+N"). */
  label: string
  /** True for the overflow chip. */
  isOverflow: boolean
  x: number
  y: number
  w: number
  h: number
}

export type RefChipRow = {
  oid: string
  /** All ref names for hover tooltip. */
  allRefs: string[]
  chips: RefChip[]
  /** Bounding box of the whole chip row (for hover). */
  x: number
  y: number
  w: number
  h: number
}

function fitLabel(ctx: CanvasRenderingContext2D, s: string, maxW: number): string {
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

/**
 * Lay out chips right-aligned against `rightEdge`, vertically centered on `cy`.
 * Shows up to REF_MAX_VISIBLE chips; if more refs exist, last chip is "+N".
 */
export function layoutRefChips(
  ctx: CanvasRenderingContext2D,
  oid: string,
  refs: string[],
  cy: number,
  rightEdge: number,
  leftLimit: number,
): RefChipRow | null {
  if (!refs.length) return null

  ctx.font = '11px ui-monospace, SFMono-Regular, Menlo, monospace'
  const maxLabelW = REF_MAX_CHIP_W - REF_CHIP_PAD_X * 2

  type Spec = { label: string; isOverflow: boolean }
  const specs: Spec[] = []

  if (refs.length <= REF_MAX_VISIBLE) {
    for (const r of refs) {
      specs.push({ label: fitLabel(ctx, r, maxLabelW), isOverflow: false })
    }
  } else {
    const shown = REF_MAX_VISIBLE - 1
    for (let i = 0; i < shown; i++) {
      specs.push({ label: fitLabel(ctx, refs[i], maxLabelW), isOverflow: false })
    }
    const rest = refs.length - shown
    specs.push({ label: `+${rest}`, isOverflow: true })
  }

  const chips: RefChip[] = []
  let xRight = rightEdge
  const y = cy - REF_CHIP_H / 2

  // Build right-to-left so the row hugs the rail.
  for (let i = specs.length - 1; i >= 0; i--) {
    const spec = specs[i]
    const textW = ctx.measureText(spec.label).width
    const w = Math.min(REF_MAX_CHIP_W, textW + REF_CHIP_PAD_X * 2)
    const x = xRight - w
    if (x < leftLimit) {
      // Not enough room: drop remaining left-side chips, keep overflow if possible.
      break
    }
    chips.unshift({
      label: spec.label,
      isOverflow: spec.isOverflow,
      x,
      y,
      w,
      h: REF_CHIP_H,
    })
    xRight = x - REF_CHIP_GAP
  }

  if (!chips.length) return null

  const x0 = chips[0].x
  const x1 = chips[chips.length - 1].x + chips[chips.length - 1].w
  return {
    oid,
    allRefs: refs,
    chips,
    x: x0,
    y,
    w: x1 - x0,
    h: REF_CHIP_H,
  }
}

export function hitRefRow(rows: RefChipRow[], x: number, y: number): RefChipRow | null {
  for (const row of rows) {
    if (x >= row.x - 2 && x <= row.x + row.w + 2 && y >= row.y - 2 && y <= row.y + row.h + 2) {
      return row
    }
  }
  return null
}
