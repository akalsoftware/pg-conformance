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

```bash
composer require akalforge/pg-conformance
```

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
use Akalforge\PgConformance\Conformance;

$sql = Conformance::fingerprintSql(['public']);
$cases = Conformance::loadCorpus('hard-cases');
```

Schema names are quoted by the accessor, not by you — the query embeds them as SQL literals, so that is the one place an injection could enter. A name that is not a plain identifier is rejected rather than escaped.

If you shell out to `psql`, use `fingerprintSqlPath` and substitute `__SCHEMAS__` yourself.

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

This package is `0.x` while the fingerprint settles. **Depend on it with `~0.0.x`, not `^0.0.x`** — under semver a caret on a `0.0.z` version allows no updates at all, so `^0.0.1` is an exact pin and you would never receive a release:

```jsonc
"@akalforge/pg-conformance": "~0.0.1"   // tracks 0.0.2, 0.0.3, ...
"@akalforge/pg-conformance": "^0.0.1"   // pinned to exactly 0.0.1
```

Once it reaches `0.1.0`, `^0.1.0` tracks the `0.1.x` line as you would expect.

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
