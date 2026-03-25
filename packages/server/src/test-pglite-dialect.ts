/**
 * Kysely dialect backed by PGlite — for tests only.
 *
 * PGlite is a single-connection, in-process Postgres (WASM). This dialect wraps
 * it as a Kysely Driver by serializing queries through a promise queue: any
 * concurrent executeQuery call waits for the current one to finish before
 * proceeding, which matches PGlite's single-connection model without external
 * pooling overhead.
 */
import type { PGlite, Results } from "@electric-sql/pglite";
import {
  type CompiledQuery,
  CompiledQuery as CompiledQueryFactory,
  type DatabaseConnection,
  type DatabaseIntrospector,
  type Dialect,
  type DialectAdapter,
  type Driver,
  type Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type QueryCompiler,
  type QueryResult,
  type TransactionSettings,
} from "kysely";

class PGliteConnection implements DatabaseConnection {
  readonly #pglite: PGlite;

  constructor(pglite: PGlite) {
    this.#pglite = pglite;
  }

  async executeQuery<O>(compiledQuery: CompiledQuery): Promise<QueryResult<O>> {
    const result = await this.#pglite.query<O>(compiledQuery.sql, compiledQuery.parameters as unknown[]);
    return toQueryResult<O>(result);
  }

  // biome-ignore lint/correctness/useYield: Kysely requires this method but PGlite doesn't support streaming
  async *streamQuery<O>(_compiledQuery: CompiledQuery, _chunkSize?: number): AsyncIterableIterator<QueryResult<O>> {
    throw new Error("PGliteDialect does not support streaming queries");
  }
}

function toQueryResult<O>(result: Results<O>): QueryResult<O> {
  return {
    rows: result.rows,
    numAffectedRows: result.affectedRows != null ? BigInt(result.affectedRows) : undefined,
  };
}

class PGliteDriver implements Driver {
  readonly #pglite: PGlite;
  readonly #connection: PGliteConnection;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(pglite: PGlite) {
    this.#pglite = pglite;
    this.#connection = new PGliteConnection(pglite);
  }

  async init(): Promise<void> {
    await this.#pglite.waitReady;
  }

  async acquireConnection(): Promise<DatabaseConnection> {
    // PGlite is single-connection. Chain each acquisition onto the queue so
    // callers wait for the current holder to release before proceeding.
    const release = await new Promise<() => void>((resolve) => {
      this.#queue = this.#queue.then(() => new Promise<void>((releaseResolve) => resolve(releaseResolve)));
    });
    return new LockedConnection(this.#connection, release);
  }

  async beginTransaction(connection: DatabaseConnection, _settings: TransactionSettings): Promise<void> {
    await connection.executeQuery(CompiledQueryFactory.raw("BEGIN"));
  }

  async commitTransaction(connection: DatabaseConnection): Promise<void> {
    await connection.executeQuery(CompiledQueryFactory.raw("COMMIT"));
  }

  async rollbackTransaction(connection: DatabaseConnection): Promise<void> {
    await connection.executeQuery(CompiledQueryFactory.raw("ROLLBACK"));
  }

  async releaseConnection(connection: DatabaseConnection): Promise<void> {
    if (connection instanceof LockedConnection) {
      connection.release();
    }
  }

  async destroy(): Promise<void> {
    await this.#pglite.close();
  }
}

class LockedConnection implements DatabaseConnection {
  readonly #inner: PGliteConnection;
  readonly #release: () => void;

  constructor(inner: PGliteConnection, release: () => void) {
    this.#inner = inner;
    this.#release = release;
  }

  executeQuery<O>(compiledQuery: CompiledQuery): Promise<QueryResult<O>> {
    return this.#inner.executeQuery<O>(compiledQuery);
  }

  streamQuery<O>(compiledQuery: CompiledQuery, chunkSize?: number): AsyncIterableIterator<QueryResult<O>> {
    return this.#inner.streamQuery<O>(compiledQuery, chunkSize);
  }

  release(): void {
    this.#release();
  }
}

export interface PGliteDialectConfig {
  pglite: PGlite;
}

/**
 * Kysely dialect for PGlite. Use in tests that need a real Postgres dialect
 * without a running Postgres server.
 *
 * @example
 * const db = new Kysely<DB>({ dialect: new PGliteDialect({ pglite: new PGlite() }) });
 */
export class PGliteDialect implements Dialect {
  readonly #config: PGliteDialectConfig;

  constructor(config: PGliteDialectConfig) {
    this.#config = config;
  }

  createDriver(): Driver {
    return new PGliteDriver(this.#config.pglite);
  }

  createQueryCompiler(): QueryCompiler {
    return new PostgresQueryCompiler();
  }

  createAdapter(): DialectAdapter {
    return new PostgresAdapter();
  }

  createIntrospector(db: Kysely<unknown>): DatabaseIntrospector {
    return new PostgresIntrospector(db);
  }
}
