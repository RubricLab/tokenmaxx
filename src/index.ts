#!/usr/bin/env bun

import { runCli } from "./cli.ts";
import { errorMessage } from "./errors.ts";

try {
  const exitCode = await runCli(process.argv.slice(2));
  process.exitCode = exitCode;
} catch (error) {
  process.stderr.write(`tokenmaxx: ${errorMessage(error)}\n`);
  process.exitCode = 1;
}
