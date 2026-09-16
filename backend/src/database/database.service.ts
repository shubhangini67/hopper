import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { mkdirSync } from 'fs';
import { dirname, isAbsolute, join } from 'path';
import Database from 'better-sqlite3';

@Injectable()
export class DatabaseService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DatabaseService.name);
  private db!: Database.Database;

  get connection(): Database.Database {
    return this.db;
  }

  onModuleInit(): void {
    const filePath = resolveDatabasePath();
    mkdirSync(dirname(filePath), { recursive: true });
    this.db = new Database(filePath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('busy_timeout = 5000');
    this.migrate();
    this.logger.log(`SQLite ready at ${filePath}`);
  }

  onModuleDestroy(): void {
    this.db?.close();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        type TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT,
        last_error TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
      CREATE INDEX IF NOT EXISTS idx_jobs_created_at ON jobs(created_at);

      CREATE TABLE IF NOT EXISTS idempotency_keys (
        key TEXT PRIMARY KEY,
        job_id TEXT NOT NULL UNIQUE,
        request_hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE
      );
    `);

    const columns = new Set(
      (
        this.db.prepare('PRAGMA table_info(jobs)').all() as Array<{ name: string }>
      ).map((column) => column.name),
    );
    const add = (name: string, ddl: string) => {
      if (!columns.has(name)) {
        this.db.exec(`ALTER TABLE jobs ADD COLUMN ${ddl}`);
      }
    };
    add('assignee', 'assignee TEXT');
    add('held', 'held INTEGER NOT NULL DEFAULT 0');
    add('attempts', 'attempts INTEGER NOT NULL DEFAULT 0');
    add('max_attempts', 'max_attempts INTEGER NOT NULL DEFAULT 3');
    add('lease_until', 'lease_until TEXT');
    add('source_job_id', 'source_job_id TEXT');
    this.db.exec(
      'CREATE INDEX IF NOT EXISTS idx_jobs_claim ON jobs(status, held, created_at)',
    );
  }
}

export function resolveDatabasePath(): string {
  const fromEnv = process.env.DATABASE_PATH;
  if (fromEnv && fromEnv.length > 0) {
    return isAbsolute(fromEnv) ? fromEnv : join(process.cwd(), fromEnv);
  }
  return join(process.cwd(), 'data', 'hopper.sqlite');
}
