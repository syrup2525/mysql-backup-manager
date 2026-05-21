import { createHash, pbkdf2Sync, randomBytes, timingSafeEqual } from "node:crypto";
import { createClient } from "redis";
import { appConfig } from "./config.js";

const AUTH_USER_KEY = "mysql-backup-manager:auth:user";
const SESSION_PREFIX = "mysql-backup-manager:auth:sessions:";
const PASSWORD_ITERATIONS = 310_000;
const PASSWORD_KEY_LENGTH = 32;
const PASSWORD_DIGEST = "sha256";

type RedisClient = ReturnType<typeof createClient>;

export interface AuthUser {
  username: string;
  passwordHash: string;
  passwordSalt: string;
  passwordIterations: number;
  passwordDigest: string;
  sessionVersion: string;
  updatedAt?: string;
}

export interface AuthSession {
  username: string;
  createdAt: number;
  sessionVersion: string;
}

function hashPassword(password: string, salt: string, iterations = PASSWORD_ITERATIONS, digest = PASSWORD_DIGEST): string {
  return pbkdf2Sync(password, salt, iterations, PASSWORD_KEY_LENGTH, digest).toString("hex");
}

function createPasswordRecord(password: string): Pick<AuthUser, "passwordHash" | "passwordSalt" | "passwordIterations" | "passwordDigest"> {
  const passwordSalt = randomBytes(16).toString("hex");
  return {
    passwordHash: hashPassword(password, passwordSalt),
    passwordSalt,
    passwordIterations: PASSWORD_ITERATIONS,
    passwordDigest: PASSWORD_DIGEST
  };
}

function safeCompareHex(actual: string, expected: string): boolean {
  try {
    const actualBuffer = Buffer.from(actual, "hex");
    const expectedBuffer = Buffer.from(expected, "hex");
    return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
  } catch {
    return false;
  }
}

function sessionKey(token: string): string {
  return `${SESSION_PREFIX}${createHash("sha256").update(token).digest("hex")}`;
}

function parseUser(fields: Record<string, string>): AuthUser | null {
  if (!fields.username || !fields.passwordHash || !fields.passwordSalt) {
    return null;
  }

  return {
    username: fields.username,
    passwordHash: fields.passwordHash,
    passwordSalt: fields.passwordSalt,
    passwordIterations: Number.parseInt(fields.passwordIterations || "", 10) || PASSWORD_ITERATIONS,
    passwordDigest: fields.passwordDigest || PASSWORD_DIGEST,
    sessionVersion: fields.sessionVersion || "legacy",
    updatedAt: fields.updatedAt
  };
}

function parseSession(raw: string | null): AuthSession | null {
  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as AuthSession;
    if (!parsed.username || !parsed.sessionVersion || !Number.isFinite(parsed.createdAt)) {
      return null;
    }

    return parsed;
  } catch {
    return null;
  }
}

export class AuthStore {
  constructor(
    private readonly client: RedisClient,
    private readonly sessionTtlSeconds = appConfig.authSessionTtlSeconds
  ) {}

  async getUser(): Promise<AuthUser | null> {
    return parseUser(await this.client.hGetAll(AUTH_USER_KEY));
  }

  async verifyPassword(username: string, password: string): Promise<boolean> {
    const user = await this.getUser();
    if (!user || user.username !== username) {
      return false;
    }

    const actualHash = hashPassword(password, user.passwordSalt, user.passwordIterations, user.passwordDigest);
    return safeCompareHex(actualHash, user.passwordHash);
  }

  async createSession(username: string): Promise<string> {
    const user = await this.getUser();
    if (!user || user.username !== username) {
      throw new Error("Cannot create session for unknown user.");
    }

    const token = randomBytes(32).toString("base64url");
    const session: AuthSession = {
      username,
      createdAt: Date.now(),
      sessionVersion: user.sessionVersion
    };

    await this.client.setEx(sessionKey(token), this.sessionTtlSeconds, JSON.stringify(session));
    return token;
  }

  async getSession(token: string): Promise<AuthSession | null> {
    const [user, session] = await Promise.all([this.getUser(), this.client.get(sessionKey(token)).then(parseSession)]);
    if (!user || !session || session.username !== user.username || session.sessionVersion !== user.sessionVersion) {
      return null;
    }

    await this.client.expire(sessionKey(token), this.sessionTtlSeconds);
    return session;
  }

  async deleteSession(token: string): Promise<void> {
    await this.client.del(sessionKey(token));
  }

  async changePassword(username: string, currentPassword: string, nextPassword: string): Promise<boolean> {
    const verified = await this.verifyPassword(username, currentPassword);
    if (!verified) {
      return false;
    }

    const record = createPasswordRecord(nextPassword);
    await this.client.hSet(AUTH_USER_KEY, {
      username,
      passwordHash: record.passwordHash,
      passwordSalt: record.passwordSalt,
      passwordIterations: record.passwordIterations.toString(),
      passwordDigest: record.passwordDigest,
      sessionVersion: randomBytes(16).toString("hex"),
      updatedAt: new Date().toISOString()
    });

    return true;
  }

  async close(): Promise<void> {
    await this.client.quit();
  }
}

export async function createAuthStore(redisUrl = appConfig.redisUrl): Promise<AuthStore> {
  const client = createClient({ url: redisUrl });
  client.on("error", (error) => {
    console.error("Redis auth client error:", error);
  });

  await client.connect();
  return new AuthStore(client);
}

