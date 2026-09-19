/**
 * Shared-platform data access.
 *
 * One `query(sql, params)` surface over two Postgres implementations:
 *   - `pg` against DATABASE_URL (production)
 *   - PGlite, an in-process Postgres build, when DATABASE_URL is absent (local
 *     demo / CI). Both load the pgvector extension, so the SQL is identical.
 *
 * Nothing above this file knows which one is live.
 */
import type { Pool as PgPool } from "pg";

export type Row = Record<string, unknown>;
export type QueryResult<T = Row> = { rows: T[] };

export interface Database {
  query<T = Row>(sql: string, params?: unknown[]): Promise<QueryResult<T>>;
  exec(sql: string): Promise<void>;
  driver: "postgres" | "pglite";
}

type GlobalCache = { db?: Promise<Database>; ready?: Promise<void> };
const cache = globalThis as unknown as { __sdrDb?: GlobalCache };
cache.__sdrDb ??= {};

async function createPglite(): Promise<Database> {
  const { PGlite } = await import("@electric-sql/pglite");
  const { vector } = await import("@electric-sql/pglite-pgvector");
  const dataDir = process.env.PGLITE_DATA_DIR;
  const pg = new PGlite({ dataDir, extensions: { vector } });
  await pg.waitReady;
  return {
    driver: "pglite",
    async query<T = Row>(sql: string, params: unknown[] = []) {
      const res = await pg.query<T extends Record<string, unknown> ? T : never>(
        sql,
        params as never[],
      );
      return { rows: res.rows };
    },
    async exec(sql: string) {
      await pg.exec(sql);
    },
  };
}

async function createPostgres(url: string): Promise<Database> {
  const { Pool } = await import("pg");
  const pool: PgPool = new Pool({
    connectionString: url,
    ssl: url.includes("localhost") ? undefined : { rejectUnauthorized: false },
    max: 5,
  });
  return {
    driver: "postgres",
    async query<T = Row>(sql: string, params: unknown[] = []) {
      const res = await pool.query(sql, params);
      return { rows: res.rows as T[] };
    },
    async exec(sql: string) {
      await pool.query(sql);
    },
  };
}

function connect(): Promise<Database> {
  const url = process.env.DATABASE_URL;
  return url ? createPostgres(url) : createPglite();
}

/**
 * Returns a migrated, seeded database. The first caller pays for setup; every
 * later caller awaits the same promise, so a cold serverless start never runs
 * the migration twice.
 */
export async function getDb(): Promise<Database> {
  cache.__sdrDb!.db ??= connect();
  const db = await cache.__sdrDb!.db;
  cache.__sdrDb!.ready ??= (async () => {
    const { migrate } = await import("./migrate");
    const { seedIfEmpty } = await import("./seed");
    await migrate(db);
    await seedIfEmpty(db);
  })();
  await cache.__sdrDb!.ready;
  return db;
}

/** Escape hatch for migrate/seed, which must not re-enter getDb(). */
export async function getRawDb(): Promise<Database> {
  cache.__sdrDb!.db ??= connect();
  return cache.__sdrDb!.db;
}

export async function one<T = Row>(sql: string, params?: unknown[]): Promise<T | null> {
  const db = await getDb();
  const { rows } = await db.query<T>(sql, params);
  return rows[0] ?? null;
}

export async function many<T = Row>(sql: string, params?: unknown[]): Promise<T[]> {
  const db = await getDb();
  const { rows } = await db.query<T>(sql, params);
  return rows;
}
