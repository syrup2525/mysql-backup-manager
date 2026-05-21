import { createWriteStream } from "node:fs";
import { rm } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { pipeline } from "node:stream/promises";
import { appConfig } from "../shared/config.js";
import { ensureBackupDir, pruneBackupFiles } from "../shared/files.js";
import { backupFileName, isSafePathSegment } from "../shared/paths.js";
import { createBackupTargetStore, type BackupTargetStore } from "../shared/store.js";
import type { BackupTarget } from "../shared/types.js";

const MAX_CAPTURED_OUTPUT = 12_000;

interface TargetBackupSuccess {
  target: BackupTarget;
  filePath: string;
  startedAt: string;
  deletedFiles: string[];
}

interface TargetBackupFailure {
  target: BackupTarget;
  error: Error;
}

function capture(current: string, chunk: Buffer): string {
  const next = current + chunk.toString("utf8");
  return next.length > MAX_CAPTURED_OUTPUT ? next.slice(-MAX_CAPTURED_OUTPUT) : next;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isFileExistsError(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as NodeJS.ErrnoException).code === "EEXIST";
}

function requireSafeMode(mode: string): string {
  if (!isSafePathSegment(mode)) {
    throw new Error(`MODE must be a single safe path segment. Current value: ${mode}`);
  }

  return mode;
}

async function runCommand(command: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  const child = spawn(command, args, {
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stdout = "";
  let stderr = "";

  child.stdout.on("data", (chunk: Buffer) => {
    stdout = capture(stdout, chunk);
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr = capture(stderr, chunk);
  });

  const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });

  if (exit.code !== 0) {
    const detail = stderr || stdout || `signal=${exit.signal ?? "none"}`;
    throw new Error(`${command} exited with code ${exit.code ?? "null"}: ${detail.trim()}`);
  }

  return { stdout, stderr };
}

async function runMysqldump(target: BackupTarget, outputPath: string): Promise<void> {
  const args = [
    `--host=${target.host}`,
    `--port=${target.port}`,
    `--user=${target.username}`,
    `--password=${target.password}`,
    "--single-transaction",
    "--routines",
    "--triggers",
    "--events",
    target.database
  ];

  const child = spawn("mysqldump", args, {
    stdio: ["ignore", "pipe", "pipe"]
  });
  const output = createWriteStream(outputPath, { flags: "wx", mode: 0o600 });
  let stderr = "";

  child.stderr.on("data", (chunk: Buffer) => {
    stderr = capture(stderr, chunk);
  });

  const exitPromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });

  try {
    const [exit] = await Promise.all([exitPromise, pipeline(child.stdout, output).then(() => null)]);
    if (exit.code !== 0) {
      const detail = stderr || `signal=${exit.signal ?? "none"}`;
      throw new Error(`mysqldump exited with code ${exit.code ?? "null"}: ${detail.trim()}`);
    }
  } catch (error) {
    child.kill();
    throw error;
  }
}

async function runBackupForTarget(
  store: BackupTargetStore,
  target: BackupTarget
): Promise<TargetBackupSuccess | TargetBackupFailure> {
  const startedAt = new Date().toISOString();
  let filePath: string | undefined;

  try {
    await store.updateLastResult(target.id, {
      status: "running",
      startedAt,
      message: "mysqldump 실행 중"
    });

    const dir = await ensureBackupDir(appConfig.backupRoot, target.database);
    filePath = path.join(dir, backupFileName(target.database));

    console.info(`[${target.database}] mysqldump start -> ${filePath}`);
    await runMysqldump(target, filePath);

    const deletedFiles = await pruneBackupFiles(appConfig.backupRoot, target.database, appConfig.backupKeepCount);
    console.info(`[${target.database}] local backup complete, pruned=${deletedFiles.length}`);

    return { target, filePath, startedAt, deletedFiles };
  } catch (error) {
    const message = errorMessage(error);
    console.error(`[${target.database}] backup failed: ${message}`);

    if (filePath && !isFileExistsError(error)) {
      await rm(filePath, { force: true });
    }

    await store.updateLastResult(target.id, {
      status: "failure",
      startedAt,
      completedAt: new Date().toISOString(),
      message
    });

    return {
      target,
      error: error instanceof Error ? error : new Error(message)
    };
  }
}

async function syncToGoogleDrive(): Promise<void> {
  const mode = requireSafeMode(appConfig.mode);
  const destination = `${appConfig.rcloneRemote}:/bak/${mode}`;
  console.info(`rclone sync ${appConfig.backupRoot} ${destination}`);
  await runCommand("rclone", ["sync", appConfig.backupRoot, destination, "--create-empty-src-dirs"]);
}

async function markSuccessfulResults(
  store: BackupTargetStore,
  successes: TargetBackupSuccess[],
  messageSuffix: string
): Promise<void> {
  await Promise.all(
    successes.map((success) =>
      store.updateLastResult(success.target.id, {
        status: "success",
        startedAt: success.startedAt,
        completedAt: new Date().toISOString(),
        filePath: success.filePath,
        message: `백업 및 rclone 동기화 완료${messageSuffix}`
      })
    )
  );
}

async function markSyncFailures(
  store: BackupTargetStore,
  successes: TargetBackupSuccess[],
  error: unknown
): Promise<void> {
  const message = `로컬 백업 완료, rclone 동기화 실패: ${errorMessage(error)}`;
  await Promise.all(
    successes.map((success) =>
      store.updateLastResult(success.target.id, {
        status: "failure",
        startedAt: success.startedAt,
        completedAt: new Date().toISOString(),
        filePath: success.filePath,
        message
      })
    )
  );
}

export async function runBackup(): Promise<number> {
  const store = await createBackupTargetStore();

  try {
    const targets = await store.listTargets();
    const enabledTargets = targets.filter((target) => target.enabled);

    if (enabledTargets.length === 0) {
      console.info("No enabled backup targets.");
      return 0;
    }

    const results: Array<TargetBackupSuccess | TargetBackupFailure> = [];
    for (const target of enabledTargets) {
      results.push(await runBackupForTarget(store, target));
    }
    const successes = results.filter((result): result is TargetBackupSuccess => !("error" in result));
    const failures = results.filter((result): result is TargetBackupFailure => "error" in result);

    if (successes.length > 0) {
      try {
        await syncToGoogleDrive();
        const prunedCount = successes.reduce((sum, success) => sum + success.deletedFiles.length, 0);
        const suffix = prunedCount > 0 ? `, 오래된 파일 ${prunedCount}개 삭제` : "";
        await markSuccessfulResults(store, successes, suffix);
      } catch (error) {
        console.error(`rclone sync failed: ${errorMessage(error)}`);
        await markSyncFailures(store, successes, error);
        return 1;
      }
    }

    return failures.length > 0 ? 1 : 0;
  } finally {
    await store.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runBackup()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
}
