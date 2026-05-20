import { mkdir, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { databaseBackupDir } from "./paths.js";

export interface BackupFileInfo {
  name: string;
  path: string;
  size: number;
  mtime: Date;
}

export async function ensureBackupDir(backupRoot: string, database: string): Promise<string> {
  const dir = databaseBackupDir(backupRoot, database);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export async function listBackupFiles(backupRoot: string, database: string): Promise<BackupFileInfo[]> {
  const dir = databaseBackupDir(backupRoot, database);

  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }

    throw error;
  }

  const files = await Promise.all(
    entries
      .filter((entry) => entry.endsWith(".sql"))
      .map(async (entry) => {
        const filePath = path.join(dir, entry);
        const info = await stat(filePath);
        return info.isFile()
          ? {
              name: entry,
              path: filePath,
              size: info.size,
              mtime: info.mtime
            }
          : null;
      })
  );

  return files
    .filter((file): file is BackupFileInfo => file !== null)
    .sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
}

export async function pruneBackupFiles(backupRoot: string, database: string, keep = 72): Promise<string[]> {
  const files = await listBackupFiles(backupRoot, database);
  const deleteTargets = files.slice(keep);

  await Promise.all(deleteTargets.map((file) => rm(file.path, { force: true })));
  return deleteTargets.map((file) => file.path);
}

