// FreeBSD daemonless patch for Papra's database setup — node:sqlite variant.
//
// WHY: Upstream uses `@libsql/client` whose `file:` driver loads the native
// `libsql` npm package, which ships NO FreeBSD prebuilt and no source-build
// fallback (even *importing* @libsql/client crashes on FreeBSD with
// `Cannot find module '@libsql/freebsd-x64'`).
//
// This variant replaces the driver with node26's BUILT-IN `node:sqlite`
// (DatabaseSync) instead of better-sqlite3. The win: no native addon, so the
// builder needs NO C toolchain / node-gyp / python — node:sqlite ships inside
// the node binary. drizzle has no first-class node:sqlite adapter, so we drive
// it through `drizzle-orm/sqlite-proxy` (a generic callback driver) and map
// node:sqlite's results into the positional `string[][]` shape the proxy wants.
//
// node:sqlite specifics relied on (node>=26, StatementSync):
//   - `.setReturnArrays(true)` → rows come back as positional value arrays,
//     exactly the sqlite-proxy contract (no object-key collisions on joins).
//   - `.columns()` → non-empty for readers (SELECT/PRAGMA); used to reproduce
//     libsql's `db.run().rows` shape (see attachLibsqlRun).
//
// Two libsql-only behaviours papra depends on, polyfilled below (same intent as
// the better-sqlite3 patch):
//   1. `db.batch([...])` — custom override (see attachBatch); sqlite-proxy's native
//      batch can't handle our eagerly-executed db.run() results.
//   2. `db.run/all/get(sql).rows`/objects — libsql returns row OBJECTS for raw SQL;
//      the bare sqlite-proxy callback returns positional arrays. Upstream reads by
//      column name (migrations 0010-0019 use `db.run(...).rows`; the health check
//      uses `db.all(...)`), so we override the raw helpers (see attachLibsqlRaw).
//
// NOTE: remote libSQL/Turso URLs are NOT supported here (no native client on
// FreeBSD). The container always uses a local `file:` DB, the standard self-host
// setup. node:sqlite is a Node release-candidate API (stability 1.2).

import type { ShutdownServices } from '../graceful-shutdown/graceful-shutdown.services';
import { DatabaseSync } from 'node:sqlite';
import { drizzle as drizzleProxy } from 'drizzle-orm/sqlite-proxy';

export { setupDatabase };

// Convert a `file:./app-data/db/db.sqlite` style URL into a filesystem path.
function fileUrlToPath(url: string): string {
  if (url === ':memory:' || url.startsWith(':memory:')) {
    return ':memory:';
  }

  let path = url.startsWith('file:') ? url.slice('file:'.length) : url;

  // Strip any query string (e.g. ?mode=rwc) — node:sqlite takes the bare path.
  const queryIndex = path.indexOf('?');
  if (queryIndex !== -1) {
    path = path.slice(0, queryIndex);
  }

  return path;
}

// drizzle passes only primitives (string/number/bigint/null/Uint8Array) for `?`
// markers, so a straight spread into node:sqlite's positional binding is safe
// (no plain object that would be misread as named parameters).
function bind(params: unknown[] | undefined): unknown[] {
  return params ?? [];
}

// sqlite-proxy main callback: execute one statement and return rows as positional
// value arrays. `method` is 'run' | 'all' | 'values' | 'get'.
function makeProxyCallback(sqlite: DatabaseSync) {
  return (sql: string, params: unknown[], method: string) => {
    const stmt = sqlite.prepare(sql);

    if (method === 'run') {
      stmt.run(...bind(params));
      return { rows: [] as unknown[] };
    }

    stmt.setReturnArrays(true);

    if (method === 'get') {
      // sqlite-proxy wants a single flat array for 'get'.
      const row = stmt.get(...bind(params)) as unknown[] | undefined;
      return { rows: row ?? [] };
    }

    // 'all' | 'values' → array of value-arrays.
    return { rows: stmt.all(...bind(params)) as unknown[][] };
  };
}

// Override `db.batch([...])` (libsql-only API papra uses in migrations/repos).
//
// We can't use sqlite-proxy's NATIVE batch: it calls `query._prepare()` on each
// item, but papra passes `db.run(sql`...`)` results — and our db.run (see
// attachLibsqlRun) executes EAGERLY and returns a plain libsql-shaped object with
// no `_prepare`. So we provide our own batch that runs any still-lazy drizzle
// builders and passes already-executed eager results through, wrapped in a
// transaction (skipped if we're already inside one — SQLite has no nested BEGIN).
//
// Note: statements created via `db.run(sql`...`)` have already auto-committed by
// the time batch() runs (they execute during array construction), so atomicity
// across those is not preserved — fine for papra's idempotent IF-NOT-EXISTS
// migrations and result-discarding write batches, same as the better-sqlite3 patch.
function attachBatch(db: any, sqlite: DatabaseSync) {
  db.batch = async (queries: any[]) => {
    const ownTx = !sqlite.isTransaction;
    if (ownTx) {
      sqlite.exec('BEGIN');
    }
    try {
      const results: unknown[] = [];
      for (const query of queries) {
        if (query && typeof query.execute === 'function') {
          results.push(await query.execute());
        } else if (query && typeof query.run === 'function') {
          results.push(await query.run());
        } else if (query && typeof query.all === 'function') {
          results.push(await query.all());
        } else {
          // Already-executed eager db.run(sql`...`) result — pass through.
          results.push(query);
        }
      }
      if (ownTx) {
        sqlite.exec('COMMIT');
      }
      return results;
    } catch (error) {
      if (ownTx && sqlite.isTransaction) {
        sqlite.exec('ROLLBACK');
      }
      throw error;
    }
  };

  return db;
}

// Override the top-level raw-SQL helpers `db.run` / `db.all` / `db.get` to return
// libsql's shapes (rows as OBJECTS, like libsql), executed directly against
// node:sqlite. drizzle's QUERY BUILDER (db.select().from(), etc.) does NOT go
// through these — it uses the session/proxy callback (positional arrays, which
// drizzle maps back to objects via the schema) — so overriding the convenience
// methods is safe and only affects raw `db.run/all/get(sql`...`)` call sites:
//   - db.run(sql`PRAGMA table_info(...)`).rows  → 7 upstream migrations (0010-0019)
//   - db.all(sql`SELECT 1 AS ok`)               → the health-check repository
// libsql returns row OBJECTS for these; the bare sqlite-proxy callback returns
// positional arrays, so without this override those by-name reads break.
function attachLibsqlRaw(db: any, sqlite: DatabaseSync) {
  const dialect = db.dialect;
  const render = (query: any): { sql: string; params: unknown[] } =>
    typeof query === 'string'
      ? { sql: query, params: [] }
      : dialect.sqlToQuery(query.getSQL());

  db.run = (query: any) => {
    const { sql: queryString, params } = render(query);
    const stmt = sqlite.prepare(queryString);
    const columns = stmt.columns();

    if (columns.length > 0) {
      // Reader (PRAGMA/SELECT) — return objects in libsql's `.rows` shape.
      return {
        rows: stmt.all(...bind(params)),
        columns: columns.map((c: any) => c.name),
        rowsAffected: 0,
        lastInsertRowid: 0,
      };
    }

    const info = stmt.run(...bind(params));
    return {
      rows: [],
      columns: [],
      rowsAffected: Number(info.changes),
      lastInsertRowid: info.lastInsertRowid,
    };
  };

  // libsql's db.all/db.get return row OBJECTS (keyed by column name).
  db.all = (query: any) => {
    const { sql: queryString, params } = render(query);
    return sqlite.prepare(queryString).all(...bind(params));
  };

  db.get = (query: any) => {
    const { sql: queryString, params } = render(query);
    return sqlite.prepare(queryString).get(...bind(params));
  };

  return db;
}

function setupDatabase({
  url,
  // authToken/encryptionKey are libsql-only; ignored on the node:sqlite path.
  authToken: _authToken,
  encryptionKey: _encryptionKey,
  shutdownServices,
}: {
  url: string;
  authToken?: string;
  encryptionKey?: string;
  shutdownServices?: ShutdownServices;
}) {
  const path = fileUrlToPath(url);
  const sqlite = new DatabaseSync(path);

  // Pragmas matching libsql's sensible defaults for a local single-writer file DB.
  sqlite.exec('PRAGMA journal_mode = WAL');
  sqlite.exec('PRAGMA foreign_keys = ON');
  sqlite.exec('PRAGMA busy_timeout = 5000');

  const db = attachBatch(
    attachLibsqlRaw(drizzleProxy(makeProxyCallback(sqlite)), sqlite),
    sqlite,
  );

  shutdownServices?.registerShutdownHandler({
    id: 'database-client-close',
    handler: () => {
      sqlite.close();
    },
  });

  return {
    db,
    client: sqlite,
  };
}
