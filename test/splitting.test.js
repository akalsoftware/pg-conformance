/**
 * The splitting corpus.
 *
 * Tools that render DDL with PostgreSQL's own utilities get whole-schema
 * output and need it one statement at a time. Splitting on semicolons is the
 * obvious approach and it is wrong: dollar-quoted bodies, semicolons inside
 * string literals and trailing comments all defeat it.
 *
 * These cases exist to prove that, so a consumer can check its own splitter
 * against something real rather than trusting it. The corpus is only worth
 * shipping if a naive splitter actually fails it, which is asserted here.
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { execFile as _execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { loadCorpus } from '../index.js'

const execFile = promisify(_execFile)
const PGURL = process.env.PGURL

/** The splitter anyone writes first: break on a semicolon that ends a line. */
function naiveSplit(sql) {
  return sql
    .split('\n').filter(l => !l.trimStart().startsWith('--')).join('\n')
    .split(/;\s*\n/).map(s => s.trim()).filter(Boolean)
}

describe('splitting corpus', () => {
  const cases = loadCorpus('splitting')

  test('every case declares a positive statement count', () => {
    assert.ok(cases.length > 0)
    for (const c of cases) {
      assert.ok(c.sql?.trim(), `${c.id}: needs sql`)
      assert.ok(Number.isInteger(c.statements) && c.statements > 0, `${c.id}: needs a statement count`)
      assert.ok(c.description?.trim(), `${c.id}: needs a description`)
    }
  })

  // If a naive splitter handled these, the corpus would be proving nothing.
  test('a naive splitter gets every case wrong', () => {
    const survived = cases
      .filter(c => naiveSplit(c.sql).length === c.statements)
      .map(c => c.id)

    assert.deepEqual(survived, [],
      'these cases are not adversarial and should be replaced or removed')
  })
})

const psql = async (db, sql) => {
  const url = new URL(PGURL); url.pathname = `/${db}`
  const { stdout } = await execFile('psql', [url.toString(), '-v', 'ON_ERROR_STOP=1', '-t', '-A', '-c', sql],
    { maxBuffer: 32 * 1024 * 1024 })
  return stdout
}

describe('splitting corpus against a live server', { skip: PGURL ? false : 'set PGURL to run' }, () => {
  // A case whose SQL does not run is not evidence of anything, and its
  // statement count could be wrong without anyone noticing.
  test('every case is valid SQL and creates what it claims', async () => {
    for (const c of loadCorpus('splitting')) {
      await psql('postgres', 'DROP DATABASE IF EXISTS pgc_split')
      await psql('postgres', 'CREATE DATABASE pgc_split')
      await psql('pgc_split', c.sql)

      const created = Number((await psql('pgc_split', `
        SELECT count(*) FROM (
          SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = 'public' AND c.relkind IN ('r','v')
          UNION ALL
          SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
           WHERE n.nspname = 'public' AND p.prokind = 'f'
        ) q`)).trim())

      assert.equal(created, c.statements,
        `${c.id}: declares ${c.statements} statements but created ${created} objects`)
    }
  })
})
