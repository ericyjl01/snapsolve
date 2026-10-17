#!/usr/bin/env python3
"""keel v5 hook entry points: session-start, post-tool-use, stop. Stdlib only."""
import sys

for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, "reconfigure"):
        _stream.reconfigure(encoding="utf-8")

import hashlib
import json
import os
from pathlib import Path

sys.dont_write_bytecode = True  # never leave .claude/memory/__pycache__ behind (it would read as uncommitted code)
sys.path.insert(0, str(Path(__file__).resolve().parent))
import tasks as keel  # noqa: E402
import check  # noqa: E402

SESSION_START = ".claude/memory/.session-start"
LAST_BLOCK = ".claude/memory/.last-block"
LOG_TRIGGERS = ("add a Log line via tasks.py log only if a task was closed, blocked, dropped or paused, "
                "a milestone was planned, or this was a code-changing ad-hoc request")


def _remove(p):
    try:
        os.unlink(p)
    except FileNotFoundError:
        pass


def _rerender_if_stale(root):
    tj, tm = root / "tasks.json", root / "TASKS.md"
    if not tm.exists() or tm.stat().st_mtime < tj.stat().st_mtime:
        keel.render_tasks_file(root)


def _write_session_start(root, with_branch_tip):
    head = keel.head_sha(root)
    p = root / SESSION_START
    if head is None:
        _remove(p)
        return
    shas = [head]
    if with_branch_tip:
        try:
            ledger = keel.load_ledger(root)
        except keel.KeelError:
            ledger = {"tasks": []}
        for t in ledger["tasks"]:
            if t["status"] == "in_progress" and t["branch"] and keel.ref_exists(root, f"refs/heads/{t['branch']}"):
                tip = keel.git_out(root, "rev-parse", f"refs/heads/{t['branch']}")
                if tip and tip not in shas:
                    shas.append(tip)
    keel.write_text(p, "".join(s + "\n" for s in shas), "\n")


def session_start(data, root):
    source = data.get("source") or "startup"
    _rerender_if_stale(root)
    lines = []
    if source in ("startup", "clear"):
        code, ps = check.logged_status(root, touched_only=True)
        if code and not ps:
            lines.append(f"[keel] previous session left unlogged work: {', '.join(code)} — update ## Now and log before continuing")
        _write_session_start(root, with_branch_tip=True)
        _remove(root / keel.TOUCHED)
        _remove(root / LAST_BLOCK)
    lines.append(keel.state_text(root, source))
    if source == "compact":
        lines.append("[keel] context was compacted; the state above is current — resume the in_progress task. An active /goal survives compaction.")
    elif source == "clear":
        lines.append("[keel] context was cleared — any /goal ended. In your first reply, print the /goal line from CLAUDE.md for the user to paste; do not wait for \"continue\".")
    return 0, "\n".join(lines) + "\n", ""


def post_tool_use(data, root):
    fp = (data.get("tool_input") or {}).get("file_path")
    if not fp:
        return 0, "", ""
    real = os.path.realpath(fp)
    root_real = os.path.realpath(str(root))
    if not os.path.normcase(real).startswith(os.path.normcase(root_real) + os.sep):
        return 0, "", ""
    rel = os.path.relpath(real, root_real).replace(os.sep, "/")
    keel.touch(root, [rel])
    if keel.same_path(rel, "tasks.json"):
        try:
            ledger = keel.load_ledger(root)
            errs = keel.validate(ledger)
        except keel.KeelError as e:
            errs = [str(e)]
        if errs:
            return 2, "", f"[keel] tasks.json invalid: {'; '.join(errs)} — fix it before continuing\n"
        keel.render_tasks_file(root, ledger)
    return 0, "", ""


def block_reason(findings):
    parts = []
    for f in findings:
        if f.startswith("NOTLOGGED"):
            body = f[len("NOTLOGGED "):]
            n, _, rest = body.partition(" file(s) touched this session: ")
            files = rest.split(" — ")[0]
            parts.append(f"keel: {n} file(s) touched this session ({files}) but PROJECT_STATE.md was not updated — "
                         f"rewrite ## Now ({LOG_TRIGGERS}).")
        else:
            parts.append(f"Also {' '.join(f.split())}.")
    return " ".join(parts)


def stop(data, root):
    _rerender_if_stale(root)
    findings = check.check_logged(root) + check.check_caps(root, enforced_only=True)
    lb = root / LAST_BLOCK
    if not findings:
        _write_session_start(root, with_branch_tip=False)
        _remove(root / keel.TOUCHED)
        _remove(lb)
        return 0, "", ""
    digest = hashlib.sha256("\n".join(findings).encode("utf-8")).hexdigest()
    if lb.exists() and keel.read_text(lb).strip() == digest:
        return 0, "", ""
    keel.write_text(lb, digest + "\n", "\n")
    return 0, json.dumps({"decision": "block", "reason": block_reason(findings)}, ensure_ascii=False) + "\n", ""


HANDLERS = {"session-start": session_start, "post-tool-use": post_tool_use, "stop": stop}


def _error_output(event, exc):
    msg = f"[keel] hook error: {type(exc).__name__}: {exc}"
    if event == "post-tool-use":
        return json.dumps({"hookSpecificOutput": {"hookEventName": "PostToolUse", "additionalContext": msg}},
                          ensure_ascii=False) + "\n"
    if event == "stop":
        return json.dumps({"systemMessage": msg}, ensure_ascii=False) + "\n"
    return msg + "\n"


def main(argv=None, stdin=None):
    argv = sys.argv[1:] if argv is None else list(argv)
    event = argv[0] if argv else ""
    if event not in HANDLERS:
        sys.stdout.write(_error_output(event, ValueError(f"unknown hook event {event!r}")))
        return 0
    try:
        raw = (stdin if stdin is not None else sys.stdin.buffer).read()
        data = json.loads(raw.decode("utf-8"))
        if not isinstance(data, dict):
            raise ValueError("hook input is not a JSON object")
        root = keel.repo_root(data.get("cwd"))
        if not keel.ledger_path(root).exists():
            return 0
        code, out, err = HANDLERS[event](data, root)
        if out:
            sys.stdout.write(out)
        if err:
            sys.stderr.write(err)
        return code
    except BaseException as exc:  # noqa: BLE001 — a hook bug must never break a session
        sys.stdout.write(_error_output(event, exc))
        return 0


if __name__ == "__main__":
    sys.exit(main())
