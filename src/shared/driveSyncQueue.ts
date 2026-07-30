import { Queue, type ConnectionOptions } from "bullmq";
import type { Redis } from "ioredis";

export const DRIVE_SYNC_QUEUE = "drive-sync";

export interface DriveSyncJobData {
  syncRunId: string;
  driveSourceId: string;
  editalId: string;
}

export function createDriveSyncQueue(
  connection: Redis | ConnectionOptions,
): Queue<DriveSyncJobData> {
  return new Queue<DriveSyncJobData>(DRIVE_SYNC_QUEUE, { connection });
}

export function driveSyncJobOptions(maxAttempts: number) {
  return {
    attempts: maxAttempts,
    backoff: { type: "exponential" as const, delay: 2000 },
    removeOnComplete: { age: 60 * 60 * 24 * 7 },
    removeOnFail: false,
  };
}
