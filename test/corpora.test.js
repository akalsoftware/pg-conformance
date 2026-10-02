/**
 * The migrations and equivalences corpora: their shape, and — with PGURL set
 * — that every schema in them builds on a real server. CI runs this against
 * PostgreSQL 14 to 18.
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { execFile as _execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fingerprintSql, loadCorpus } from '../index.js'

const execFile = promisify(_execFile)
const PGURL = process.env.PGURL

const migrations = loadCorpus('migrations')
const equivalences = loadCorpus('equivalences')

describe('shape', () => {
  test('ids are unique across both corpora', () => {
    const ids = [...migrations, ...equivalences].map(c => c.id)
    assert.equal(new Set(ids).size, ids.length)
  })

  test('every migration has two different schemas and a description', () => {
    for (const c of migrations) {
      assert.ok(c.before && c.after && c.description && c.category, c.id)
      assert.notEqual(c.before, c.after, c.id)
    }
  })

  test('every equivalence has two different spellings', () => {
    for (const c of equivalences) {
      assert.ok(c.written && c.rendered && c.kind, c.id)
      assert.notEqual(c.written, c.rendered, c.id)
    }
  })
})

const psql = async (db, sql) => {
  const url = new URL(PGURL)
  url.pathname = `/${db}`
  const { stdout } = await execFile('psql', [url.toString(), '-v', 'ON_ERROR_STOP=1', '-q', '-t', '-A', '-c', sql],
    { maxBuffer: 16 * 1024 * 1024 })
  return stdout.trim()
}

const freshDb = async (db, sql) => {
  await psql('postgres', `DROP DATABASE IF EXISTS ${db}`)
  await psql('postgres', `CREATE DATABASE ${db}`)
  await psql(db, sql)
}

describe('against a live server', { skip: PGURL ? false : 'set PGURL to run' }, () => {
  test('every migration schema builds, and its preserve queries run on both sides', async () => {
    const major = Math.floor(Number(await psql('postgres', 'SHOW server_version_num')) / 10000)
    for (const c of migrations.filter(m => (m.minPgVersion ?? 0) <= major)) {
      for (const side of ['before', 'after']) {
        await freshDb('pgc_corpus', c[side]).catch(e => assert.fail(`${c.id} ${side}: ${e.message}`))
        for (const q of c.preserve ?? []) {
          await psql('pgc_corpus', q).catch(e => assert.fail(`${c.id} ${side} preserve: ${e.message}`))
        }
      }
    }
    await psql('postgres', 'DROP DATABASE IF EXISTS pgc_corpus')
  })

  test('every equivalence builds both ways', async () => {
    for (const c of equivalences) {
      for (const side of ['written', 'rendered']) {
        await freshDb('pgc_corpus', c[side]).catch(e => assert.fail(`${c.id} ${side}: ${e.message}`))
      }
    }
    await psql('postgres', 'DROP DATABASE IF EXISTS pgc_corpus')
  })

  // Not yet true: the fingerprint compares renderings, and these pairs
  // render differently. Reported, not failed, until it re-renders them.
  test('the fingerprint calls every equivalence identical', { todo: 'fingerprint compares rendered text' }, async () => {
    for (const c of equivalences) {
      await freshDb('pgc_eq_w', c.written)
      await freshDb('pgc_eq_r', c.rendered)
      const sql = fingerprintSql().replace(/;\s*$/, '')
      assert.equal(await psql('pgc_eq_w', sql), await psql('pgc_eq_r', sql), c.id)
    }
  })
})
