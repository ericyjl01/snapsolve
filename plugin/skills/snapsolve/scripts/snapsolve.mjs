#!/usr/bin/env node
// The /snapsolve CLI (SPEC §8.1): `node snapsolve.mjs install | start | update | doctor | uninstall [--purge]`.
// Prints the command's ok:/warn:/fail: lines; exit 0 ok, 1 failed, 2 usage. It never prompts (it runs under
// Claude's Bash tool; the skill asks first). The plugin's app/ payload sits three levels up, beside skills/.
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, runCommand } from "./commands.mjs";
import { realSteps } from "./realSteps.mjs";
import * as steps from "./steps.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

const args = parseArgs(process.argv.slice(2));
if (args.usage) {
  console.log(args.usage);
  process.exit(2);
}

const { platform, env } = process;
const home = os.homedir();
const ctx = {
  platform,
  env,
  home,
  nodeVersion: process.version,
  pluginApp: path.resolve(here, "..", "..", "..", "app"),
  paths: () => steps.installPaths({ platform, env, home }),
  steps: realSteps(env),
};

try {
  const { code, lines } = await runCommand(args, ctx);
  for (const line of lines) console.log(line);
  process.exitCode = code;
} catch (e) {
  console.log(`fail: ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
}
