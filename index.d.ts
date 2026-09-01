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
 * A case for a statement splitter.
 *
 * `statements` is how many SQL statements the text actually contains. The
 * shapes here are the ones a naive split on semicolons gets wrong.
 */
export interface SplittingCase {
  id: string
  description: string
  sql: string
  statements: number
  minPgVersion?: number
}

export interface CorpusByName {
  objects: ObjectCase[]
  'hard-cases': HardCase[]
  ordering: OrderingCase[]
  splitting: SplittingCase[]
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
