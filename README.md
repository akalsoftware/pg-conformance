# @akalforge/pg-conformance

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
npm install @akalforge/pg-conformance
```

**PHP consumers install the same npm package.** This is not published to
Packagist, so `composer require` will not find it — the npm tarball ships
`src/Conformance.php`, which is how DBDiff consumes it:

```php
require_once 'node_modules/@akalforge/pg-conformance/src/Conformance.php';
```

One package means one version number for both languages, which matters more
here than idiomatic installation: a corpus whose whole job is to be the single
shared answer to "are these schemas the same?" should not be publishable at two
different versions at once. `composer.json` is kept for its autoload map and for
requiring this from git if you need to.

## Use

```js
import { fingerprintSql, loadCorpus } from '@akalforge/pg-conformance'

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
import { stateSql } from '@akalforge/pg-conformance'

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

`ordering` cases give statements in an order that does **not** apply, plus the precedences any correct order must satisfy — a property rather than one expected permutation, so a sorter's tie-breaking can change without invalidating the case.

Cases carry `minPgVersion` where they need a particular server.

## Requirements

PostgreSQL 14 or newer. Tested against 14, 15, 16, 17 and 18 on every change.

## Releases

Every merge to `main` publishes a patch automatically, so consumers track it without ceremony. `[minor]` or `[major]` in the merge commit subject, or a `release:minor` / `release:major` label on the PR, bumps further. `[skip release]` opts out.

This package is `0.x` while the fingerprint settles. From `0.1.0` onwards a
range behaves as you would expect — `^0.1.0` and `~0.1.0` both track the
`0.1.x` line:

```jsonc
"@akalforge/pg-conformance": "~0.1.0"   // tracks 0.1.1, 0.1.2, ...
```

While the package was on `0.0.z` that was not true, and it is worth knowing if
you find an old pin: under semver a caret on a `0.0.z` version allows no updates
at all, so `^0.0.1` was an exact pin that would never receive a release. Those
ranges wanted `~0.0.1`.

A minor bump is how a breaking change is signalled on `0.x`, so a range pinned
to one minor line will not cross it on its own. `0.1.0` renamed the PHP
namespace to `Akal\PgConformance`; a consumer on `~0.0.x` keeps the old one
until it widens the range deliberately.

Consumers pin through their lockfile as usual; a bot bumps that lockfile, so `npm ci` stays reproducible and still moves.

## Local development

```bash
npm link                                  # in this repo
npm link @akalforge/pg-conformance        # in the consumer
```

Run the package's own tests against a real server:

```bash
PGURL=postgresql://user:pass@127.0.0.1:5432/postgres npm test
```

Without `PGURL` the database half skips and only the accessors are checked. The database half is the half that matters: it asserts the fingerprint *discriminates*, since one that returned a constant would pass every consumer's suite while proving nothing.

## Licence

MIT
