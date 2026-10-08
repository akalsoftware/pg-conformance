# pg-conformance

A PostgreSQL schema **fingerprint** and a **DDL conformance corpus**, shared by tools that need to agree on whether two schemas are the same.

Data only. No runner, no database driver, no opinion about how you test.

## Why this exists

Two tools that compare PostgreSQL schemas each had their own answer to "are these the same?". They diverged, quietly, and one of them ended up reporting these pairs as identical:

| | one side | the other |
| --- | --- | --- |
| view | `SELECT n FROM t WHERE n > 0` | `... WHERE n < 0` |
| function | `RETURNS int AS $$ SELECT 1 $$` | `... SELECT 999 $$` |
| trigger | `AFTER INSERT ON t` | `BEFORE UPDATE ON t` |
| identity | `GENERATED ALWAYS AS IDENTITY (INCREMENT 10 START 100)` | `GENERATED ALWAYS AS IDENTITY` |

None of those is exotic. Each was invisible because that fingerprint compared objects by *name* and read columns from `information_schema`, which cannot express identity options, generated columns, storage, compression or collation — and has nowhere to put a partition bound.

The fix is not a better fingerprint in each tool. It is one fingerprint.

## Install

```bash
npm install @akal/pg-conformance
```

**PHP consumers install the same npm package.** This is not published to
Packagist, so `composer require` will not find it — the npm tarball ships
`src/Conformance.php`, which is how DBDiff consumes it:

```php
require_once 'node_modules/@akal/pg-conformance/src/Conformance.php';
```

One package means one version number for both languages, which matters more
here than idiomatic installation: a corpus whose whole job is to be the single
shared answer to "are these schemas the same?" should not be publishable at two
different versions at once. `composer.json` is kept for its autoload map and for
requiring this from git if you need to.

## Use

```js
import { fingerprintSql, loadCorpus } from '@akal/pg-conformance'

const sql = fingerprintSql(['public'])
const a = await query(sourceDb, sql)
const b = await query(targetDb, sql)
if (a !== b) { /* the schemas differ */ }

for (const testCase of loadCorpus('hard-cases')) {
  // testCase.sql builds the objects; testCase.minPgVersion gates it
}
```

```php
use Akal\PgConformance\Conformance;

$sql = Conformance::fingerprintSql(['public']);
$cases = Conformance::loadCorpus('hard-cases');
```

Schema names are quoted by the accessor, not by you — the query embeds them as SQL literals, so that is the one place an injection could enter. A name that is not a plain identifier is rejected rather than escaped.

If you shell out to `psql`, use `fingerprintSqlPath` and substitute `__SCHEMAS__` yourself.

## Schema state

`fingerprintSql()` answers *are these the same?*. `stateSql()` answers *what is there?* — the same catalog knowledge shaped as a JSON document, so a consumer can compute its own diff instead of trusting someone else's idea of what changed.

```js
import { stateSql } from '@akal/pg-conformance'

const before = JSON.parse(await query(db, stateSql(['public'])))
// ... apply a migration ...
const after  = JSON.parse(await query(db, stateSql(['public'])))
```

```json
{
  "meta": { "server_version_num": 170011, "schemas": ["public"] },
  "tables": [{
    "schema": "public", "name": "orders", "kind": "partitioned_table",
    "unlogged": false, "partition_by": "RANGE (created_at)",
    "options": ["fillfactor=70"], "rls_enabled": true,
    "columns": [{
      "name": "id", "type": "bigint", "not_null": true,
      "identity": "always",
      "identity_options": { "start": 100, "increment": 10, "cycle": false },
      "storage": "plain", "compression": null, "collation": null
    }],
    "constraints": [...], "indexes": [...], "policies": [...], "triggers": [...]
  }],
  "views": [...], "sequences": [...], "routines": [...],
  "types": [...], "extensions": [...]
}
```

Two conventions, both learned from getting them wrong:

**Values are semantic, not catalog shorthand.** `attstorage` `'x'` is reported as `"extended"`, `attcompression` `'l'` as `"lz4"`, `attidentity` `'a'` as `"always"`. A consumer should not have to memorise single letters.

**Inherited defaults are `null`, not spelled out.** A column that merely uses the database collation reports `null` rather than `"default"` — otherwise every text column in an unchanged schema reads as different.

The state document is verified to distinguish **every pair of corpus schemas the fingerprint distinguishes** — 4005 pairs, zero misses — so adopting it loses nothing the fingerprint already caught. It is also byte-stable: identical schemas produce identical documents.

Existing schema APIs are not a substitute. `information_schema` cannot express a partition bound, identity sequence options, storage, compression or collation, and `postgres-meta` reads `relkind`/`relrowsecurity` but not `relpartbound`, `relpersistence` or `reloptions`, no identity options, and does not model sequences at all.

## What the fingerprint covers

Relations (kind, persistence, partition bound, storage options, RLS) · columns (type, nullability, default, identity, generated, storage, compression, collation) · sequence options · constraints (definition, validated, deferrable) · indexes, per relation · views and materialised views, **by body** · routines, **by body** · triggers, **by definition** · policies (command, roles, `USING`, `WITH CHECK`) · enums, domains and composite types · inheritance · comments.

Two principles decide the content:

**Read the catalog, not `information_schema`.** The standard has no concept of most of what matters here.

**Compare bodies, not names.** Where PostgreSQL can render an object canonically — `pg_get_viewdef`, `pg_get_constraintdef`, `pg_get_functiondef`, `pg_get_triggerdef` — that rendering is what gets compared, so both sides come from the same server code and formatting can never manufacture a difference.

Definitions are flattened to one line, because entries are newline-joined and a multi-line body would otherwise arrive as several unattributed entries.

## The corpora

| corpus | cases | what it is for |
| --- | --- | --- |
| `objects` | 20 | creating each object kind from an empty schema |
| `hard-cases` | 90 | DDL that is awkward to reproduce — identity options, generated columns, exclusion constraints, partitioning of all three strategies and multi-level, inheritance, collations, storage and TOAST parameters, compression, every index method, interval and range types, domains over domains, function overloads, `INSTEAD OF` and constraint triggers, restrictive policies |
| `ordering` | 12 | dependency ordering, with names chosen to defeat text matching |
| `migrations` | 52 | schema changes a migration tool must make in both directions — enum labels removed or reordered under views, policies and keys; identity, serial and storage changes; generated columns; types and functions created before, and dropped after, what uses them; cross-schema and multi-column foreign keys; objects in other schemas and in quoted ones; overloads, partitions, RLS, triggers, sequences and constraints |
| `equivalences` | 6 | one schema written two ways — as a developer writes it and as PostgreSQL renders it — which a comparison must call identical |
| `data` | 12 | rows a data migration must carry over both ways — text needing quoting, JSON, arrays, binary, numeric extremes, time zones, composite and missing keys, identity and generated columns, enums, domains and other types |

`ordering` cases give statements in an order that does **not** apply, plus the precedences any correct order must satisfy — a property rather than one expected permutation, so a sorter's tie-breaking can change without invalidating the case.

`migrations` cases give a `before` and an `after` schema. A tool migrating either into the other must leave it identical to a database built from the other directly, and its `preserve` queries must return the same rows on the migrated database as they did before it was migrated. They read only what a correct migration keeps — never a generated column whose expression changes, which it must recompute. These are the shapes found to produce SQL that is valid but cannot run, or that runs and loses something.

`equivalences` exist because PostgreSQL does not render every expression the same way twice: `status IN ('draft', 'active')` on a `varchar` column renders as `ARRAY[...]::text[]`, and recreated from that, as `ARRAY[(...)::text, ...]`. A dump, a restore or a generated migration changes the text and not the schema. **The fingerprint does not yet call these pairs identical** — it compares renderings — so a consumer comparing a database with a copy of it has to re-render one side (the package's own test reports this as a to-do).

`data` cases give one `schema` and two sets of rows. Migrating the `before` rows into the `after` rows, or back, must leave each `compare` query returning what it does on a database built from the other side directly. They are the values found to be quoted wrongly, or not handled at all, by a data diff.

Cases carry `minPgVersion` where they need a particular server.

## Requirements

PostgreSQL 14 or newer. Tested against 14, 15, 16, 17 and 18 on every change.

## Releases

Every merge to `main` publishes a patch automatically, so consumers track it
without ceremony. To ask for more than a patch, use any of these — the last one
wins, and is the one to rely on:

| How | Where |
| --- | --- |
| `[minor]` / `[major]` | anywhere in the commit message |
| `[minor]` / `[major]` | in the pull request title |
| `release:minor` / `release:major` | a label on the pull request |

`[skip release]` opts out.

This package is `0.x` while the fingerprint settles. **Depend on it with
`~0.0.x`, not `^0.0.x`** — under semver a caret on a `0.0.z` version allows no
updates at all, so `^0.0.6` is an exact pin and you would never receive a
release:

```jsonc
"@akal/pg-conformance": "~0.0.6"   // tracks 0.0.7, 0.0.8, ...
"@akal/pg-conformance": "^0.0.6"   // pinned to exactly 0.0.6
```

Once it reaches `0.1.0`, `^0.1.0` tracks the `0.1.x` line as you would expect.

`0.0.6` renamed the PHP namespace to `Akal\PgConformance`. A breaking change on
`0.x` should raise the minor, and that release was asked to — but the bump
detection read only the first line of the merge commit, which is
`Merge pull request …`, so the marker went unseen and a patch went out. The
detection is fixed; this is recorded because the version number cannot tell that
story on its own, and a reader wondering why a rename sits in a patch deserves
an answer.

Consumers pin through their lockfile as usual; a bot bumps that lockfile, so `npm ci` stays reproducible and still moves.

## Local development

```bash
npm link                                  # in this repo
npm link @akal/pg-conformance        # in the consumer
```

Run the package's own tests against a real server:

```bash
PGURL=postgresql://user:pass@127.0.0.1:5432/postgres npm test
```

Without `PGURL` the database half skips and only the accessors are checked. The database half is the half that matters: it asserts the fingerprint *discriminates*, since one that returned a constant would pass every consumer's suite while proving nothing.

## Licence

MIT
