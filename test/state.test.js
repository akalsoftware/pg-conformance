/**
 * The state document.
 *
 * Two properties decide whether this is usable, and neither is obvious from
 * reading the SQL.
 *
 * It must be *at least as discriminating as the fingerprint*. The fingerprint
 * is the thing already trusted to answer "are these the same?", so a state
 * document that misses a difference the fingerprint catches would be a
 * regression dressed as an upgrade — and a consumer diffing two states would
 * silently report no change.
 *
 * It must be *stable*. Consumers will compare documents, so identical schemas
 * have to produce identical bytes; an unordered array or a value that varies
 * between runs would manufacture differences that are not there.
 *
 * Set PGURL to run these. Without it they skip.
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { execFile as _execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { stateSql, stateSqlPath, fingerprintSql, loadCorpus } from '../index.js'

const execFile = promisify(_execFile)
const PGURL = process.env.PGURL

describe('stateSql accessor', () => {
  test('substitutes the schema list', () => {
    const sql = stateSql(['public', 'app'])
    assert.ok(!sql.includes('__SCHEMAS__'))
    assert.ok(sql.includes(`'public','app'`))
  })

  test('quotes any schema name so it cannot inject SQL, and rejects a backslash', () => {
    // A quote cannot end the literal early: it is doubled.
    assert.ok(stateSql([`public'; DROP DATABASE x; --`]).includes(`'public''; DROP DATABASE x; --'`))
    assert.throws(() => stateSql(['back\\\\slash']), /unsupported schema name/)
    assert.throws(() => stateSql(['']), /unsupported schema name/)
    assert.throws(() => stateSql([]), /non-empty array/)
  })

  test('exposes a real path', async () => {
    const { readFileSync } = await import('node:fs')
    assert.ok(readFileSync(stateSqlPath, 'utf8').includes('__SCHEMAS__'))
  })
})

const psql = async (db, sql) => {
  const url = new URL(PGURL); url.pathname = `/${db}`
  const { stdout } = await execFile('psql', [url.toString(), '-v', 'ON_ERROR_STOP=1', '-t', '-A', '-c', sql],
    { maxBuffer: 64 * 1024 * 1024 })
  return stdout
}
const reset = async (db) => {
  await psql('postgres', `DROP DATABASE IF EXISTS ${db}`)
  await psql('postgres', `CREATE DATABASE ${db}`)
}
const stateOf = async (db) => psql(db, stateSql().replace(/;\s*$/, ''))
const fpOf = async (db) => psql(db, fingerprintSql().replace(/;\s*$/, ''))

describe('state against a live server', { skip: PGURL ? false : 'set PGURL to run' }, () => {
  test('is valid JSON with the expected top-level shape', async () => {
    await reset('st_a')
    await psql('st_a', `CREATE TABLE t (id int); CREATE VIEW v AS SELECT id FROM t;`)
    const doc = JSON.parse(await stateOf('st_a'))

    for (const key of ['meta', 'tables', 'views', 'sequences', 'routines', 'types', 'extensions']) {
      assert.ok(key in doc, `missing top-level key: ${key}`)
    }
    assert.equal(doc.tables.length, 1)
    assert.equal(doc.views.length, 1)
    assert.ok(doc.meta.server_version_num > 0)
  })

  // Names were restricted to plain identifiers, so a schema called
  // `App Data` could not be described at all. Any name is accepted now, quoted.
  test('describes a schema whose name needs quoting, and nothing else for a hostile one', async () => {
    await reset('st_q')
    await psql('st_q', `CREATE SCHEMA "App Data"; CREATE TABLE "App Data"."Order Items" ("ID" int);
                        CREATE SCHEMA "it's"; CREATE TABLE "it's".t (id int);`)
    const doc = JSON.parse(await psql('st_q', stateSql(['App Data', "it's"]).replace(/;\s*$/, '')))
    assert.deepEqual(doc.tables.map(t => `${t.schema}.${t.name}`).sort(), ["App Data.Order Items", "it's.t"])

    const hostile = JSON.parse(await psql('st_q', stateSql([`x'); DROP SCHEMA "App Data" CASCADE; --`]).replace(/;\s*$/, '')))
    assert.deepEqual(hostile.tables ?? [], [])
    assert.equal(await psql('st_q', `SELECT count(*) FROM pg_namespace WHERE nspname = 'App Data'`), '1\n')
  })

  test('reports semantic values rather than catalog shorthand', async () => {
    await reset('st_b')
    await psql('st_b', `
      CREATE TABLE t (
        id bigint GENERATED ALWAYS AS IDENTITY (INCREMENT 10 START 100),
        name text COLLATE "C",
        total int GENERATED ALWAYS AS (1) STORED
      ) WITH (fillfactor = 70);`)
    const [table] = JSON.parse(await stateOf('st_b')).tables
    const col = (n) => table.columns.find(c => c.name === n)

    assert.equal(col('id').identity, 'always', 'expected a word, not the catalog letter')
    assert.equal(col('id').identity_options.increment, 10)
    assert.equal(col('id').identity_options.start, 100)
    assert.equal(col('name').collation, 'C')
    assert.equal(col('total').generated, 'stored')
    assert.deepEqual(table.options, ['fillfactor=70'])
  })

  // An inherited collation is not a property of the column. Reporting it would
  // make every text column in an unchanged schema read as different.
  test('does not report an inherited collation', async () => {
    await reset('st_c')
    await psql('st_c', `CREATE TABLE t (plain text, explicit text COLLATE "C");`)
    const [table] = JSON.parse(await stateOf('st_c')).tables

    assert.equal(table.columns.find(c => c.name === 'plain').collation, null)
    assert.equal(table.columns.find(c => c.name === 'explicit').collation, 'C')
  })

  // owned_by is how a consumer tells a sequence it must reproduce from one the
  // column already brings. Both kinds of ownership have to be reported, and
  // they are recorded differently: a serial column's sequence depends on it
  // with deptype 'a', an identity column's with 'i'. Reading only 'a' left
  // every identity sequence looking standalone, so a tool emitting DDL for what
  // it believed were standalone sequences produced CREATE SEQUENCE for one the
  // table already creates — "relation already exists".
  test('reports ownership for identity as well as serial sequences', async () => {
    await reset('st_own')
    await psql('st_own', `
      CREATE TABLE t_ser (id serial);
      CREATE TABLE t_ident (id bigint GENERATED ALWAYS AS IDENTITY);
      CREATE SEQUENCE truly_standalone;`)
    const byName = Object.fromEntries(
      JSON.parse(await stateOf('st_own')).sequences.map(s => [s.name, s.owned_by])
    )

    assert.equal(byName['t_ser_id_seq'], 't_ser.id')
    assert.equal(byName['t_ident_id_seq'], 't_ident.id')
    assert.equal(byName['truly_standalone'], null)
  })

  test('is byte-identical for identically built schemas', async () => {
    const ddl = `
      CREATE TYPE mood AS ENUM ('a','b');
      CREATE TABLE t (id bigint GENERATED ALWAYS AS IDENTITY, m mood);
      CREATE INDEX t_i ON t (m);
      CREATE VIEW v AS SELECT id FROM t WHERE id > 0;`
    await reset('st_d'); await psql('st_d', ddl)
    await reset('st_e'); await psql('st_e', ddl)

    assert.equal(await stateOf('st_d'), await stateOf('st_e'))
  })

  test('is stable across repeated runs on one schema', async () => {
    await reset('st_f')
    await psql('st_f', `CREATE TABLE a (x int); CREATE TABLE b (y int); CREATE TABLE c (z int);`)
    assert.equal(await stateOf('st_f'), await stateOf('st_f'))
  })

  /**
   * The property that matters most: the fingerprint is already trusted, so
   * state has to see everything it sees. Run over the corpus pairwise, which
   * is thousands of comparisons rather than a handful of hand-picked ones.
   */
  test('distinguishes every pair the fingerprint distinguishes', async () => {
    const server = Number((await psql('postgres', 'SHOW server_version_num')).trim()) / 10000
    const built = []

    for (const c of loadCorpus('hard-cases')) {
      if (c.minPgVersion && server < c.minPgVersion) continue
      await reset('st_g')
      await psql('st_g', c.sql)
      built.push({ id: c.id, fp: await fpOf('st_g'), st: await stateOf('st_g') })
    }
    assert.ok(built.length > 50, 'expected the corpus to build')

    const missed = []
    for (let i = 0; i < built.length; i++) {
      for (let j = i + 1; j < built.length; j++) {
        if (built[i].fp !== built[j].fp && built[i].st === built[j].st) {
          missed.push(`${built[i].id} vs ${built[j].id}`)
        }
      }
    }
    assert.deepEqual(missed, [], 'state must not be blind where the fingerprint is not')
  })
})
