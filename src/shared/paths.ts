import path from "node:path";

export function isSafePathSegment(value: string): boolean {
  return value.length > 0 && value !== "." && value !== ".." && !value.includes("/") && !value.includes("\\");
}

export function databaseBackupDir(backupRoot: string, database: string): string {
  if (!isSafePathSegment(database)) {
    throw new Error(`Unsafe database name for backup path: ${database}`);
  }

  return path.join(backupRoot, database);
}

export function timestampForFile(date = new Date()): string {
  const pad = (value: number) => value.toString().padStart(2, "0");

  return [
    date.getFullYear(),
    "-",
    pad(date.getMonth() + 1),
    "-",
    pad(date.getDate()),
    "_",
    pad(date.getHours()),
    "-",
    pad(date.getMinutes()),
    "-",
    pad(date.getSeconds())
  ].join("");
}

export function backupFileName(database: string, date = new Date()): string {
  if (!isSafePathSegment(database)) {
    throw new Error(`Unsafe database name for backup file: ${database}`);
  }

  return `${database}_${timestampForFile(date)}.sql`;
}

