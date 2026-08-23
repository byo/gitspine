import { useCallback, useEffect, useRef, useState } from 'react'
import {
  expandFeature,
  fetchCommitOrigin,
  fetchRepo,
  fetchSpine,
  isAbortError,
} from './api/client'
import type { Commit, FeatureSubgraph, RepoMeta, SpineNode } from './api/types'
import { SpineCanvas } from './graph/SpineCanvas'
import type { LayoutHit } from './graph/layout'
import { isExpandable, spineRowPitch, TOP_PAD } from './graph/layout'
import {
  SPINE_PAGE,
  SPINE_WINDOW_MAX,
  mergeSpineNodes,
  spineIndexRange,
  trimSpineWindowDirectional,
} from './spine/window'
import './App.css'

/**
 * Prefetch when viewport is within this many px of the first/last *loaded* commit.
 * Measured against content height, not fake document padding.
 */
const OVERSCAN_PX = 700

export default function App() {
  const [meta, setMeta] = useState<RepoMeta | null>(null)
  const [nodes, setNodes] = useState<SpineNode[]>([])
  const [hasMoreOlder, setHasMoreOlder] = useState(false)
  const [hasMoreNewer, setHasMoreNewer] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [focusMergeOid, setFocusMergeOid] = useState<string | null>(null)
  const [feature, setFeature] = useState<FeatureSubgraph | null>(null)
  /** Expand request in flight (focus set, subgraph not yet applied). */
  const [featureLoading, setFeatureLoading] = useState(false)
  /** Jump-to-origin / seek in flight (can be slow on huge repos). */
  const [navBusy, setNavBusy] = useState<{ oid: string; message: string } | null>(
    null,
  )
  const [selectedOid, setSelectedOid] = useState<string | null>(null)
  const [selected, setSelected] = useState<Commit | null>(null)

  const graphPaneRef = useRef<HTMLElement | null>(null)
  const nodesRef = useRef<SpineNode[]>([])
  const loadingMoreRef = useRef(false)
  /** Prevent concurrent direction thrash. */
  const loadDirRef = useRef<'older' | 'newer' | null>(null)
  const hasMoreOlderRef = useRef(false)
  const hasMoreNewerRef = useRef(false)
  const serverHasMoreRef = useRef(false)
  const focusMergeRef = useRef<string | null>(null)
  /** Monotonic token so a late expand response never applies after cancel/switch. */
  const expandTokenRef = useRef(0)
  /** Monotonic token + AbortController for jump-to-origin navigation. */
  const jumpTokenRef = useRef(0)
  const jumpAbortRef = useRef<AbortController | null>(null)

  nodesRef.current = nodes
  hasMoreOlderRef.current = hasMoreOlder
  hasMoreNewerRef.current = hasMoreNewer
  focusMergeRef.current = focusMergeOid

  const rowPx = useCallback(() => {
    return spineRowPitch(focusMergeRef.current ? 0.5 : 0)
  }, [])

  const contentHeightPx = useCallback((n = nodesRef.current.length) => {
    // Matches sequential window layout (TOP_PAD + n*row + pad).
    return TOP_PAD + n * rowPx() + TOP_PAD
  }, [rowPx])

  const syncFlags = useCallback((windowNodes: SpineNode[]) => {
    const { min } = spineIndexRange(windowNodes)
    const older = serverHasMoreRef.current
    const newer = min > 0
    hasMoreOlderRef.current = older
    hasMoreNewerRef.current = newer
    setHasMoreOlder(older)
    setHasMoreNewer(newer)
  }, [])

  /**
   * Merge + directional trim + scroll anchoring so commits don't jump under the viewport.
   */
  const applyWindow = useCallback(
    (
      incoming: SpineNode[],
      direction: 'older' | 'newer' | 'none',
    ) => {
      const pane = graphPaneRef.current
      const before = nodesRef.current
      const beforeFirstOid = before[0]?.commit.oid

      const pins = focusMergeRef.current ? [focusMergeRef.current] : []
      const merged = mergeSpineNodes(before, incoming)
      const trimmed = trimSpineWindowDirectional(
        merged,
        SPINE_WINDOW_MAX,
        direction,
        pins,
      )

      // Window-relative layout: Y of a commit = its index in the loaded list.
      // Any change to how many rows sit *above* a visible commit must adjust scrollTop.
      if (pane && beforeFirstOid) {
        const oldIndexOfAnchor = before.findIndex((n) => n.commit.oid === beforeFirstOid)
        const newIndexOfAnchor = trimmed.nodes.findIndex(
          (n) => n.commit.oid === beforeFirstOid,
        )
        if (oldIndexOfAnchor >= 0 && newIndexOfAnchor >= 0) {
          const deltaRows = newIndexOfAnchor - oldIndexOfAnchor
          if (deltaRows !== 0) {
            pane.scrollTop = Math.max(0, pane.scrollTop + deltaRows * rowPx())
          }
        } else if (trimmed.droppedFromStart > 0) {
          // Previous top was dropped entirely — shift by dropped count.
          pane.scrollTop = Math.max(
            0,
            pane.scrollTop - trimmed.droppedFromStart * rowPx(),
          )
        }
      }

      nodesRef.current = trimmed.nodes
      setNodes(trimmed.nodes)
      syncFlags(trimmed.nodes)
      return trimmed.nodes
    },
    [rowPx, syncFlags],
  )

  /** Cancel in-flight jump-to-origin (locate + spine seek). Late results are ignored. */
  const cancelJump = useCallback(() => {
    jumpTokenRef.current += 1
    jumpAbortRef.current?.abort()
    jumpAbortRef.current = null
    setNavBusy(null)
  }, [])

  const clearFeatureFocus = useCallback(() => {
    // Invalidate any in-flight expand (token + abort via effect cleanup).
    expandTokenRef.current += 1
    focusMergeRef.current = null
    setFocusMergeOid(null)
    setFeature(null)
    setFeatureLoading(false)
  }, [])

  /** Cancel jump + expand and clear selection chrome. */
  const cancelBackgroundWork = useCallback(() => {
    cancelJump()
    clearFeatureFocus()
  }, [cancelJump, clearFeatureFocus])

  const load = useCallback(async () => {
    cancelJump()
    clearFeatureFocus()
    setLoading(true)
    setError(null)
    loadingMoreRef.current = false
    loadDirRef.current = null
    serverHasMoreRef.current = false
    try {
      const [m, spine] = await Promise.all([fetchRepo(), fetchSpine(0, SPINE_PAGE)])
      setMeta(m)
      const initial = mergeSpineNodes([], spine.nodes)
      nodesRef.current = initial
      setNodes(initial)
      serverHasMoreRef.current = spine.hasMore
      syncFlags(initial)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [cancelJump, clearFeatureFocus, syncFlags])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        cancelBackgroundWork()
        setSelectedOid(null)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [cancelBackgroundWork])

  /**
   * Expand: focus/dim immediately, fetch with AbortController.
   * Collapse or switch merge aborts the request and ignores late results.
   */
  useEffect(() => {
    if (!focusMergeOid) {
      setFeature(null)
      setFeatureLoading(false)
      return
    }

    // Drop any previous feature geometry right away so the spine de-focuses
    // before network work completes (loading UI takes over the gap).
    setFeature(null)
    setFeatureLoading(true)

    const token = ++expandTokenRef.current
    const ac = new AbortController()
    const mergeOid = focusMergeOid

    expandFeature(mergeOid, ac.signal)
      .then((sg) => {
        if (token !== expandTokenRef.current) return
        if (focusMergeRef.current !== mergeOid) return
        setFeature(sg)
        setFeatureLoading(false)
        // Jump-to-origin may still show a spinner on the old node; clear it.
        setNavBusy(null)
      })
      .catch((e) => {
        if (isAbortError(e)) return
        if (token !== expandTokenRef.current) return
        if (focusMergeRef.current !== mergeOid) return
        setFeatureLoading(false)
        setFeature(null)
        setNavBusy(null)
        // Drop focus so we are not stuck half-open with no subgraph.
        expandTokenRef.current += 1
        focusMergeRef.current = null
        setFocusMergeOid(null)
        setError(e instanceof Error ? e.message : String(e))
      })

    return () => {
      ac.abort()
    }
  }, [focusMergeOid])

  useEffect(() => {
    if (!selectedOid) {
      setSelected(null)
      return
    }
    const fromSpine = nodes.find((n) => n.commit.oid === selectedOid)?.commit
    const fromFeat = feature?.commits.find((c) => c.oid === selectedOid)
    const fromExt = feature?.externals?.find((e) => e.commit.oid === selectedOid)?.commit
    setSelected(fromSpine ?? fromFeat ?? fromExt ?? null)
  }, [selectedOid, nodes, feature])

  /**
   * Jump to the feature that introduced `oid` (expand that landing merge + select).
   * Used when clicking base/synced externals that live in another feature flow.
   * Cancelable: a new jump, Esc, or other UI action aborts in-flight work and
   * ignores late responses so the graph does not “teleport” afterward.
   */
  const jumpToCommitOrigin = useCallback(
    async (oid: string) => {
      // Cancel any previous jump and in-flight expand so only this navigation applies.
      jumpAbortRef.current?.abort()
      const token = ++jumpTokenRef.current
      const ac = new AbortController()
      jumpAbortRef.current = ac
      // Also invalidate expand so a previous expand cannot apply mid-jump.
      expandTokenRef.current += 1

      const short = oid.slice(0, 7)
      setError(null)
      setNavBusy({ oid, message: `Locating ${short}…` })

      const stillCurrent = () =>
        token === jumpTokenRef.current && !ac.signal.aborted

      try {
        const loc = await fetchCommitOrigin(oid, ac.signal)
        if (!stillCurrent()) return

        if (loc.onSpine && loc.spineIndex != null) {
          const { min, max } = spineIndexRange(nodesRef.current)
          if (loc.spineIndex < min || loc.spineIndex > max) {
            setNavBusy({ oid, message: `Loading history around ${short}…` })
            const half = Math.floor(SPINE_PAGE / 2)
            const offset = Math.max(0, loc.spineIndex - half)
            const spine = await fetchSpine(offset, SPINE_PAGE, ac.signal)
            if (!stillCurrent()) return
            applyWindow(spine.nodes, 'none')
            serverHasMoreRef.current = spine.hasMore
            syncFlags(nodesRef.current)
          }
          if (!stillCurrent()) return
          clearFeatureFocus()
          setSelectedOid(oid)
          setNavBusy(null)
          jumpAbortRef.current = null
          requestAnimationFrame(() => {
            if (!stillCurrent()) return
            const pane = graphPaneRef.current
            const n = nodesRef.current.find((x) => x.commit.oid === oid)
            if (!pane || !n) return
            const { min } = spineIndexRange(nodesRef.current)
            const local = Math.max(0, n.spineIndex - min)
            const y = local * spineRowPitch(0)
            pane.scrollTop = Math.max(0, y - pane.clientHeight * 0.3)
          })
          return
        }

        if (loc.introducingMerge) {
          const mergeShort = loc.introducingMerge.slice(0, 7)
          if (loc.introducingSpineIndex != null) {
            const { min, max } = spineIndexRange(nodesRef.current)
            const idx = loc.introducingSpineIndex
            if (idx < min || idx > max) {
              setNavBusy({ oid, message: `Seeking merge ${mergeShort}…` })
              const half = Math.floor(SPINE_PAGE / 2)
              const offset = Math.max(0, idx - half)
              const spine = await fetchSpine(offset, SPINE_PAGE, ac.signal)
              if (!stillCurrent()) return
              serverHasMoreRef.current = spine.hasMore
              applyWindow(spine.nodes, 'none')
              syncFlags(nodesRef.current)
            }
          }
          if (!stillCurrent()) return
          // Keep spinner on the clicked node while the target feature expands.
          setNavBusy({ oid, message: `Opening feature ${mergeShort}…` })
          focusMergeRef.current = loc.introducingMerge
          setSelectedOid(oid)
          setFocusMergeOid(loc.introducingMerge)
          jumpAbortRef.current = null
          return
        }

        if (!stillCurrent()) return
        setSelectedOid(oid)
        setNavBusy(null)
        jumpAbortRef.current = null
      } catch (e) {
        if (isAbortError(e) || !stillCurrent()) return
        setNavBusy(null)
        jumpAbortRef.current = null
        setError(e instanceof Error ? e.message : String(e))
      }
    },
    [applyWindow, clearFeatureFocus, syncFlags],
  )

  const onCanvasHit = (hit: LayoutHit | null) => {
    if (!hit) {
      cancelJump()
      setSelectedOid(null)
      return
    }
    if (hit.kind === 'spine') {
      cancelJump()
      const node = nodes.find((n) => n.commit.oid === hit.oid)
      const expandable = node ? isExpandable(node) : false

      if (expandable) {
        if (focusMergeOid === hit.oid) {
          clearFeatureFocus()
          setSelectedOid(hit.oid)
          return
        }
        setFocusMergeOid(hit.oid)
        setSelectedOid(hit.oid)
        return
      }

      if (focusMergeOid) clearFeatureFocus()
      setSelectedOid(hit.oid)
      return
    }
    if (hit.kind === 'feature') {
      cancelJump()
      setSelectedOid((prev) => (prev === hit.oid ? null : hit.oid))
      return
    }
    if (hit.kind === 'external') {
      // Integration parent is on the rail — just select if present, else jump.
      if (hit.role === 'integration') {
        const onRail = nodes.some((n) => n.commit.oid === hit.oid)
        if (onRail) {
          cancelJump()
          setSelectedOid(hit.oid)
          return
        }
      }
      // base / synced (and missing integration): open the feature that introduced it.
      // jumpToCommitOrigin cancels any previous jump itself.
      void jumpToCommitOrigin(hit.oid)
    }
  }

  const onFocusFeature = (mergeOid: string | null) => {
    cancelJump()
    if (mergeOid == null) {
      clearFeatureFocus()
      setSelectedOid(null)
      return
    }
    setFocusMergeOid(mergeOid)
    setSelectedOid(mergeOid)
  }

  const loadOlder = useCallback(async () => {
    if (!hasMoreOlderRef.current || loadingMoreRef.current) return
    if (loadDirRef.current === 'newer') return
    loadingMoreRef.current = true
    loadDirRef.current = 'older'
    setLoadingMore(true)
    try {
      const { max } = spineIndexRange(nodesRef.current)
      const offset = max >= 0 ? max + 1 : 0
      const spine = await fetchSpine(offset, SPINE_PAGE)

      if (spine.nodes.length === 0) {
        serverHasMoreRef.current = false
        hasMoreOlderRef.current = false
        setHasMoreOlder(false)
        return
      }

      serverHasMoreRef.current = spine.hasMore
      applyWindow(spine.nodes, 'older')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      loadingMoreRef.current = false
      loadDirRef.current = null
      setLoadingMore(false)
    }
  }, [applyWindow])

  const loadNewer = useCallback(async () => {
    if (!hasMoreNewerRef.current || loadingMoreRef.current) return
    if (loadDirRef.current === 'older') return
    const { min } = spineIndexRange(nodesRef.current)
    if (min <= 0) {
      hasMoreNewerRef.current = false
      setHasMoreNewer(false)
      return
    }
    loadingMoreRef.current = true
    loadDirRef.current = 'newer'
    setLoadingMore(true)
    try {
      const offset = Math.max(0, min - SPINE_PAGE)
      const limit = min - offset
      if (limit <= 0) return
      const spine = await fetchSpine(offset, limit)
      if (spine.nodes.length === 0) {
        hasMoreNewerRef.current = false
        setHasMoreNewer(false)
        return
      }
      applyWindow(spine.nodes, 'newer')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      loadingMoreRef.current = false
      loadDirRef.current = null
      setLoadingMore(false)
    }
  }, [applyWindow])

  const navBusyRef = useRef(false)
  const featureLoadingRef = useRef(false)
  navBusyRef.current = Boolean(navBusy)
  featureLoadingRef.current = featureLoading

  /**
   * Neighbour prefetch against *content* edges (not fake document end).
   * Does not thrash: one direction at a time, only when viewport is near a real edge.
   * Paused while a jump/expand is in flight so window seeks are not fighting scroll.
   */
  const ensureOverscan = useCallback(() => {
    if (loadingMoreRef.current) return
    if (navBusyRef.current || featureLoadingRef.current) return
    const pane = graphPaneRef.current
    if (!pane || nodesRef.current.length === 0) return

    const { scrollTop, clientHeight } = pane
    const viewBottom = scrollTop + clientHeight
    const contentBottom = contentHeightPx()

    // Near last loaded commit → fetch older (down the spine).
    if (
      hasMoreOlderRef.current &&
      viewBottom >= contentBottom - OVERSCAN_PX
    ) {
      void loadOlder()
      return
    }

    // Near top of window and tip was dropped → fetch newer.
    // Require we actually dropped the tip (min > 0) and user is near the top.
    if (hasMoreNewerRef.current && scrollTop <= OVERSCAN_PX) {
      void loadNewer()
    }
  }, [contentHeightPx, loadOlder, loadNewer])

  // Initial warm buffer: one extra page only (not a cascade to WINDOW_MAX).
  const didPrefetchRef = useRef(false)
  useEffect(() => {
    if (loading) {
      didPrefetchRef.current = false
      return
    }
    if (didPrefetchRef.current) return
    if (hasMoreOlder && nodes.length > 0 && nodes.length <= SPINE_PAGE) {
      didPrefetchRef.current = true
      void loadOlder()
    }
  }, [loading, hasMoreOlder, nodes.length, loadOlder])

  // After a successful load, re-check once (smooth continuous scroll at edge).
  useEffect(() => {
    if (loading || loadingMore) return
    const t = window.setTimeout(() => ensureOverscan(), 80)
    return () => window.clearTimeout(t)
  }, [nodes, loading, loadingMore, ensureOverscan])

  // Pin expanded merge in the window.
  useEffect(() => {
    if (!focusMergeOid) return
    const n = nodesRef.current.find((x) => x.commit.oid === focusMergeOid)
    if (!n) return
    applyWindow([], 'none')
    const pane = graphPaneRef.current
    if (!pane) return
    requestAnimationFrame(() => {
      const row = spineRowPitch(0.5)
      const { min } = spineIndexRange(nodesRef.current)
      const local = Math.max(0, n.spineIndex - min)
      const y = local * row
      const target = Math.max(0, y - pane.clientHeight * 0.2)
      if (Math.abs(pane.scrollTop - target) > pane.clientHeight * 0.45) {
        pane.scrollTop = target
      }
    })
  }, [focusMergeOid, applyWindow])

  useEffect(() => {
    const el = graphPaneRef.current
    if (!el || loading) return

    let ticking = false
    const onScroll = () => {
      if (ticking) return
      ticking = true
      requestAnimationFrame(() => {
        ticking = false
        ensureOverscan()
      })
    }

    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [ensureOverscan, loading])

  const { min: winMin, max: winMax } = spineIndexRange(nodes)

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="logo">GitSpine</span>
          <span className="tagline">first-parent history · streamed window</span>
        </div>
        {meta && (
          <div className="repo-meta" title={meta.path}>
            <code>{meta.integrationRef}</code>
            <span className="dot">@</span>
            <code>{meta.shortOid}</code>
            <span className="path">{shortPath(meta.path)}</span>
          </div>
        )}
        <div className="actions">
          {(navBusy || featureLoading) && (
            <button
              type="button"
              className="btn"
              onClick={() => {
                cancelBackgroundWork()
              }}
            >
              Cancel
            </button>
          )}
          {focusMergeOid && !navBusy && !featureLoading && (
            <button type="button" className="btn" onClick={() => onFocusFeature(null)}>
              Exit feature focus
            </button>
          )}
          <button type="button" className="btn ghost" onClick={() => void load()}>
            Reload
          </button>
        </div>
      </header>

      <div className="main">
        <section className="graph-pane" ref={graphPaneRef}>
          {loading && <div className="banner">Loading spine…</div>}
          {error && <div className="banner error">{error}</div>}
          {!loading && !error && (
            <SpineCanvas
              nodes={nodes}
              focusMergeOid={focusMergeOid}
              feature={feature}
              featureLoading={featureLoading}
              navTargetOid={navBusy?.oid ?? null}
              navBusyMessage={navBusy?.message ?? null}
              selectedOid={selectedOid}
              onHit={onCanvasHit}
              streamEndIndex={winMax + 1}
              hasMoreOlder={hasMoreOlder}
            />
          )}
          {!loading && nodes.length > 0 && (
            <div className="load-more-bar" aria-live="polite">
              {navBusy
                ? navBusy.message
                : featureLoading
                  ? 'Expanding feature…'
                  : loadingMore
                    ? 'Loading…'
                    : `Window #${winMin}–#${winMax} · ${nodes.length} commits in memory` +
                      (hasMoreOlder ? ' · older available below' : '') +
                      (hasMoreNewer ? ' · newer available above' : '')}
            </div>
          )}
        </section>

        <aside className="detail">
          <h2>Detail</h2>
          {!selected && (
            <p className="muted">
              Click a merge on the spine to expand its feature history; click it again to collapse.
              History streams in a sliding window (~{SPINE_WINDOW_MAX} commits) with neighbour
              prefetch — scrollbar tracks the loaded window, not the whole Linux history.
            </p>
          )}
          {selected && (
            <div className="commit-detail">
              <div className="oid">
                <code>{selected.shortOid}</code>
                {selected.isMerge && <span className="badge">merge</span>}
              </div>
              <h3>{selected.subject}</h3>
              {selected.body && <pre className="body">{selected.body}</pre>}
              <dl>
                <dt>Author</dt>
                <dd>
                  {selected.authorName} &lt;{selected.authorEmail}&gt;
                </dd>
                <dt>When</dt>
                <dd>{new Date(selected.authorTime).toLocaleString()}</dd>
                <dt>Parents</dt>
                <dd>
                  {selected.parents.length === 0 && <em>root</em>}
                  {selected.parents.map((p, i) => (
                    <div key={p}>
                      <span className="parent-role">
                        {i === 0 ? '1st (spine)' : `${i + 1}th (feature tip)`}
                      </span>{' '}
                      <code>{p.slice(0, 7)}</code>
                    </div>
                  ))}
                </dd>
                {selected.refs && selected.refs.length > 0 && (
                  <>
                    <dt>Refs</dt>
                    <dd>{selected.refs.join(', ')}</dd>
                  </>
                )}
              </dl>
              {selected.isMerge && (
                <button
                  type="button"
                  className="btn primary"
                  onClick={() =>
                    focusMergeOid === selected.oid
                      ? onFocusFeature(null)
                      : onFocusFeature(selected.oid)
                  }
                >
                  {focusMergeOid === selected.oid
                    ? featureLoading
                      ? 'Cancel expand'
                      : 'Collapse feature'
                    : 'Expand feature history'}
                </button>
              )}
            </div>
          )}

          {navBusy && (
            <div className="feature-summary feature-loading" aria-live="polite">
              <h2>Navigating</h2>
              <div className="feature-loading-row">
                <span className="spinner" aria-hidden />
                <p>{navBusy.message}</p>
              </div>
              <p className="muted small">
                Spinner is on the clicked node. Esc or Cancel aborts and ignores any late response.
              </p>
            </div>
          )}

          {focusMergeOid && featureLoading && !navBusy && (
            <div className="feature-summary feature-loading" aria-live="polite">
              <h2>Feature bundle</h2>
              <div className="feature-loading-row">
                <span className="spinner" aria-hidden />
                <p>
                  Loading history for <code>{focusMergeOid.slice(0, 7)}</code>…
                </p>
              </div>
              <p className="muted small">
                Click the merge again (or Esc / Cancel) to abort — late results are discarded.
              </p>
            </div>
          )}

          {focusMergeOid && feature && !featureLoading && (
            <div className="feature-summary">
              <h2>Feature bundle</h2>
              <p>
                <code>{focusMergeOid.slice(0, 7)}</code> · {feature.commits.length} commits ·{' '}
                {feature.tips.length} tip(s)
              </p>
              <p className="muted small">
                Blue = feature commits. Context nodes:{' '}
                <span className="role-base">branch base</span>,{' '}
                <span className="role-sync">synced in</span>,{' '}
                <span className="role-integration">on main</span>. Click a base/synced node to jump
                into the feature that introduced that commit.
              </p>
              {feature.truncated && (
                <p className="banner warn">
                  Feature history is truncated (commit cap). The shown branch base may be a cut
                  point, not the true fork from main.
                </p>
              )}
              <ol className="feat-list">
                {feature.commits.map((c) => (
                  <li key={c.oid}>
                    <button
                      type="button"
                      className={selectedOid === c.oid ? 'link active' : 'link'}
                      onClick={() => setSelectedOid(c.oid)}
                    >
                      <code>{c.shortOid}</code> {c.subject}
                    </button>
                  </li>
                ))}
              </ol>
              {feature.externals && feature.externals.length > 0 && (
                <>
                  <h2 className="sub">Outside this branch</h2>
                  <ol className="feat-list">
                    {feature.externals.map((ext) => (
                      <li key={ext.commit.oid}>
                        <button
                          type="button"
                          className={selectedOid === ext.commit.oid ? 'link active' : 'link'}
                          onClick={() => setSelectedOid(ext.commit.oid)}
                        >
                          <span className={`role-pill role-${ext.role}`}>
                            {ext.role === 'integration'
                              ? 'on main'
                              : ext.role === 'synced'
                                ? 'synced in'
                                : 'branch base'}
                          </span>{' '}
                          <code>{ext.commit.shortOid}</code> {ext.commit.subject}
                        </button>
                      </li>
                    ))}
                  </ol>
                </>
              )}
            </div>
          )}
        </aside>
      </div>
    </div>
  )
}

function shortPath(p: string) {
  const parts = p.split('/')
  if (parts.length <= 3) return p
  return '…/' + parts.slice(-3).join('/')
}
