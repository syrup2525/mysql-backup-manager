import { randomUUID } from "node:crypto";
import { createClient } from "redis";
import { appConfig } from "./config.js";
import type { BackupResult, BackupTarget, BackupTargetInput } from "./types.js";

const TARGETS_KEY = "mysql-backup-manager:targets";

type RedisClient = ReturnType<typeof createClient>;

function parseTarget(raw: string): BackupTarget | null {
  try {
    const parsed = JSON.parse(raw) as BackupTarget;
    if (!parsed.id || !parsed.database || !parsed.host || !parsed.username) {
      return null;
    }

    return {
      ...parsed,
      port: Number(parsed.port) || 3306,
      enabled: Boolean(parsed.enabled)
    };
  } catch {
    return null;
  }
}

function serializeTarget(target: BackupTarget): string {
  return JSON.stringify(target);
}

export class BackupTargetStore {
  constructor(private readonly client: RedisClient) {}

  async listTargets(): Promise<BackupTarget[]> {
    const values = await this.client.hGetAll(TARGETS_KEY);
    return Object.values(values)
      .map(parseTarget)
      .filter((target): target is BackupTarget => target !== null)
      .sort((a, b) => a.database.localeCompare(b.database));
  }

  async getTarget(id: string): Promise<BackupTarget | null> {
    const raw = await this.client.hGet(TARGETS_KEY, id);
    return raw ? parseTarget(raw) : null;
  }

  async saveTarget(input: BackupTargetInput, id?: string): Promise<BackupTarget> {
    const now = new Date().toISOString();
    const existing = id ? await this.getTarget(id) : null;
    const target: BackupTarget = {
      id: existing?.id || id || randomUUID(),
      name: input.name?.trim() || input.database,
      host: input.host.trim(),
      port: input.port,
      database: input.database.trim(),
      username: input.username.trim(),
      password: input.password,
      enabled: input.enabled,
      createdAt: existing?.createdAt || now,
      updatedAt: now,
      lastResult: existing?.lastResult
    };

    await this.client.hSet(TARGETS_KEY, target.id, serializeTarget(target));
    return target;
  }

  async deleteTarget(id: string): Promise<void> {
    await this.client.hDel(TARGETS_KEY, id);
  }

  async updateLastResult(id: string, lastResult: BackupResult): Promise<void> {
    const target = await this.getTarget(id);
    if (!target) {
      return;
    }

    await this.client.hSet(
      TARGETS_KEY,
      id,
      serializeTarget({
        ...target,
        updatedAt: new Date().toISOString(),
        lastResult
      })
    );
  }

  async close(): Promise<void> {
    await this.client.quit();
  }
}

export async function createBackupTargetStore(redisUrl = appConfig.redisUrl): Promise<BackupTargetStore> {
  const client = createClient({ url: redisUrl });
  client.on("error", (error) => {
    console.error("Redis client error:", error);
  });

  await client.connect();
  return new BackupTargetStore(client);
}

