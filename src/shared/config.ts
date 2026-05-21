import dotenv from "dotenv";

dotenv.config();

function readInteger(name: string, fallback: number): number {
  const value = process.env[name];
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function readBoolean(name: string, fallback: boolean): boolean {
  const value = process.env[name];
  if (!value) {
    return fallback;
  }

  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

export const appConfig = {
  mode: process.env.MODE || "dev",
  redisUrl: process.env.REDIS_URL || "redis://127.0.0.1:6379",
  backupRoot: process.env.BACKUP_ROOT || "/home/user/bak",
  rcloneRemote: process.env.RCLONE_REMOTE || "gdrive",
  webHost: process.env.WEB_HOST || "0.0.0.0",
  webPort: readInteger("WEB_PORT", 3000),
  authCookieName: process.env.AUTH_COOKIE_NAME || "mbm_session",
  authCookieSecure: readBoolean("AUTH_COOKIE_SECURE", false),
  authSessionTtlSeconds: readInteger("AUTH_SESSION_TTL_SECONDS", 8 * 60 * 60)
};
