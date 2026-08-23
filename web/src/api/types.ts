export type Commit = {
  oid: string
  shortOid: string
  subject: string
  body?: string
  authorName: string
  authorEmail: string
  authorTime: string
  parents: string[]
  isMerge: boolean
  refs?: string[]
}

export type Capsule = {
  mergeOid: string
  hintTitle: string
  commitCount: number
  countExact: boolean
}

export type SpineNode = {
  commit: Commit
  spineIndex: number
  capsule?: Capsule
}

export type SpineResponse = {
  nodes: SpineNode[]
  hasMore: boolean
  offset: number
  limit: number
}

export type RepoMeta = {
  path: string
  integrationRef: string
  integrationOid: string
  shortOid: string
}

/** Boundary roles for commits outside the feature bundle. */
export type ExternalRole = 'integration' | 'base' | 'synced' | string

export type Edge = {
  from: string
  to: string
  kind: 'internal' | 'landing' | 'boundary' | string
  role?: ExternalRole
}

export type ExternalNode = {
  commit: Commit
  role: ExternalRole
}

export type FeatureSubgraph = {
  mergeOid: string
  firstParent: string
  commits: Commit[]
  edges: Edge[]
  tips: string[]
  externals?: ExternalNode[]
  /** True when expand hit the server commit cap; “base” may be a cut point. */
  truncated?: boolean
}

/** Where a commit sits relative to the integration spine / which feature landed it. */
export type CommitOrigin = {
  oid: string
  onSpine: boolean
  spineIndex?: number
  introducingMerge?: string
  introducingSpineIndex?: number
}
