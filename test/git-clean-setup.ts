import { spawnSync } from "node:child_process";
import { repoRoot } from "./paths";

function gitStatus(): Set<string> {
  const r = spawnSync("git", ["status", "--porcelain", "-uall"], { cwd: repoRoot, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git status failed: ${r.stderr}`);
  return new Set(r.stdout.split(/\r?\n/).filter(Boolean));
}

/**
 * Snapshot `git status` before the suite and fail the run if the suite leaves anything new behind
 * (an untracked artifact that needs a .gitignore line, or a file a test forgot to clean up).
 */
export default function setup(): () => void {
  const before = gitStatus();
  return () => {
    const added = [...gitStatus()].filter((line) => !before.has(line));
    if (added.length) {
      throw new Error(`the test suite left files git does not ignore:\n${added.join("\n")}`);
    }
  };
}
