/** A DDL case that builds objects from an empty schema. */
export interface ObjectCase {
  id: string
  sql: string
  minPgVersion?: number
}

/** A case exercising a renderer against DDL that is awkward to reproduce. */
export interface HardCase {
  id: string
  sql: string
  minPgVersion?: number
}

/**
 * A case for a dependency-ordering algorithm.
 *
 * `statements` are given in an order that does not apply. `requires` lists
 * `[before, after]` pairs, matched as substrings, that any correct order must
 * satisfy — a precedence rather than one expected permutation, so tie-breaking
 * can change without invalidating the case.
 */
export interface OrderingCase {
  id: string
  description: string
  statements: string[]
  requires: Array<[string, string]>
}

/**
 * A schema change any migration tool must make in both directions: from
 * `before` to `after` and back, leaving each identical to a database built
 * directly from it. `preserve` queries must return the same rows before and
 * after migrating — the data a correct migration keeps.
 */
export interface MigrationCase {
  id: string
  category: 'enum' | 'identity' | 'serial' | 'storage' | 'generated' | 'dependants' | 'creation_order' | 'removal_order' | 'foreign_key'
  description: string
  before: string
  after: string
  preserve?: string[]
  minPgVersion?: number
}

/**
 * One schema written two ways: as a developer writes it and as PostgreSQL
 * renders it. A tool comparing schemas must call the pair identical.
 */
export interface EquivalenceCase {
  id: string
  kind: 'check' | 'index' | 'policy' | 'view' | 'domain' | 'generated'
  description: string
  written: string
  rendered: string
}

export interface CorpusByName {
  objects: ObjectCase[]
  'hard-cases': HardCase[]
  ordering: OrderingCase[]
  migrations: MigrationCase[]
  equivalences: EquivalenceCase[]
}

/** One relation and everything attached to it. */
export interface StateTable {
  schema: string
  name: string
  kind: 'table' | 'partitioned_table' | 'foreign_table'
  unlogged: boolean
  partition_of: string | null
  partition_bound: string | null
  partition_by: string | null
  inherits: string[] | null
  options: string[] | null
  rls_enabled: boolean
  rls_forced: boolean
  comment: string | null
  columns: StateColumn[] | null
  constraints: Array<{ name: string; type: string; definition: string; validated: boolean; deferrable: boolean; deferred: boolean }> | null
  indexes: Array<{ name: string; definition: string }> | null
  policies: Array<{ name: string; command: string; permissive: boolean; roles: string[] | null; using: string | null; with_check: string | null }> | null
  triggers: Array<{ name: string; definition: string }> | null
}

export interface StateColumn {
  name: string
  position: number
  type: string
  not_null: boolean
  default: string | null
  identity: 'always' | 'by_default' | null
  identity_options: { start: number; increment: number; min: number; max: number; cache: number; cycle: boolean } | null
  generated: 'stored' | null
  storage: 'plain' | 'external' | 'main' | 'extended' | null
  storage_is_default: boolean
  compression: 'lz4' | 'pglz' | null
  /** Null when inherited rather than set explicitly. */
  collation: string | null
  comment: string | null
}

/**
 * A schema as data, rather than as an answer to "are these the same?".
 *
 * Sourced from pg_catalog, so it can express what information_schema cannot:
 * partition bounds, identity sequence options, storage, compression and
 * whether a collation was chosen or inherited.
 */
export interface SchemaState {
  meta: { server_version_num: number; schemas: string[] }
  tables: StateTable[]
  views: Array<{ schema: string; name: string; materialized: boolean; definition: string; options: string[] | null; comment: string | null; columns: Array<{ name: string; type: string }> | null }>
  sequences: Array<{ schema: string; name: string; type: string; start: number; increment: number; min: number; max: number; cache: number; cycle: boolean; owned_by: string | null }>
  routines: Array<{ schema: string; name: string; kind: 'function' | 'procedure'; arguments: string; definition: string; comment: string | null }>
  types: Array<{ schema: string; name: string; kind: 'enum' | 'domain' | 'composite'; labels: string[] | null; base_type: string | null; not_null: boolean; default: string | null; constraints: string[] | null; attributes: Array<{ name: string; type: string }> | null }>
  extensions: Array<{ name: string; version: string }>
}

export declare const stateSqlPath: string
export declare function stateSql(schemas?: string[]): string

export declare const fingerprintSqlPath: string
export declare function fingerprintSql(schemas?: string[]): string
export declare const corpora: Array<keyof CorpusByName>
export declare function loadCorpus<K extends keyof CorpusByName>(name: K): CorpusByName[K]
