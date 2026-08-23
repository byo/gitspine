import { useCallback, useEffect, useRef, useState } from 'react'
import { expandFeature, fetchRepo, fetchSpine, isAbortError } from './api/client'
import type { Commit, FeatureSubgraph, RepoMeta, SpineNode } from './api/types'
import { SpineCanvas } from './graph/SpineCanvas'
import type { LayoutHit } from './graph/layout'
import { isExpandable, spineRowPitch } from './graph/layout'
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

  nodesRef.current = nodes
  hasMoreOlderRef.current = hasMoreOlder
  hasMoreNewerRef.current = hasMoreNewer
  focusMergeRef.current = focusMergeOid

  const rowPx = useCallback(() => {
    return spineRowPitch(focusMergeRef.current ? 0.5 : 0)
  }, [])

  const contentHeightPx = useCallback((n = nodesRef.current.length) => {
    // Matches sequential window layout (TOP_PAD + n*row + pad).
    return 48 + n * rowPx() + 48
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

  const load = useCallback(async () => {
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
  }, [syncFlags])

  useEffect(() => {
    void load()
  }, [load])

  const clearFeatureFocus = useCallback(() => {
    // Invalidate any in-flight expand (token + abort via effect cleanup).
    expandTokenRef.current += 1
    focusMergeRef.current = null
    setFocusMergeOid(null)
    setFeature(null)
    setFeatureLoading(false)
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        clearFeatureFocus()
        setSelectedOid(null)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [clearFeatureFocus])

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
      })
      .catch((e) => {
        if (isAbortError(e)) return
        if (token !== expandTokenRef.current) return
        if (focusMergeRef.current !== mergeOid) return
        setFeatureLoading(false)
        setFeature(null)
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

  const onCanvasHit = (hit: LayoutHit | null) => {
    if (!hit) {
      setSelectedOid(null)
      return
    }
    if (hit.kind === 'spine') {
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
    if (hit.kind === 'feature' || hit.kind === 'external') {
      setSelectedOid((prev) => (prev === hit.oid ? null : hit.oid))
    }
  }

  const onFocusFeature = (mergeOid: string | null) => {
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

  /**
   * Neighbour prefetch against *content* edges (not fake document end).
   * Does not thrash: one direction at a time, only when viewport is near a real edge.
   */
  const ensureOverscan = useCallback(() => {
    if (loadingMoreRef.current) return
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
          {focusMergeOid && (
            <button type="button" className="btn" onClick={() => onFocusFeature(null)}>
              {featureLoading ? 'Cancel expand' : 'Exit feature focus'}
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
              selectedOid={selectedOid}
              onHit={onCanvasHit}
              streamEndIndex={winMax + 1}
              hasMoreOlder={hasMoreOlder}
            />
          )}
          {!loading && nodes.length > 0 && (
            <div className="load-more-bar" aria-live="polite">
              {featureLoading
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

          {focusMergeOid && featureLoading && (
            <div className="feature-summary feature-loading" aria-live="polite">
              <h2>Feature bundle</h2>
              <div className="feature-loading-row">
                <span className="spinner" aria-hidden />
                <p>
                  Loading history for <code>{focusMergeOid.slice(0, 7)}</code>…
                </p>
              </div>
              <p className="muted small">
                Click the merge again (or Esc) to cancel — the request is aborted and discarded.
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
                Blue = feature commits. Context:{' '}
                <span className="role-base">branch base</span>,{' '}
                <span className="role-sync">synced in</span>,{' '}
                <span className="role-integration">on main</span>.
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
