import { spawnSync } from "node:child_process";
import { repoRoot } from "../paths";

/** Rebuild dist/ once before the e2e project runs, so e2e never exercises a stale build. */
export default function setup(): void {
  const r = spawnSync("npm run build", { cwd: repoRoot, stdio: "inherit", shell: true });
  if (r.status !== 0) throw new Error(`npm run build failed (exit ${r.status}) — e2e tests need a fresh dist/`);
}
