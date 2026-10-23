// Model names for the answer footer (task 086, SPEC Amendment 20): claude reports full ids such as
// `claude-opus-5-5`; the footer shows "Opus 5.5". Pure; used by the renderer.

/** `claude-<family>-<major>[-<minor>][-<date>]` → "Family major.minor"; a trailing tag like `[1m]` is dropped from any name; anything else is shown as given. */
export function modelName(id: string): string {
  const bare = id.replace(/\[[^\]]*\]$/, "");
  const m = /^claude-([a-z]+)-(\d{1,2})(?:-(\d{1,2}))?(?:-\d{8})?$/.exec(bare);
  if (!m) return bare;
  const [, family, major, minor] = m;
  return `${family[0].toUpperCase()}${family.slice(1)} ${minor === undefined ? major : `${major}.${minor}`}`;
}
