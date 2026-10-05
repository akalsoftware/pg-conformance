-- Structural fingerprint of a PostgreSQL schema.
--
-- One query that renders everything about a set of schemas which a migration
-- could get wrong, as sorted text. Two databases are structurally identical if
-- and only if this returns the same string for both.
--
-- Why the catalog and not information_schema
-- ------------------------------------------
-- information_schema is a standardised view over the catalog, and the standard
-- has no concept of most of what matters here. It cannot tell a partitioned
-- table from an ordinary one, has nowhere to put a partition bound, and does
-- not expose identity sequence options, generated-column storage, compression
-- or collation. Every one of those has hidden a real bug.
--
-- Why bodies, not names
-- --------------------
-- Objects that carry a body are compared by that body. Comparing names alone
-- reports a view whose predicate was inverted, a function whose implementation
-- was replaced, and a trigger moved from AFTER INSERT to BEFORE UPDATE as
-- identical — three schemas differing in the ways most likely to matter.
--
-- Where PostgreSQL can render an object canonically (pg_get_viewdef,
-- pg_get_constraintdef, pg_get_functiondef, pg_get_triggerdef, pg_get_expr)
-- that rendering is what gets compared, so both sides are produced by the same
-- server code and formatting can never manufacture a difference.
--
-- Definitions are flattened to one line. Entries are joined with newlines, so a
-- multi-line body would otherwise arrive as several unattributed entries —
-- losing the object name and making sort order depend on the body's layout.
--
-- Usage
-- -----
-- Replace the token __SCHEMAS__ with a quoted, comma-separated schema list,
-- e.g. 'public','app'. The language accessors do this for you and handle
-- quoting; do not interpolate user input by hand.
--
-- Requires PostgreSQL 14 or newer (pg_attribute.attcompression).

SELECT string_agg(line, E'\n' ORDER BY line) AS fingerprint FROM (

  -- Relations. relkind distinguishes a partitioned table from an ordinary one;
  -- relpartbound is the only place a partition's bound exists; relpersistence
  -- carries UNLOGGED; reloptions carries fillfactor and friends.
  SELECT format('rel %s.%s kind=%s persist=%s bound=%s opts=%s rls=%s force_rls=%s',
                n.nspname, c.relname, c.relkind, c.relpersistence,
                COALESCE(btrim(regexp_replace(pg_get_expr(c.relpartbound, c.oid), '\s+', ' ', 'g')), '-'),
                COALESCE(array_to_string(c.reloptions, ','), '-'),
                c.relrowsecurity, c.relforcerowsecurity) AS line
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname IN (__SCHEMAS__)
     AND c.relkind IN ('r','p','v','m','f','S')

  UNION ALL

  -- Columns, read from pg_attribute so identity, generated, storage,
  -- compression and collation are visible at all.
  SELECT format('col %s.%s.%s type=%s notnull=%s default=%s ident=%s gen=%s store=%s compress=%s coll=%s',
                n.nspname, c.relname, a.attname,
                format_type(a.atttypid, a.atttypmod),
                a.attnotnull,
                COALESCE(btrim(regexp_replace(pg_get_expr(d.adbin, d.adrelid), '\s+', ' ', 'g')), '-'),
                a.attidentity, a.attgenerated, a.attstorage,
                COALESCE(a.attcompression::text, '-'),
                COALESCE(co.collname, '-'))
    FROM pg_attribute a
    JOIN pg_class c ON c.oid = a.attrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
    LEFT JOIN pg_collation co ON co.oid = a.attcollation
   WHERE n.nspname IN (__SCHEMAS__)
     AND a.attnum > 0 AND NOT a.attisdropped
     AND c.relkind IN ('r','p','v','m','f')

  UNION ALL

  -- Sequence options. An identity column's sequence is part of the column: a
  -- table rebuilt without INCREMENT and START silently restarts its counter.
  SELECT format('seq %s.%s start=%s inc=%s min=%s max=%s cache=%s cycle=%s',
                n.nspname, c.relname,
                s.seqstart, s.seqincrement, s.seqmin, s.seqmax, s.seqcache, s.seqcycle)
    FROM pg_sequence s
    JOIN pg_class c ON c.oid = s.seqrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname IN (__SCHEMAS__)

  UNION ALL

  -- Constraints, including whether they are validated and how they defer —
  -- a NOT VALID check and a validated one are not the same constraint.
  SELECT format('con %s.%s.%s %s valid=%s deferrable=%s deferred=%s',
                n.nspname, c.relname, con.conname,
                btrim(regexp_replace(pg_get_constraintdef(con.oid), '\s+', ' ', 'g')),
                con.convalidated, con.condeferrable, con.condeferred)
    FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname IN (__SCHEMAS__)

  UNION ALL

  -- Indexes, per relation. An index created ON ONLY a partitioned parent never
  -- reaches its partitions, and only a per-relation comparison shows that.
  SELECT format('idx %s.%s %s', schemaname, indexname,
                btrim(regexp_replace(indexdef, '\s+', ' ', 'g')))
    FROM pg_indexes
   WHERE schemaname IN (__SCHEMAS__)

  UNION ALL

  -- Views and materialised views, by body.
  SELECT format('view %s.%s %s opts=%s',
                n.nspname, c.relname,
                btrim(regexp_replace(pg_get_viewdef(c.oid, true), '\s+', ' ', 'g')),
                COALESCE(array_to_string(c.reloptions, ','), '-'))
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname IN (__SCHEMAS__)
     AND c.relkind IN ('v','m')

  UNION ALL

  -- Routines, by body. prokind is filtered because pg_get_functiondef raises
  -- an error on aggregate and window functions.
  SELECT format('fn %s.%s(%s) %s',
                n.nspname, p.proname,
                pg_get_function_identity_arguments(p.oid),
                btrim(regexp_replace(pg_get_functiondef(p.oid), '\s+', ' ', 'g')))
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname IN (__SCHEMAS__)
     AND p.prokind IN ('f','p')

  UNION ALL

  -- Triggers, by definition. tgparentid excludes the per-partition clones
  -- PostgreSQL creates automatically, which are not independent objects.
  SELECT format('trg %s.%s.%s %s',
                n.nspname, c.relname, t.tgname,
                btrim(regexp_replace(pg_get_triggerdef(t.oid), '\s+', ' ', 'g')))
    FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname IN (__SCHEMAS__)
     AND NOT t.tgisinternal
     AND t.tgparentid = 0

  UNION ALL

  -- Policies. USING alone is not the policy: the command, the roles and the
  -- WITH CHECK expression all decide who may do what.
  SELECT format('pol %s.%s.%s cmd=%s permissive=%s roles=%s using=%s check=%s',
                schemaname, tablename, policyname, cmd, permissive,
                array_to_string(roles, ','),
                COALESCE(btrim(regexp_replace(qual, '\s+', ' ', 'g')), '-'),
                COALESCE(btrim(regexp_replace(with_check, '\s+', ' ', 'g')), '-'))
    FROM pg_policies
   WHERE schemaname IN (__SCHEMAS__)

  UNION ALL

  -- Enums, domains and composite types. Enum label order is significant:
  -- it decides comparison and ORDER BY.
  --
  -- Every kind's content is carried inline, the way enum labels are, because no
  -- other section can reach it. The col section reads relations (relkind
  -- r/p/v/m/f) and so never sees a standalone composite's attributes, which are
  -- on a 'c'; the con section joins conrelid, while a domain's CHECK is keyed by
  -- contypid and has no conrelid at all. Until these were here, a composite of
  -- (street text, city text) and one of (postcode int) fingerprinted the same,
  -- as did domains with CHECK (VALUE > 0) and CHECK (VALUE < -999) — the same
  -- class of silent agreement this file exists to prevent.
  --
  -- Only CHECK constraints are read. PostgreSQL 17 began recording a domain's
  -- NOT NULL as a constraint row of its own, and notnull= already carries it;
  -- taking every row would both state it twice and make one logical domain
  -- fingerprint differently either side of that release.
  SELECT format('typ %s.%s kind=%s labels=%s default=%s notnull=%s base=%s attrs=%s checks=%s',
                n.nspname, t.typname, t.typtype,
                COALESCE((SELECT string_agg(e.enumlabel, ',' ORDER BY e.enumsortorder)
                            FROM pg_enum e WHERE e.enumtypid = t.oid), '-'),
                COALESCE(btrim(regexp_replace(pg_get_expr(t.typdefaultbin, 0), '\s+', ' ', 'g')), '-'),
                t.typnotnull,
                COALESCE(CASE WHEN t.typtype = 'd'
                              THEN format_type(t.typbasetype, t.typtypmod) END, '-'),
                COALESCE((SELECT string_agg(
                                   format('%s %s', a.attname,
                                          format_type(a.atttypid, a.atttypmod)),
                                   ',' ORDER BY a.attnum)
                            FROM pg_attribute a
                           WHERE a.attrelid = t.typrelid
                             AND a.attnum > 0 AND NOT a.attisdropped), '-'),
                COALESCE((SELECT string_agg(
                                   format('%s %s', con.conname,
                                          btrim(regexp_replace(
                                            pg_get_constraintdef(con.oid), '\s+', ' ', 'g'))),
                                   ',' ORDER BY con.conname)
                            FROM pg_constraint con
                           WHERE con.contypid = t.oid
                             AND con.contype = 'c'), '-'))
    FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
   WHERE n.nspname IN (__SCHEMAS__)
     AND t.typtype IN ('e','d','c')
     AND NOT EXISTS (
       SELECT 1 FROM pg_class c
        WHERE c.oid = t.typrelid AND c.relkind <> 'c'
     )

  UNION ALL

  -- Inheritance, which is not implied by anything above.
  SELECT format('inh %s.%s <- %s.%s',
                pn.nspname, parent.relname, cn.nspname, child.relname)
    FROM pg_inherits i
    JOIN pg_class child ON child.oid = i.inhrelid
    JOIN pg_class parent ON parent.oid = i.inhparent
    JOIN pg_namespace cn ON cn.oid = child.relnamespace
    JOIN pg_namespace pn ON pn.oid = parent.relnamespace
   WHERE cn.nspname IN (__SCHEMAS__)

  UNION ALL

  -- Comments, on anything in the schemas: tables and columns, and functions,
  -- types, constraints, triggers, policies and the schemas themselves. Named
  -- as PostgreSQL identifies the object, so a column by its name: keyed by
  -- its position, the same comment on a column added last on one side read
  -- as a difference. An extension's objects are its own.
  SELECT format('cmt %s %s %s', i.type, i.identity,
                btrim(regexp_replace(d.description, '\s+', ' ', 'g')))
    FROM pg_description d
    CROSS JOIN LATERAL pg_identify_object(d.classoid, d.objoid, d.objsubid) i
   WHERE (i.schema IN (__SCHEMAS__)
          -- A trigger or a policy has no schema of its own: its table's.
          OR (SELECT n.nspname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
               WHERE c.oid = CASE d.classoid
                               WHEN 'pg_trigger'::regclass THEN (SELECT tgrelid FROM pg_trigger WHERE oid = d.objoid)
                               WHEN 'pg_policy'::regclass THEN (SELECT polrelid FROM pg_policy WHERE oid = d.objoid)
                             END) IN (__SCHEMAS__)
          OR (d.classoid = 'pg_namespace'::regclass
              AND d.objoid IN (SELECT oid FROM pg_namespace WHERE nspname IN (__SCHEMAS__))))
     AND NOT EXISTS (SELECT 1 FROM pg_depend e
                      WHERE e.deptype = 'e' AND e.classid = d.classoid AND e.objid = d.objoid)

) entries;
