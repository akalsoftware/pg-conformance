-- Structural state of a PostgreSQL schema, as one JSON document.
--
-- The fingerprint answers "are these the same?". This answers "what is there?"
-- — the same catalog knowledge, shaped for a consumer to read rather than for
-- a string comparison. A tool holding two of these can compute its own diff
-- without trusting anyone else's idea of what changed.
--
-- Losslessness is the whole point, and it is why this reads pg_catalog rather
-- than information_schema or an existing schema API. Neither can express a
-- partition bound, an identity column's sequence options, per-column storage,
-- compression, or whether a collation was set or inherited. Every one of those
-- has hidden a real bug, so a state document blind to them would be a step
-- backwards from the fingerprint it sits beside.
--
-- Two conventions, both learned from getting them wrong:
--
--   Values are semantic, not catalog shorthand. attstorage 'x' is reported as
--   "extended" and attcompression 'l' as "lz4", because a consumer should not
--   have to memorise single letters that mean nothing outside pg_catalog.
--
--   Inherited defaults are null, not spelled out. A column that merely uses
--   the database collation reports null rather than "default", or every text
--   column in an unchanged schema would read as different.
--
-- Arrays are ordered so two runs over identical schemas produce byte-identical
-- output; jsonb sorts object keys itself.
--
-- Usage: replace __SCHEMAS__ with a quoted, comma-separated schema list. The
-- language accessors do this and handle quoting.
--
-- Requires PostgreSQL 14 or newer.

SELECT jsonb_pretty(jsonb_build_object(

  'meta', jsonb_build_object(
    'server_version_num', current_setting('server_version_num')::int,
    'schemas', (SELECT jsonb_agg(s ORDER BY s) FROM unnest(ARRAY[__SCHEMAS__]) AS s)
  ),

  -- Tables, partitioned tables and foreign tables, with their columns inline:
  -- a column has no meaning apart from its relation, and nesting keeps a
  -- consumer from having to re-join them.
  'tables', COALESCE((
    SELECT jsonb_agg(t ORDER BY t->>'schema', t->>'name') FROM (
      SELECT jsonb_build_object(
        'schema', n.nspname,
        'name', c.relname,
        'kind', CASE c.relkind WHEN 'r' THEN 'table' WHEN 'p' THEN 'partitioned_table'
                               WHEN 'f' THEN 'foreign_table' END,
        'unlogged', c.relpersistence = 'u',
        'partition_of', (SELECT p.relname FROM pg_inherits i
                          JOIN pg_class p ON p.oid = i.inhparent
                         WHERE i.inhrelid = c.oid AND c.relispartition),
        'partition_bound', pg_get_expr(c.relpartbound, c.oid),
        'partition_by', CASE WHEN c.relkind = 'p' THEN pg_get_partkeydef(c.oid) END,
        'inherits', (SELECT jsonb_agg(p.relname ORDER BY p.relname)
                       FROM pg_inherits i JOIN pg_class p ON p.oid = i.inhparent
                      WHERE i.inhrelid = c.oid AND NOT c.relispartition),
        'options', (SELECT jsonb_agg(o ORDER BY o) FROM unnest(c.reloptions) AS o),
        'rls_enabled', c.relrowsecurity,
        'rls_forced', c.relforcerowsecurity,
        'comment', obj_description(c.oid, 'pg_class'),
        'columns', (
          SELECT jsonb_agg(jsonb_build_object(
            'name', a.attname,
            'position', a.attnum,
            'type', format_type(a.atttypid, a.atttypmod),
            'not_null', a.attnotnull,
            'default', pg_get_expr(d.adbin, d.adrelid),
            'identity', CASE a.attidentity WHEN 'a' THEN 'always'
                                           WHEN 'd' THEN 'by_default' END,
            'identity_options', (
              SELECT jsonb_build_object('start', s.seqstart, 'increment', s.seqincrement,
                                        'min', s.seqmin, 'max', s.seqmax,
                                        'cache', s.seqcache, 'cycle', s.seqcycle)
                FROM pg_sequence s
               WHERE a.attidentity <> ''
                 AND s.seqrelid = pg_get_serial_sequence(
                       format('%I.%I', n.nspname, c.relname), a.attname)::regclass),
            'generated', CASE a.attgenerated WHEN 's' THEN 'stored' END,
            'storage', CASE a.attstorage WHEN 'p' THEN 'plain' WHEN 'e' THEN 'external'
                                         WHEN 'm' THEN 'main'  WHEN 'x' THEN 'extended' END,
            -- Null unless it differs from the type's own default, so a storage
            -- setting nobody chose does not read as a deliberate one.
            'storage_is_default', a.attstorage = tp.typstorage,
            'compression', CASE a.attcompression WHEN 'l' THEN 'lz4'
                                                 WHEN 'p' THEN 'pglz' END,
            -- An inherited collation is not a property of the column.
            'collation', NULLIF(co.collname, 'default'),
            'comment', col_description(c.oid, a.attnum)
          ) ORDER BY a.attnum)
          FROM pg_attribute a
          JOIN pg_type tp ON tp.oid = a.atttypid
          LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
          LEFT JOIN pg_collation co ON co.oid = a.attcollation
         WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped),
        'constraints', (
          SELECT jsonb_agg(jsonb_build_object(
            'name', con.conname,
            'type', CASE con.contype WHEN 'p' THEN 'primary_key' WHEN 'f' THEN 'foreign_key'
                                     WHEN 'u' THEN 'unique' WHEN 'c' THEN 'check'
                                     WHEN 'x' THEN 'exclusion' WHEN 'n' THEN 'not_null' END,
            'definition', pg_get_constraintdef(con.oid),
            'validated', con.convalidated,
            'deferrable', con.condeferrable,
            'deferred', con.condeferred
          ) ORDER BY con.conname)
          FROM pg_constraint con WHERE con.conrelid = c.oid),
        'indexes', (
          SELECT jsonb_agg(jsonb_build_object(
            'name', i.indexname, 'definition', i.indexdef
          ) ORDER BY i.indexname)
          FROM pg_indexes i
         WHERE i.schemaname = n.nspname AND i.tablename = c.relname),
        'policies', (
          SELECT jsonb_agg(jsonb_build_object(
            'name', p.polname,
            'command', CASE p.polcmd WHEN 'r' THEN 'select' WHEN 'a' THEN 'insert'
                                     WHEN 'w' THEN 'update' WHEN 'd' THEN 'delete'
                                     WHEN '*' THEN 'all' END,
            'permissive', p.polpermissive,
            'roles', (SELECT jsonb_agg(r.rolname ORDER BY r.rolname)
                        FROM unnest(p.polroles) AS ro JOIN pg_roles r ON r.oid = ro),
            'using', pg_get_expr(p.polqual, p.polrelid),
            'with_check', pg_get_expr(p.polwithcheck, p.polrelid)
          ) ORDER BY p.polname)
          FROM pg_policy p WHERE p.polrelid = c.oid),
        'triggers', (
          SELECT jsonb_agg(jsonb_build_object(
            'name', tg.tgname, 'definition', pg_get_triggerdef(tg.oid)
          ) ORDER BY tg.tgname)
          FROM pg_trigger tg
         WHERE tg.tgrelid = c.oid AND NOT tg.tgisinternal AND tg.tgparentid = 0)
      ) AS t
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname IN (__SCHEMAS__) AND c.relkind IN ('r','p','f')
    ) q), '[]'::jsonb),

  'views', COALESCE((
    SELECT jsonb_agg(v ORDER BY v->>'schema', v->>'name') FROM (
      SELECT jsonb_build_object(
        'schema', n.nspname, 'name', c.relname,
        'materialized', c.relkind = 'm',
        'definition', pg_get_viewdef(c.oid, true),
        'options', (SELECT jsonb_agg(o ORDER BY o) FROM unnest(c.reloptions) AS o),
        'comment', obj_description(c.oid, 'pg_class'),
        'columns', (SELECT jsonb_agg(jsonb_build_object(
                      'name', a.attname, 'type', format_type(a.atttypid, a.atttypmod))
                      ORDER BY a.attnum)
                      FROM pg_attribute a
                     WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped)
      ) AS v
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname IN (__SCHEMAS__) AND c.relkind IN ('v','m')
    ) q), '[]'::jsonb),

  -- Every sequence, with owned_by naming the column that brought it into being
  -- so a consumer can tell one it must reproduce from one a column already
  -- creates. An identity column's options are also reported on that column.
  --
  -- Both kinds of ownership count, and PostgreSQL records them differently: a
  -- serial column's sequence depends on it with deptype 'a', an identity
  -- column's with 'i'. Reading only 'a' reported every identity sequence as
  -- standalone.
  'sequences', COALESCE((
    SELECT jsonb_agg(s ORDER BY s->>'schema', s->>'name') FROM (
      SELECT jsonb_build_object(
        'schema', n.nspname, 'name', c.relname,
        'type', format_type(sq.seqtypid, NULL),
        'start', sq.seqstart, 'increment', sq.seqincrement,
        'min', sq.seqmin, 'max', sq.seqmax, 'cache', sq.seqcache, 'cycle', sq.seqcycle,
        'owned_by', (SELECT format('%I.%I', dc.relname, da.attname)
                       FROM pg_depend dep
                       JOIN pg_class dc ON dc.oid = dep.refobjid
                       JOIN pg_attribute da ON da.attrelid = dep.refobjid
                                           AND da.attnum = dep.refobjsubid
                      WHERE dep.objid = c.oid
                        AND dep.classid = 'pg_class'::regclass
                        AND dep.refclassid = 'pg_class'::regclass
                        AND dep.refobjsubid > 0
                        AND dep.deptype IN ('a', 'i') LIMIT 1)
      ) AS s
      FROM pg_sequence sq
      JOIN pg_class c ON c.oid = sq.seqrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname IN (__SCHEMAS__)
    ) q), '[]'::jsonb),

  'routines', COALESCE((
    SELECT jsonb_agg(f ORDER BY f->>'schema', f->>'name', f->>'arguments') FROM (
      SELECT jsonb_build_object(
        'schema', n.nspname, 'name', p.proname,
        'kind', CASE p.prokind WHEN 'p' THEN 'procedure' ELSE 'function' END,
        'arguments', pg_get_function_identity_arguments(p.oid),
        'definition', pg_get_functiondef(p.oid),
        'comment', obj_description(p.oid, 'pg_proc')
      ) AS f
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname IN (__SCHEMAS__) AND p.prokind IN ('f','p')
    ) q), '[]'::jsonb),

  'types', COALESCE((
    SELECT jsonb_agg(t ORDER BY t->>'schema', t->>'name') FROM (
      SELECT jsonb_build_object(
        'schema', n.nspname, 'name', t.typname,
        'kind', CASE t.typtype WHEN 'e' THEN 'enum' WHEN 'd' THEN 'domain'
                               WHEN 'c' THEN 'composite' END,
        'labels', (SELECT jsonb_agg(e.enumlabel ORDER BY e.enumsortorder)
                     FROM pg_enum e WHERE e.enumtypid = t.oid),
        'base_type', CASE WHEN t.typtype = 'd'
                          THEN format_type(t.typbasetype, t.typtypmod) END,
        'not_null', t.typnotnull,
        'default', pg_get_expr(t.typdefaultbin, 0),
        'constraints', (SELECT jsonb_agg(pg_get_constraintdef(con.oid) ORDER BY con.conname)
                          FROM pg_constraint con WHERE con.contypid = t.oid),
        'attributes', (SELECT jsonb_agg(jsonb_build_object(
                         'name', a.attname, 'type', format_type(a.atttypid, a.atttypmod))
                         ORDER BY a.attnum)
                         FROM pg_attribute a
                        WHERE a.attrelid = t.typrelid AND a.attnum > 0 AND NOT a.attisdropped)
      ) AS t
      FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
     WHERE n.nspname IN (__SCHEMAS__) AND t.typtype IN ('e','d','c')
       AND NOT EXISTS (SELECT 1 FROM pg_class c
                        WHERE c.oid = t.typrelid AND c.relkind <> 'c')
    ) q), '[]'::jsonb),

  'extensions', COALESCE((
    SELECT jsonb_agg(jsonb_build_object('name', e.extname, 'version', e.extversion)
                     ORDER BY e.extname)
      FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace
     WHERE n.nspname IN (__SCHEMAS__)), '[]'::jsonb)

)) AS state;
