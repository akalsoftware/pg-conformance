/**
 * The package's own tests.
 *
 * Two things need proving. First that the accessors behave — cheap, no
 * database. Second that the query actually runs and actually discriminates,
 * which needs a real server: a fingerprint that silently returns the same
 * string for everything would pass every consumer's test suite while proving
 * nothing, which is the exact failure this package exists to prevent.
 *
 * Set PGURL to run the database half. Without it those cases skip.
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { execFile as _execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fingerprintSql, fingerprintSqlPath, loadCorpus, corpora } from '../index.js'

const execFile = promisify(_execFile)
const PGURL = process.env.PGURL

describe('accessors', () => {
  test('substitutes the schema list', () => {
    const sql = fingerprintSql(['public', 'app'])
    assert.ok(!sql.includes('__SCHEMAS__'), 'token should be gone')
    assert.ok(sql.includes(`'public','app'`))
  })

  test('defaults to public', () => {
    assert.ok(fingerprintSql().includes(`'public'`))
  })

  test('rejects a schema name that could inject SQL', () => {
    assert.throws(() => fingerprintSql([`public'; DROP DATABASE x; --`]), /unsupported schema name/)
    assert.throws(() => fingerprintSql(['has space']), /unsupported schema name/)
    assert.throws(() => fingerprintSql([]), /non-empty array/)
  })

  test('every advertised corpus loads and is non-empty', () => {
    for (const name of corpora) {
      const cases = loadCorpus(name)
      assert.ok(Array.isArray(cases) && cases.length > 0, `${name} should be a non-empty array`)
      for (const c of cases) assert.ok(c.id, `${name}: every case needs an id`)
      const ids = cases.map(c => c.id)
      assert.equal(new Set(ids).size, ids.length, `${name}: ids must be unique`)
    }
  })

  test('rejects an unknown corpus', () => {
    assert.throws(() => loadCorpus('nope'), /unknown corpus/)
  })

  test('exposes a real path', async () => {
    const { readFileSync } = await import('node:fs')
    assert.ok(readFileSync(fingerprintSqlPath, 'utf8').includes('__SCHEMAS__'))
  })
})

// ── Against a real server ────────────────────────────────────────────────────

const psql = async (db, sql) => {
  const url = new URL(PGURL)
  url.pathname = `/${db}`
  const { stdout } = await execFile('psql', [url.toString(), '-v', 'ON_ERROR_STOP=1', '-t', '-A', '-c', sql],
    { maxBuffer: 32 * 1024 * 1024 })
  return stdout
}

const reset = async (db) => {
  await psql('postgres', `DROP DATABASE IF EXISTS ${db}`)
  await psql('postgres', `CREATE DATABASE ${db}`)
}

const fingerprintOf = async (db) => psql(db, fingerprintSql().replace(/;\s*$/, ''))

describe('fingerprint against a live server', { skip: PGURL ? false : 'set PGURL to run' }, () => {
  test('runs, and is stable for identical schemas', async () => {
    const ddl = `
      CREATE TYPE mood AS ENUM ('sad','ok');
      CREATE TABLE t (id bigint GENERATED ALWAYS AS IDENTITY (INCREMENT 10 START 100), m mood);
      CREATE VIEW v AS SELECT id FROM t WHERE id > 0;
      CREATE FUNCTION f() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$;
    `
    await reset('pgc_a'); await psql('pgc_a', ddl)
    await reset('pgc_b'); await psql('pgc_b', ddl)

    const a = await fingerprintOf('pgc_a')
    assert.ok(a.trim().length > 0, 'fingerprint should not be empty')
    assert.equal(a, await fingerprintOf('pgc_b'), 'identical schemas must fingerprint identically')
  })

  // Each pair differs in exactly one way, and every one of these was invisible
  // to at least one fingerprint that shipped before this package existed.
  const discriminations = {
    'view body': [
      `CREATE TABLE t (n int); CREATE VIEW v AS SELECT n FROM t WHERE n > 0;`,
      `CREATE TABLE t (n int); CREATE VIEW v AS SELECT n FROM t WHERE n < 0;`,
    ],
    'function body': [
      `CREATE FUNCTION f() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$;`,
      `CREATE FUNCTION f() RETURNS int LANGUAGE sql AS $$ SELECT 999 $$;`,
    ],
    'trigger timing': [
      `CREATE TABLE t (n int); CREATE FUNCTION g() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;
       CREATE TRIGGER tg AFTER INSERT ON t FOR EACH ROW EXECUTE FUNCTION g();`,
      `CREATE TABLE t (n int); CREATE FUNCTION g() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;
       CREATE TRIGGER tg BEFORE UPDATE ON t FOR EACH ROW EXECUTE FUNCTION g();`,
    ],
    'identity sequence options': [
      `CREATE TABLE t (id bigint GENERATED ALWAYS AS IDENTITY (INCREMENT 10 START 100));`,
      `CREATE TABLE t (id bigint GENERATED ALWAYS AS IDENTITY);`,
    ],
    'partitioned vs ordinary': [
      `CREATE TABLE t (id int, d date) PARTITION BY RANGE (d);`,
      `CREATE TABLE t (id int, d date);`,
    ],
    'enum label order': [
      `CREATE TYPE e AS ENUM ('a','b');`,
      `CREATE TYPE e AS ENUM ('b','a');`,
    ],
    'not-valid constraint': [
      `CREATE TABLE t (n int); ALTER TABLE t ADD CONSTRAINT c CHECK (n > 0) NOT VALID;`,
      `CREATE TABLE t (n int); ALTER TABLE t ADD CONSTRAINT c CHECK (n > 0);`,
    ],
    'column collation': [
      `CREATE TABLE t (s text COLLATE "C");`,
      `CREATE TABLE t (s text);`,
    ],
  }

  for (const [what, [left, right]] of Object.entries(discriminations)) {
    test(`distinguishes ${what}`, async () => {
      await reset('pgc_a'); await psql('pgc_a', left)
      await reset('pgc_b'); await psql('pgc_b', right)
      assert.notEqual(await fingerprintOf('pgc_a'), await fingerprintOf('pgc_b'),
        `${what} must be visible in the fingerprint`)
    })
  }

  test('every corpus case builds on this server', async () => {
    const server = Number((await psql('postgres', 'SHOW server_version_num')).trim()) / 10000
    for (const name of ['objects', 'hard-cases']) {
      for (const c of loadCorpus(name)) {
        if (c.minPgVersion && server < c.minPgVersion) continue
        const sql = c.sql ?? c.setup_sql
        if (!sql) continue
        await reset('pgc_c')
        await psql('pgc_c', sql)
        const fp = await fingerprintOf('pgc_c')
        assert.ok(fp.trim().length > 0, `${name}/${c.id}: produced an empty fingerprint`)
      }
    }
  })
})
