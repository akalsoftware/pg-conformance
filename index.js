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
  return readFileSync(fingerprintSqlPath, 'utf8').replaceAll('__SCHEMAS__', schemaList(schemas))
}

/**
 * Quote a schema list for embedding as SQL literals.
 *
 * Any name PostgreSQL accepts is accepted here — `App Data`, `Ünïcode` — and
 * quoted by doubling its single quotes, which makes it a literal that cannot
 * end early. Restricting names to plain identifiers instead made a schema
 * named with a space impossible to compare at all.
 *
 * A backslash is still rejected: with standard_conforming_strings off it would
 * be an escape inside the literal, and no sane schema name needs one. So is
 * NUL, which no PostgreSQL name can contain. This is the single place either
 * query could take an injection.
 */
function schemaList(schemas) {
  if (!Array.isArray(schemas) || schemas.length === 0) {
    throw new TypeError('expected a non-empty array of schema names')
  }
  for (const s of schemas) {
    if (typeof s !== 'string' || s.length === 0 || /[\\\0]/.test(s)) {
      throw new TypeError(`unsupported schema name ${JSON.stringify(s)}`)
    }
  }
  return schemas.map(s => `'${s.replaceAll("'", "''")}'`).join(',')
}

/** Absolute path to the state query, for consumers that shell out to psql. */
export const stateSqlPath = join(HERE, 'state.sql')

/**
 * The schema-state query, with the schema list substituted in.
 *
 * Where the fingerprint answers "are these the same?", this answers "what is
 * there?" — the same catalog knowledge shaped as a JSON document, so a
 * consumer can compute its own diff rather than trusting someone else's idea
 * of what changed. Schema names are validated and quoted here for the same
 * reason as in fingerprintSql.
 */
export function stateSql(schemas = ['public']) {
  return readFileSync(stateSqlPath, 'utf8').replaceAll('__SCHEMAS__', schemaList(schemas))
}

/** Corpus names that ship with this package. */
export const corpora = ['objects', 'hard-cases', 'ordering', 'migrations', 'equivalences', 'data']

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
