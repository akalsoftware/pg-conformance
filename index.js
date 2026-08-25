/**
 * @akalforge/pg-conformance
 *
 * Data only: a schema fingerprint query and a corpus of DDL cases. There is no
 * runner here on purpose — property-based and example-based harnesses
 * legitimately differ, and each consumer already has one. What must not differ
 * is the definition of "are these two schemas the same", which is why that
 * lives in exactly one place.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))

/** Absolute path to the fingerprint query, for consumers that shell out to psql. */
export const fingerprintSqlPath = join(HERE, 'fingerprint.sql')

/**
 * The fingerprint query, with the schema list substituted in.
 *
 * Schema names are quoted here rather than by the caller: the query embeds them
 * as SQL literals, so this is the one place an injection could be introduced.
 * A name containing a single quote is rejected rather than escaped, because no
 * legitimate schema in this context has one and silently accepting it would
 * hide a caller bug.
 */
export function fingerprintSql(schemas = ['public']) {
  if (!Array.isArray(schemas) || schemas.length === 0) {
    throw new TypeError('fingerprintSql: expected a non-empty array of schema names')
  }
  for (const s of schemas) {
    if (typeof s !== 'string' || !/^[A-Za-z_][A-Za-z0-9_$]*$/.test(s)) {
      throw new TypeError(`fingerprintSql: unsupported schema name ${JSON.stringify(s)}`)
    }
  }
  const list = schemas.map(s => `'${s}'`).join(',')
  return readFileSync(fingerprintSqlPath, 'utf8').replaceAll('__SCHEMAS__', list)
}

/** Corpus names that ship with this package. */
export const corpora = ['objects', 'hard-cases', 'ordering']

/**
 * Load one corpus by name.
 *
 * Cases are plain data — SQL plus metadata — so a harness in any language can
 * consume them without agreeing on how they should be run.
 */
export function loadCorpus(name) {
  if (!corpora.includes(name)) {
    throw new Error(`loadCorpus: unknown corpus ${JSON.stringify(name)}; expected one of ${corpora.join(', ')}`)
  }
  return JSON.parse(readFileSync(join(HERE, 'corpus', `${name}.json`), 'utf8'))
}
