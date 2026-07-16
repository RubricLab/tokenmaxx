import { type FileHandle, open, readFile, rm } from "node:fs/promises";
import { z } from "zod";
import { ApplicationError } from "./errors.ts";

const DaemonLockSchema = z
  .object({
    ownerId: z.uuid(),
    processId: z.number().int().positive(),
    createdAt: z.iso.datetime(),
  })
  .strict();

export interface DaemonLock {
  release(): Promise<void>;
}

function isAlreadyExists(error: unknown): boolean {
  return error instanceof Error && "code" in error && Reflect.get(error, "code") === "EEXIST";
}

function processExists(processId: number): boolean {
  try {
    process.kill(processId, 0);
    return true;
  } catch (error) {
    return error instanceof Error && "code" in error && Reflect.get(error, "code") !== "ESRCH";
  }
}

async function readLock(lockPath: string): Promise<z.infer<typeof DaemonLockSchema> | null> {
  try {
    return DaemonLockSchema.parse(JSON.parse(await readFile(lockPath, "utf8")));
  } catch {
    return null;
  }
}

async function ownedLock(lockPath: string, fileHandle: FileHandle): Promise<DaemonLock> {
  const owner = DaemonLockSchema.parse({
    ownerId: crypto.randomUUID(),
    processId: process.pid,
    createdAt: new Date().toISOString(),
  });
  await fileHandle.writeFile(JSON.stringify(owner), "utf8");
  await fileHandle.sync();
  let released = false;
  return {
    async release() {
      if (released) {
        return;
      }
      released = true;
      await fileHandle.close();
      const current = await readLock(lockPath);
      if (current?.ownerId === owner.ownerId) {
        await rm(lockPath, { force: true });
      }
    },
  };
}

export async function acquireDaemonLock(lockPath: string): Promise<DaemonLock> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await ownedLock(lockPath, await open(lockPath, "wx", 0o600));
    } catch (error) {
      if (!isAlreadyExists(error)) {
        throw error;
      }
      const existing = await readLock(lockPath);
      if (existing === null) {
        throw new ApplicationError(
          "DAEMON_LOCKED",
          "Manager startup lock exists but has incomplete metadata; remove it only after confirming no manager is starting",
        );
      }
      if (processExists(existing.processId)) {
        throw new ApplicationError(
          "DAEMON_LOCKED",
          `Manager startup is already owned by process ${existing.processId}`,
        );
      }
      const unchanged = await readLock(lockPath);
      if (unchanged?.ownerId === existing.ownerId) {
        await rm(lockPath, { force: true });
      }
    }
  }
  throw new ApplicationError("DAEMON_LOCKED", "Could not acquire the manager startup lock");
}
