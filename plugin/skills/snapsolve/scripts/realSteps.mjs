// The installer steps with their real dependencies, as the CLI (snapsolve.mjs) runs them. Kept out of the CLI so a
// test can prove the test hooks below do nothing unless SNAPSOLVE_TEST=1.
import { appendFile } from "node:fs/promises";
import path from "node:path";
import * as steps from "./steps.mjs";

/**
 * The steps with their real dependencies (`base` = steps.mjs; a test passes fakes). Test hooks, inert unless
 * SNAPSOLVE_TEST=1 (the integration test): SNAPSOLVE_TEST_CLAUDE runs that script with node whenever claude.exe is
 * executed (only a real .exe counts as claude on Windows), and SNAPSOLVE_TEST_LAUNCH_LOG records launches instead
 * of starting anything (so nothing runs).
 */
export function realSteps(env, base = steps) {
  const test = env.SNAPSOLVE_TEST === "1";
  const fakeClaude = test ? env.SNAPSOLVE_TEST_CLAUDE : undefined;
  const launchLog = test ? env.SNAPSOLVE_TEST_LAUNCH_LOG : undefined;

  const exec = fakeClaude
    ? (command, commandArgs, options) =>
        path.basename(command).toLowerCase() === "claude.exe"
          ? base.run(process.execPath, [fakeClaude, ...commandArgs], options)
          : base.run(command, commandArgs, options)
    : base.run;
  const notRunning = launchLog ? { isRunning: async () => false } : {};

  return {
    preflight: (o) => base.preflight({ ...o, exec }),
    stageVersion: (o) => base.stageVersion({ ...o, exec }),
    pointCurrent: (o) => base.pointCurrent(o),
    packageBootstrap: (o) => base.packageBootstrap({ ...o, exec }),
    writeClaudePath: (o) => base.writeClaudePath(o),
    launch: launchLog ? ({ exe }) => appendFile(launchLog, `${exe}\n`) : (o) => base.launch(o),
    quitAndWait: (o) => base.quitAndWait({ ...o, exec, ...notRunning }),
    asrCheck: (o) => base.asrCheck({ ...o, exec }),
  };
}
