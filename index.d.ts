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

export interface CorpusByName {
  objects: ObjectCase[]
  'hard-cases': HardCase[]
  ordering: OrderingCase[]
}

export declare const fingerprintSqlPath: string
export declare function fingerprintSql(schemas?: string[]): string
export declare const corpora: Array<keyof CorpusByName>
export declare function loadCorpus<K extends keyof CorpusByName>(name: K): CorpusByName[K]
