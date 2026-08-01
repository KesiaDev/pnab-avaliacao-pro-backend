import type { DriveRoutesOptions } from "../../src/api/routes/drive.js";

// Chave de 64 hex chars (32 bytes) só pra teste -- não usada em produção.
export const TEST_TOKEN_ENCRYPTION_KEY = "0".repeat(64);

export function driveOptionsStub(overrides: Partial<DriveRoutesOptions> = {}): DriveRoutesOptions {
  return {
    google: { clientId: "test-client-id", clientSecret: "test-client-secret", redirectUri: "https://api.test/v1/drive/oauth/callback" },
    tokenEncryptionKey: TEST_TOKEN_ENCRYPTION_KEY,
    frontendOrigin: "https://app.test",
    internalApi: {
      createJob: async () => ({ jobId: "job-1" }),
      updateStage: async () => ({ ok: true as const, jobStatus: "concluido" as const }),
      createDriveConnection: async () => ({ id: "conn-1" }),
      createDriveSource: async () => ({ id: "source-1", folderName: null }),
      createSyncRun: async () => ({ id: "sync-1" }),
      finishSyncRun: async () => ({ ok: true as const }),
      executeSyncRun: async () => ({ ok: true as const, stats: {} }),
    },
    findActiveConnection: async () => null,
    findDriveSourceForEdital: async () => null,
    enqueueSync: async () => undefined,
    ...overrides,
  };
}
