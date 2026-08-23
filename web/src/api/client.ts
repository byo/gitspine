import type { FeatureSubgraph, RepoMeta, SpineResponse, Commit } from './types'

async function getJSON<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init)
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`${res.status} ${url}: ${body}`)
  }
  return res.json() as Promise<T>
}

export function fetchRepo(signal?: AbortSignal): Promise<RepoMeta> {
  return getJSON('/api/v1/repo', signal ? { signal } : undefined)
}

export function fetchSpine(
  offset = 0,
  limit = 80,
  signal?: AbortSignal,
): Promise<SpineResponse> {
  const q = new URLSearchParams({
    offset: String(offset),
    limit: String(limit),
    // Capsule counts = one git rev-list per merge; skip on large repos.
    // Expandability uses isMerge on the client.
    capsules: '0',
  })
  return getJSON(`/api/v1/spine?${q}`, signal ? { signal } : undefined)
}

export function expandFeature(
  mergeOid: string,
  signal?: AbortSignal,
): Promise<FeatureSubgraph> {
  return getJSON(
    `/api/v1/features/${encodeURIComponent(mergeOid)}/expand`,
    signal ? { signal } : undefined,
  )
}

export function fetchCommit(oid: string, signal?: AbortSignal): Promise<Commit> {
  return getJSON(`/api/v1/commits/${encodeURIComponent(oid)}`, signal ? { signal } : undefined)
}

/** True for fetch aborts (collapse mid-expand, unmount, etc.). */
export function isAbortError(e: unknown): boolean {
  if (!e || typeof e !== 'object') return false
  const name = (e as { name?: string }).name
  return name === 'AbortError' || name === 'TimeoutError'
}
