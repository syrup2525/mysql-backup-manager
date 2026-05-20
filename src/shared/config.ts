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

export const appConfig = {
  mode: process.env.MODE || "dev",
  redisUrl: process.env.REDIS_URL || "redis://127.0.0.1:6379",
  backupRoot: process.env.BACKUP_ROOT || "/home/user/bak",
  rcloneRemote: process.env.RCLONE_REMOTE || "gdrive",
  webHost: process.env.WEB_HOST || "0.0.0.0",
  webPort: readInteger("WEB_PORT", 3000)
};

