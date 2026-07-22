import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

const databaseUrl = process.env.DATABASE_URL;

const globalForDb = globalThis as typeof globalThis & {
  __arenaNextJsPostgresqlPool?: Pool;
  __arenaNextJsPostgresqlDb?: ReturnType<typeof drizzle>;
};

function createPool() {
  if (!databaseUrl) return undefined;
  return (
    globalForDb.__arenaNextJsPostgresqlPool ??
    new Pool({ connectionString: databaseUrl }),
  );
}

function createDb() {
  if (!databaseUrl) return undefined;
  if (globalForDb.__arenaNextJsPostgresqlDb) {
    return globalForDb.__arenaNextJsPostgresqlDb;
  }
  const pool = createPool();
  if (!pool) return undefined;
  if (process.env.NODE_ENV !== "production") {
    globalForDb.__arenaNextJsPostgresqlPool = pool;
  }
  const db = drizzle(pool);
  globalForDb.__arenaNextJsPostgresqlDb = db;
  return db;
}

const lazyDb = new Proxy({} as ReturnType<typeof drizzle>, {
  get(_target, prop, receiver) {
    const db = globalForDb.__arenaNextJsPostgresqlDb ?? createDb();
    if (!db) {
      throw new Error("DATABASE_URL is required");
    }
    const value = (db as any)[prop];
    return typeof value === "function" ? value.bind(db) : value;
  },
});

export const db = lazyDb;
