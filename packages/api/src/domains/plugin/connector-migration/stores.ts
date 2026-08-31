import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import {
  cloneConnectorMigrationSnapshot,
  emptyConnectorMigrationSnapshot,
  parseConnectorMigrationSnapshot,
} from './snapshot.js';
import type {
  ConnectorMigrationRecord,
  ConnectorMigrationRecordStore,
  ConnectorMigrationSnapshot,
  ConnectorMigrationStore,
  ConnectorMigrationTransaction,
} from './types.js';
import { ConnectorMigrationError } from './types.js';

function clone<T>(value: T): T {
  return structuredClone(value);
}

function transactionFor(snapshot: ConnectorMigrationSnapshot): {
  readonly transaction: ConnectorMigrationTransaction;
  readonly snapshot: () => ConnectorMigrationSnapshot;
} {
  const state = new Map(snapshot.records.map((record) => [record.connectorId, clone(record)]));
  const records: ConnectorMigrationRecordStore = {
    get: (connectorId) => {
      const record = state.get(connectorId);
      return record ? clone(record) : undefined;
    },
    list: () => [...state.values()].map(clone),
    put: (record: ConnectorMigrationRecord) => state.set(record.connectorId, clone(record)),
  };
  return {
    transaction: { records },
    snapshot: () =>
      parseConnectorMigrationSnapshot({
        schemaVersion: 1,
        records: [...state.values()].sort((left, right) => left.connectorId.localeCompare(right.connectorId)),
      }),
  };
}

class TransactionQueue {
  private tail: Promise<void> = Promise.resolve();

  async run<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.tail;
    let release = () => {};
    this.tail = new Promise<void>((resolveTail) => {
      release = resolveTail;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  settled(): Promise<void> {
    return this.tail;
  }
}

export class MemoryConnectorMigrationStore implements ConnectorMigrationStore {
  private state: ConnectorMigrationSnapshot;
  private readonly queue = new TransactionQueue();

  constructor(initial?: unknown) {
    this.state = initial === undefined ? emptyConnectorMigrationSnapshot() : parseConnectorMigrationSnapshot(initial);
  }

  async snapshot(): Promise<ConnectorMigrationSnapshot> {
    await this.queue.settled();
    return cloneConnectorMigrationSnapshot(this.state);
  }

  transaction<T>(work: (transaction: ConnectorMigrationTransaction) => Promise<T> | T): Promise<T> {
    return this.queue.run(async () => {
      const candidate = transactionFor(this.state);
      const result = await work(candidate.transaction);
      this.state = candidate.snapshot();
      return result;
    });
  }
}

function isNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

class FileQueueRegistry {
  private readonly queues = new Map<string, TransactionQueue>();

  forPath(path: string): TransactionQueue {
    const existing = this.queues.get(path);
    if (existing) return existing;
    const queue = new TransactionQueue();
    this.queues.set(path, queue);
    return queue;
  }
}

const fileQueues = new FileQueueRegistry();

export interface ConnectorMigrationFileOps {
  readonly readFile: typeof readFile;
  readonly mkdir: typeof mkdir;
  readonly writeFile: typeof writeFile;
  readonly rename: typeof rename;
  readonly unlink: typeof unlink;
}

export interface FileConnectorMigrationStoreOptions {
  readonly fileOps?: Partial<ConnectorMigrationFileOps>;
}

export class FileConnectorMigrationStore implements ConnectorMigrationStore {
  readonly path: string;
  private readonly queue: TransactionQueue;
  private readonly fileOps: ConnectorMigrationFileOps;

  constructor(path: string, options: FileConnectorMigrationStoreOptions = {}) {
    this.path = resolve(path);
    this.queue = fileQueues.forPath(this.path);
    this.fileOps = { readFile, mkdir, writeFile, rename, unlink, ...options.fileOps };
  }

  private async load(): Promise<ConnectorMigrationSnapshot> {
    let raw: string;
    try {
      raw = await this.fileOps.readFile(this.path, 'utf8');
    } catch (error) {
      if (isNotFound(error)) return emptyConnectorMigrationSnapshot();
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new ConnectorMigrationError(
        'CORRUPT_SNAPSHOT',
        `connector migration state at ${this.path} is not valid JSON`,
      );
    }
    return parseConnectorMigrationSnapshot(parsed);
  }

  async snapshot(): Promise<ConnectorMigrationSnapshot> {
    await this.queue.settled();
    return cloneConnectorMigrationSnapshot(await this.load());
  }

  transaction<T>(work: (transaction: ConnectorMigrationTransaction) => Promise<T> | T): Promise<T> {
    return this.queue.run(async () => {
      const candidate = transactionFor(await this.load());
      const result = await work(candidate.transaction);
      const next = candidate.snapshot();
      await this.fileOps.mkdir(dirname(this.path), { recursive: true });
      const temporaryPath = `${this.path}.tmp-${process.pid}-${randomUUID()}`;
      try {
        await this.fileOps.writeFile(temporaryPath, `${JSON.stringify(next, null, 2)}\n`, {
          encoding: 'utf8',
          mode: 0o600,
        });
        await this.fileOps.rename(temporaryPath, this.path);
      } catch (error) {
        try {
          await this.fileOps.unlink(temporaryPath);
        } catch {
          // Preserve the commit failure; cleanup is best effort.
        }
        throw error;
      }
      return result;
    });
  }
}
