<?php

declare(strict_types=1);

namespace Akal\PgConformance;

/**
 * Accessor for the shared conformance data.
 *
 * The PHP and JavaScript accessors deliberately expose the same three things —
 * the fingerprint query, its path, and the corpora — so that a harness written
 * in either language is asking the same question of the database.
 */
final class Conformance
{
    /** Path to the fingerprint query, for callers that shell out to psql. */
    public static function fingerprintSqlPath(): string
    {
        return dirname(__DIR__) . '/fingerprint.sql';
    }

    /**
     * The fingerprint query with the schema list substituted in.
     *
     * Schema names are quoted here rather than by the caller, because the query
     * embeds them as SQL literals. A name that is not a plain identifier is
     * rejected rather than escaped: none is legitimate here, and accepting one
     * quietly would hide a bug in the caller.
     *
     * @param list<string> $schemas
     */
    public static function fingerprintSql(array $schemas = ['public']): string
    {
        return str_replace('__SCHEMAS__', self::schemaList($schemas), (string) file_get_contents(self::fingerprintSqlPath()));
    }

    /**
     * Quote a schema list for embedding as SQL literals.
     *
     * Rejects anything that is not a plain identifier rather than escaping it:
     * none is legitimate here, and accepting one quietly would hide a caller
     * bug. The single place either query could take an injection.
     *
     * @param list<string> $schemas
     */
    private static function schemaList(array $schemas): string
    {
        if ($schemas === []) {
            throw new \InvalidArgumentException('expected at least one schema name');
        }

        foreach ($schemas as $schema) {
            if (preg_match('/^[A-Za-z_][A-Za-z0-9_$]*$/', $schema) !== 1) {
                throw new \InvalidArgumentException(sprintf('unsupported schema name "%s"', $schema));
            }
        }

        return implode(',', array_map(static fn (string $s): string => "'$s'", $schemas));
    }

    /** Path to the state query, for callers that shell out to psql. */
    public static function stateSqlPath(): string
    {
        return dirname(__DIR__) . '/state.sql';
    }

    /**
     * The schema-state query with the schema list substituted in.
     *
     * @param list<string> $schemas
     */
    public static function stateSql(array $schemas = ['public']): string
    {
        return str_replace('__SCHEMAS__', self::schemaList($schemas), (string) file_get_contents(self::stateSqlPath()));
    }

    /** Corpus names that ship with this package. */
    public const CORPORA = ['objects', 'hard-cases', 'ordering', 'migrations', 'equivalences'];

    /**
     * Load one corpus by name.
     *
     * @return array<int, array<string, mixed>>
     */
    public static function loadCorpus(string $name): array
    {
        if (!in_array($name, self::CORPORA, true)) {
            throw new \InvalidArgumentException(
                sprintf('loadCorpus: unknown corpus "%s"; expected one of %s', $name, implode(', ', self::CORPORA))
            );
        }

        $path = dirname(__DIR__) . "/corpus/$name.json";

        return json_decode((string) file_get_contents($path), true, 512, JSON_THROW_ON_ERROR);
    }
}
