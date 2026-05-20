export type BackupStatus = "running" | "success" | "failure";

export interface BackupResult {
  status: BackupStatus;
  startedAt: string;
  completedAt?: string;
  message: string;
  filePath?: string;
}

export interface BackupTarget {
  id: string;
  name: string;
  host: string;
  port: number;
  database: string;
  username: string;
  password: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  lastResult?: BackupResult;
}

export interface BackupTargetInput {
  name?: string;
  host: string;
  port: number;
  database: string;
  username: string;
  password: string;
  enabled: boolean;
}

