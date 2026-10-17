#!/usr/bin/env python3
"""keel v5 checks: caps, logged, spec. Stdlib only; imports tasks.py from the same directory."""
import sys

for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, "reconfigure"):
        _stream.reconfigure(encoding="utf-8")

import glob
import os
import re
from pathlib import Path

sys.dont_write_bytecode = True  # never leave .claude/memory/__pycache__ behind (it would read as uncommitted code)
sys.path.insert(0, str(Path(__file__).resolve().parent))
import tasks as keel  # noqa: E402

SESSION_START = ".claude/memory/.session-start"
KEEL_SUBJECT = re.compile(r"^(\d{3}|adhoc|keel):")


def count_lines(text):
    return len(text.replace("\r\n", "\n").splitlines())


def block_lines(text, heading):
    """Lines from `## <heading>` (exclusive) to the next `## ` heading or EOF, trailing blanks excluded."""
    lines = text.replace("\r\n", "\n").split("\n")
    start = next((i for i, l in enumerate(lines) if re.match(rf"^## {re.escape(heading)}\s*$", l)), None)
    if start is None:
        return None
    end = next((i for i in range(start + 1, len(lines)) if lines[i].startswith("## ")), len(lines))
    body = lines[start + 1:end]
    while body and not body[-1].strip():
        body.pop()
    return len(body)


def _fix_hint(key, n, cap):
    if key == "PROJECT_STATE.md#Now":
        return f"trim to {cap} lines"
    if key == "PROJECT_STATE.md#Log":
        return f"move the oldest {n - cap} lines to archive/PROJECT_STATE.archive.md"
    return "run /keel tidy"


def caps_report(root, enforced_only=False):
    """[(kind, line)] for every cap in keel.json; kind is OK, OVER or ADVISORY."""
    root = Path(root)
    cfg = keel.load_keel_json(root)
    enforced = set(cfg["stop_enforced"])
    out = []
    for key, cap in cfg["caps"].items():
        if enforced_only and key not in enforced:
            continue
        if "#" in key:
            file, heading = key.split("#", 1)
            p = root / file
            if not p.exists():
                continue
            n = block_lines(keel.read_text(p), heading)
            if n is None:
                continue
            targets = [(key, n)]
        elif "*" in key:
            targets = [(str(Path(f).relative_to(root)).replace(os.sep, "/"), count_lines(keel.read_text(f)))
                       for f in sorted(glob.glob(str(root / key)))]
        else:
            p = root / key
            if not p.exists():
                continue
            targets = [(key, count_lines(keel.read_text(p)))]
        for label, n in targets:
            if n <= cap:
                out.append(("OK", f"OK        {label} {n}/{cap}"))
            elif key in enforced:
                out.append(("OVER", f"OVER      {label} {n}/{cap} — {_fix_hint(key, n, cap)}"))
            else:
                out.append(("ADVISORY", f"ADVISORY  {label} {n}/{cap} — {_fix_hint(key, n, cap)}"))
    return out


def check_caps(root, enforced_only=False):
    return [line for kind, line in caps_report(root, enforced_only) if kind != "OK"]


def _read_lines(path):
    p = Path(path)
    if not p.exists():
        return []
    return [l.strip() for l in keel.read_text(p).replace("\r\n", "\n").split("\n") if l.strip()]


def committed_paths(root, since):
    """Files named in keel-shaped first-parent commits reachable from HEAD but not from any `since` sha."""
    root = Path(root)
    if keel.head_sha(root) is None:
        return set()
    keep = [s for s in since if re.fullmatch(r"[0-9a-f]{4,40}", s) and keel.is_ancestor(root, s, "HEAD")]
    if not keep:
        return set()
    rc, out, _ = keel.git(root, "log", "--first-parent", "--diff-merges=first-parent", "--name-only", "-z",
                          "--format=%x1e%s", "HEAD", *[f"^{s}" for s in keep])
    paths = set()
    if rc != 0:
        return paths
    for record in out.split("\x1e"):
        if not record.strip("\0\n"):
            continue
        subject, _, rest = record.partition("\n")
        if KEEL_SUBJECT.match(subject.strip("\0")):
            paths.update(p.strip("\n") for p in rest.split("\0") if p.strip("\0\n"))
    return paths


def logged_status(root, since=None, touched=None, touched_only=False):
    """(code paths touched this session, PROJECT_STATE.md touched?)"""
    root = Path(root)
    since = _read_lines(root / SESSION_START) if since is None else list(since)
    touched_set = set(_read_lines(root / keel.TOUCHED if touched is None else touched))
    committed = set() if touched_only else committed_paths(root, since)
    all_paths = {p for p in touched_set if (root / p).exists() or p in committed} | committed
    code = sorted(p for p in all_paths if not keel.is_memory(p))
    ps = any(keel.same_path(p.replace("\\", "/"), "PROJECT_STATE.md") for p in all_paths)
    return code, ps


def check_logged(root, since=None, touched=None, touched_only=False):
    code, ps = logged_status(root, since, touched, touched_only)
    if code and not ps:
        return [f"NOTLOGGED {len(code)} file(s) touched this session: {', '.join(code)} — PROJECT_STATE.md not updated"]
    return []


def check_spec(root):
    root = Path(root)
    p = root / "SPEC.md"
    if not p.exists():
        return []
    ms, warnings = keel.milestones(keel.read_text(p))
    out = []
    for w in warnings:
        msg = w[len("warning: "):]
        if "malformed" in msg:
            m = re.search(r"### M(\d+)", msg)
            n = m.group(1) if m else "<n>"
            msg += f' — expected "### M{n} — <name>"'
        out.append(f"WARN      {msg}")
    lp = keel.ledger_path(root)
    if lp.exists():
        try:
            ledger = keel.load_ledger(root)
            for n in ledger.get("planned_milestones", []):
                if n not in ms:
                    out.append(f"WARN      planned milestone M{n} is not defined in SPEC.md")
        except keel.KeelError:
            pass
    return out


def main(argv=None):
    argv = sys.argv[1:] if argv is None else list(argv)
    if not argv or argv[0] not in ("caps", "logged", "spec", "all"):
        print("usage: check.py <caps [--enforced] | logged [--since SHA ...] [--touched FILE] [--touched-only] | spec | all>",
              file=sys.stderr)
        return 1
    root = keel.repo_root()
    if not keel.ledger_path(root).exists():
        print(f"check.py: not a keel repo: {keel.ledger_path(root)} is missing", file=sys.stderr)
        return 2
    cmd, rest = argv[0], argv[1:]
    findings = []
    if cmd in ("caps", "all"):
        enforced_only = "--enforced" in rest
        for kind, line in caps_report(root, enforced_only):
            print(line)
            if kind != "OK":
                findings.append(line)
    if cmd in ("logged", "all"):
        since, touched, touched_only, i = None, None, "--touched-only" in rest, 0
        while i < len(rest):
            if rest[i] == "--since":
                since = since or []
                i += 1
                while i < len(rest) and not rest[i].startswith("--"):
                    since.append(rest[i])
                    i += 1
                continue
            if rest[i] == "--touched" and i + 1 < len(rest):
                touched = rest[i + 1]
                i += 2
                continue
            i += 1
        lines = check_logged(root, since, touched, touched_only)
        for line in lines:
            print(line)
        findings += lines
    if cmd in ("spec", "all"):
        lines = check_spec(root)
        for line in lines:
            print(line)
        findings += lines
    return 1 if findings else 0


if __name__ == "__main__":
    sys.exit(main())
