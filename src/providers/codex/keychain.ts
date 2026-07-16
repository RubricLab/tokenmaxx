import { ApplicationError } from "../../errors.ts";
import type { CredentialVault } from "./auth.ts";

const defaultService = "com.rubriclabs.tokmax";

const base64Pattern = /^[A-Za-z0-9+/]+={0,2}$/;
const identifierPattern = /^[\w.@:-]+$/;

const chunkLength = 2_048;
const maximumChunkCount = 64;
const manifestPrefix = "tokmax-chunks:";

export interface KeychainCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface KeychainCommandRunner {
  run(command: readonly string[], stdinText?: string): Promise<KeychainCommandResult>;
}

function defaultKeychainCommandRunner(): KeychainCommandRunner {
  return {
    async run(command, stdinText) {
      const processHandle = Bun.spawn([...command], {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      });
      if (stdinText !== undefined) {
        processHandle.stdin.write(stdinText);
      }
      processHandle.stdin.end();
      const [exitCode, stdout, stderr] = await Promise.all([
        processHandle.exited,
        new Response(processHandle.stdout).text(),
        new Response(processHandle.stderr).text(),
      ]);
      return { exitCode, stdout, stderr };
    },
  };
}

function redactSecrets(diagnostic: string): string {
  const redacted = diagnostic.replace(/[A-Za-z0-9+/=]{32,}/g, "[redacted]").trim();
  return redacted.length > 300 ? `${redacted.slice(0, 299)}…` : redacted;
}

function requireSafeIdentifier(kind: string, value: string): string {
  if (!identifierPattern.test(value)) {
    throw new ApplicationError(
      "KEYCHAIN_IDENTIFIER_INVALID",
      `Keychain ${kind} contains characters outside [A-Za-z0-9_.@:-]`,
    );
  }
  return value;
}

export function createMacOsKeychainVault(
  service = defaultService,
  runner: KeychainCommandRunner = defaultKeychainCommandRunner(),
): CredentialVault {
  requireSafeIdentifier("service", service);

  async function readItem(itemName: string): Promise<string | null> {
    const result = await runner.run([
      "security",
      "find-generic-password",
      "-s",
      service,
      "-a",
      itemName,
      "-w",
    ]);
    if (result.exitCode === 44) {
      return null;
    }
    if (result.exitCode !== 0) {
      throw new ApplicationError(
        "KEYCHAIN_READ_FAILED",
        redactSecrets(result.stderr) || "Keychain read failed",
      );
    }
    const stored = result.stdout.trim();
    if (!base64Pattern.test(stored)) {
      throw new ApplicationError(
        "KEYCHAIN_ITEM_CORRUPT",
        `Keychain item ${itemName} is not base64-encoded; refusing to guess its contents`,
      );
    }
    return stored;
  }

  async function writeItem(itemName: string, encoded: string): Promise<void> {
    const command = `add-generic-password -U -s ${service} -a ${itemName} -w ${encoded}\n`;
    const result = await runner.run(["security", "-i"], command);
    if (result.exitCode !== 0) {
      throw new ApplicationError(
        "KEYCHAIN_WRITE_FAILED",
        redactSecrets(result.stderr) || "Keychain write failed",
      );
    }
  }

  async function deleteItem(itemName: string): Promise<boolean> {
    const result = await runner.run([
      "security",
      "delete-generic-password",
      "-s",
      service,
      "-a",
      itemName,
    ]);
    if (result.exitCode === 0) {
      return true;
    }
    if (result.exitCode === 44) {
      return false;
    }
    throw new ApplicationError(
      "KEYCHAIN_DELETE_FAILED",
      redactSecrets(result.stderr) || "Keychain delete failed",
    );
  }

  async function deleteChunksFrom(reference: string, firstIndex: number): Promise<void> {
    for (let index = firstIndex; index < maximumChunkCount; index += 1) {
      if (!(await deleteItem(`${reference}:${index}`))) {
        return;
      }
    }
  }

  return {
    async read(reference) {
      requireSafeIdentifier("reference", reference);
      const stored = await readItem(reference);
      if (stored === null) {
        return null;
      }
      const decoded = Buffer.from(stored, "base64").toString("utf8");
      if (!decoded.startsWith(manifestPrefix)) {
        return decoded;
      }
      const chunkCount = Number(decoded.slice(manifestPrefix.length));
      if (!Number.isInteger(chunkCount) || chunkCount < 1 || chunkCount > maximumChunkCount) {
        throw new ApplicationError(
          "KEYCHAIN_ITEM_CORRUPT",
          `Keychain item ${reference} declares an invalid chunk count`,
        );
      }
      const chunks: string[] = [];
      for (let index = 0; index < chunkCount; index += 1) {
        const chunk = await readItem(`${reference}:${index}`);
        if (chunk === null) {
          throw new ApplicationError(
            "KEYCHAIN_ITEM_CORRUPT",
            `Keychain item ${reference} is missing chunk ${index} of ${chunkCount}`,
          );
        }
        chunks.push(chunk);
      }
      return Buffer.from(chunks.join(""), "base64").toString("utf8");
    },
    async write(reference, value) {
      requireSafeIdentifier("reference", reference);
      const encoded = Buffer.from(value, "utf8").toString("base64");
      if (encoded.length <= chunkLength) {
        await writeItem(reference, encoded);
        await deleteChunksFrom(reference, 0);
        return;
      }
      const chunkCount = Math.ceil(encoded.length / chunkLength);
      if (chunkCount > maximumChunkCount) {
        throw new ApplicationError(
          "KEYCHAIN_VALUE_TOO_LARGE",
          `Credential exceeds ${maximumChunkCount} keychain chunks`,
        );
      }
      for (let index = 0; index < chunkCount; index += 1) {
        await writeItem(
          `${reference}:${index}`,
          encoded.slice(index * chunkLength, (index + 1) * chunkLength),
        );
      }
      await writeItem(
        reference,
        Buffer.from(`${manifestPrefix}${chunkCount}`, "utf8").toString("base64"),
      );
      await deleteChunksFrom(reference, chunkCount);
    },
    async remove(reference) {
      requireSafeIdentifier("reference", reference);
      await deleteItem(reference);
      await deleteChunksFrom(reference, 0);
    },
  };
}
