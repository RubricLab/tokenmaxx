import { chmod, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";

export const ApplicationPathsSchema = z.object({
  root: z.string().min(1),
  database: z.string().min(1),
  runtime: z.string().min(1),
  managerSocket: z.string().min(1),
  managerLock: z.string().min(1),
  claudeProfiles: z.string().min(1),
  proxyPort: z.number().int().positive(),
});
export type ApplicationPaths = z.infer<typeof ApplicationPathsSchema>;

const defaultProxyPort = 8459;

export function applicationPaths(environment: NodeJS.ProcessEnv = process.env): ApplicationPaths {
  const root = resolve(
    environment.TOKENMAXX_HOME ??
      environment.TOKMAX_HOME ??
      environment.CODEX_AUTH_HOME ??
      join(homedir(), ".codex-auth"),
  );
  const runtime = join(root, "runtime");
  const proxyPort = Number(
    environment.TOKENMAXX_PROXY_PORT ?? environment.TOKMAX_PROXY_PORT ?? defaultProxyPort,
  );

  return ApplicationPathsSchema.parse({
    root,
    database: join(root, "state.sqlite"),
    runtime,
    managerSocket: join(runtime, "manager.sock"),
    managerLock: join(runtime, "manager.lock"),
    claudeProfiles: join(root, "profiles", "claude"),
    proxyPort: Number.isFinite(proxyPort) ? proxyPort : defaultProxyPort,
  });
}

export async function ensureApplicationPaths(paths: ApplicationPaths): Promise<void> {
  const directories = [paths.root, paths.runtime, paths.claudeProfiles];
  await Promise.all(
    directories.map((directory) => mkdir(directory, { recursive: true, mode: 0o700 })),
  );
  await Promise.all(directories.map((directory) => chmod(directory, 0o700)));
}

export function proxyBaseUrl(paths: ApplicationPaths, provider: "openai" | "anthropic"): string {
  return `http://127.0.0.1:${paths.proxyPort}/${provider}`;
}
