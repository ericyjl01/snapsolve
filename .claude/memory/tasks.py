#!/usr/bin/env python3
"""keel v5 task ledger. Python 3 stdlib only. Shipped to every keel repo as .claude/memory/tasks.py."""
import sys

for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, "reconfigure"):
        _stream.reconfigure(encoding="utf-8")

import argparse
import datetime as _dt
import json
import os
import re
import shlex
import shutil
import signal
import subprocess
import time
import unicodedata
from pathlib import Path

VERSION = 5
STATUSES = ("open", "in_progress", "blocked", "closed", "dropped")
KINDS = ("task", "clarify")
TASK_FIELDS = ("id", "title", "status", "priority", "milestone", "deps", "file", "blocked_on",
               "attempts", "branch", "stash", "closed_at", "commit", "notes")
DEFAULT_KEEL = {
    "caps": {"CLAUDE.md": 200, "PROJECT_STATE.md#Now": 12, "PROJECT_STATE.md#Log": 40,
             "ARCHITECTURE.md": 300, "SPEC.md": 300, "docs/tasks/*.md": 80, "DECISIONS.md": 100},
    "stop_enforced": ["PROJECT_STATE.md#Now", "PROJECT_STATE.md#Log", "ARCHITECTURE.md"],
    "max_attempts": 3,
    "test_command": "",
    "test_timeout": 1800,
}
# Pathspec for `git status` / `git diff` only (unmatched paths are fine there).
MEM = ["CLAUDE.md", "PROJECT_STATE.md", "tasks.json", "SPEC.md", "ARCHITECTURE.md", "DECISIONS.md",
       "docs/tasks", "docs/issues.md", ".claude/memory/tasks.py", ".claude/memory/check.py",
       ".claude/memory/hooks.py", ".claude/memory/keel.json", ".claude/memory/review-prompt.md", ".claude/rules",
       ".claude/settings.json", "archive"]
# Pathspec for code staging and stashing: everything except memory; `.` skips ignored files (TASKS.md).
EXCL = ["."] + [":(exclude)" + p for p in MEM]
MEM_FILES = {"CLAUDE.md", "PROJECT_STATE.md", "tasks.json", "TASKS.md", "SPEC.md", "ARCHITECTURE.md",
             "DECISIONS.md", "docs/issues.md", ".claude/memory/tasks.py", ".claude/memory/check.py",
             ".claude/memory/hooks.py", ".claude/memory/keel.json", ".claude/memory/review-prompt.md",
             ".claude/settings.json"}
MEM_DIRS = ("docs/tasks/", ".claude/rules/", "archive/")
TOUCHED = ".claude/memory/.touched"
LOCK = ".claude/memory/.lock"
REVIEW_PROMPT = ".claude/memory/review-prompt.md"
OUTPUT_TAIL = 60
LOCK_RETRY_S, LOCK_TIMEOUT_S, LOCK_STALE_S = 0.1, 5.0, 30.0
PROJECT_STATE_SKELETON = "# PROJECT_STATE\n\n## Now\n\n## Log\n"
ARCHIVE_LOG = "archive/PROJECT_STATE.archive.md"
ARCHIVE_LOG_HEADER = "# PROJECT_STATE Log archive (oldest first)\n"
TASK_TEMPLATE = """# {{ID}} · {{TITLE}}

## Objective
{{OBJECTIVE}}

## Scope
In:  {{IN_SCOPE}}
Out: {{OUT_OF_SCOPE}}

## Done when
- [ ] {{COMMAND_AND_EXPECTED_OBSERVATION}}

## Tests
Command: `{{TEST_CMD}}`
- {{TEST_NAME}} — proves {{BEHAVIOR}} (name the error and edge cases too)

## Spec refs
{{SPEC_REFS}}

## Notes
"""


class KeelError(Exception):
    """Usage, validation or git error: message on stderr, exit 1."""


class NotKeelRepo(Exception):
    """tasks.json missing at the repo root: exit 2."""


class GitFailure(KeelError):
    def __init__(self, cmd, out, err, branch):
        self.cmd, self.out, self.err, self.branch = list(cmd), out, err, branch
        super().__init__(self.__str__())

    def __str__(self):
        body = (self.out + self.err).strip()
        return f"git failed: git {' '.join(self.cmd)}\n{body}\ncurrent branch: {self.branch}"


# ---------- files ----------

def repo_root(cwd=None):
    cwd = str(cwd or os.getcwd())
    p = subprocess.run(["git", "-C", cwd, "rev-parse", "--show-toplevel"], capture_output=True)
    if p.returncode == 0:
        return Path(p.stdout.decode("utf-8", "surrogateescape").strip())
    return Path(__file__).resolve().parents[2]


def read_text(path):
    with open(path, encoding="utf-8", newline="") as f:
        return f.read()


def newline_of(text):
    i = text.find("\n")
    return "\r\n" if i > 0 and text[i - 1] == "\r" else "\n"


def read_norm(path):
    """Returns (text with \\n line endings, the file's newline style)."""
    raw = read_text(path)
    return raw.replace("\r\n", "\n"), newline_of(raw)


def write_text(path, text, nl="\n"):
    """`text` uses \\n; written with the newline style `nl`, UTF-8."""
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="") as f:
        f.write(text.replace("\r\n", "\n").replace("\n", nl))


WINDOWS = os.name == "nt"  # path comparisons are case-insensitive here (tests patch this constant)


def same_path(a, b):
    """Repo-relative POSIX path equality: case-insensitive on Windows, exact elsewhere."""
    return a.lower() == b.lower() if WINDOWS else a == b


def is_memory(rel):
    """Memory-set membership of a repo-relative POSIX path (case-insensitive on Windows)."""
    p = rel.replace("\\", "/")
    while p.startswith("./"):
        p = p[2:]
    files, dirs = MEM_FILES, MEM_DIRS
    if WINDOWS:
        p = p.lower()
        files = {f.lower() for f in MEM_FILES}
        dirs = tuple(d.lower() for d in MEM_DIRS)
    return p in files or p.startswith(dirs)


def touch(root, paths):
    p = Path(root) / TOUCHED
    p.parent.mkdir(parents=True, exist_ok=True)
    with open(p, "a", encoding="utf-8", newline="\n") as f:
        for x in paths:
            f.write(x + "\n")


def load_keel_json(root):
    p = Path(root) / ".claude/memory/keel.json"
    data = {}
    if p.exists():
        try:
            data = json.loads(read_text(p))
        except json.JSONDecodeError:
            data = {}
    out = json.loads(json.dumps(DEFAULT_KEEL))
    if isinstance(data.get("caps"), dict):
        out["caps"].update(data["caps"])
    if isinstance(data.get("stop_enforced"), list):
        out["stop_enforced"] = data["stop_enforced"]
    if isinstance(data.get("max_attempts"), int):
        out["max_attempts"] = data["max_attempts"]
    if isinstance(data.get("test_command"), str):
        out["test_command"] = data["test_command"]
    if isinstance(data.get("test_timeout"), int) and data["test_timeout"] > 0:
        out["test_timeout"] = data["test_timeout"]
    return out


# ---------- ledger ----------

def ledger_path(root):
    return Path(root) / "tasks.json"


def normalize(ledger):
    if isinstance(ledger, dict) and isinstance(ledger.get("tasks"), list):
        for t in ledger["tasks"]:
            if isinstance(t, dict):
                t.setdefault("kind", "task")
                for f in ("test_cmd", "tests_commit", "no_tests", "review"):
                    t.setdefault(f, None)
    return ledger


def load_ledger(root):
    p = ledger_path(root)
    if not p.exists():
        raise NotKeelRepo(f"not a keel repo: {p} is missing")
    text, _ = read_norm(p)
    try:
        return normalize(json.loads(text))
    except json.JSONDecodeError as e:
        raise KeelError(f"tasks.json is not valid JSON: {e}")


def _is_int(v):
    return isinstance(v, int) and not isinstance(v, bool)


def validate(ledger):
    """Returns a list of problems (empty when valid)."""
    errs = []
    if not isinstance(ledger, dict):
        return ["top level must be an object"]
    if not _is_int(ledger.get("version")):
        errs.append("version must be an int")
    wb = ledger.get("work_branch")
    if not isinstance(wb, str) or not wb.strip():
        errs.append("work_branch must be a non-empty string")
    pm = ledger.get("planned_milestones")
    if not isinstance(pm, list) or not all(_is_int(n) and n >= 1 for n in pm):
        errs.append("planned_milestones must be a list of ints >= 1")
    tasks = ledger.get("tasks")
    if not isinstance(tasks, list):
        return errs + ["tasks must be a list"]
    by_id = {}
    for i, t in enumerate(tasks):
        if not isinstance(t, dict):
            errs.append(f"task #{i} is not an object")
            continue
        tid = t.get("id")
        label = tid if isinstance(tid, str) else f"#{i}"
        if not isinstance(tid, str) or not re.fullmatch(r"\d{3}", tid):
            errs.append(f"task {label}: id must be a zero-padded 3-digit string")
        elif tid in by_id:
            errs.append(f"task {tid}: duplicate id")
        else:
            by_id[tid] = t
        for f in TASK_FIELDS:
            if f not in t:
                errs.append(f"task {label}: missing field {f}")
        if not isinstance(t.get("title"), str) or not t["title"].strip():
            errs.append(f"task {label}: title must be a non-empty string")
        st = t.get("status")
        if st not in STATUSES:
            errs.append(f"task {label}: status must be one of {', '.join(STATUSES)}")
        if t.get("kind", "task") not in KINDS:
            errs.append(f"task {label}: kind must be one of {', '.join(KINDS)}")
        if not _is_int(t.get("priority")):
            errs.append(f"task {label}: priority must be an int")
        m = t.get("milestone")
        if m is not None and not (_is_int(m) and m >= 1):
            errs.append(f"task {label}: milestone must be an int >= 1 or null")
        if not isinstance(t.get("deps"), list) or not all(isinstance(d, str) for d in t.get("deps") or []):
            errs.append(f"task {label}: deps must be a list of ids")
        if not isinstance(t.get("file"), str):
            errs.append(f"task {label}: file must be a string")
        bo = t.get("blocked_on")
        if st == "blocked" and not (isinstance(bo, str) and bo.strip()):
            errs.append(f"task {label}: blocked_on must be set while blocked")
        if st != "blocked" and bo is not None:
            errs.append(f"task {label}: blocked_on must be null unless blocked")
        if not (_is_int(t.get("attempts")) and t["attempts"] >= 0):
            errs.append(f"task {label}: attempts must be an int >= 0")
        for f in ("branch", "stash", "closed_at", "commit"):
            if t.get(f) is not None and not isinstance(t.get(f), str):
                errs.append(f"task {label}: {f} must be a string or null")
        if not isinstance(t.get("notes"), str):
            errs.append(f"task {label}: notes must be a string")
        if t.get("kind") == "clarify" and t.get("branch") is not None:
            errs.append(f"task {label}: a clarify task never has a branch")
        for f in ("test_cmd", "tests_commit", "no_tests"):
            if t.get(f) is not None and not isinstance(t.get(f), str):
                errs.append(f"task {label}: {f} must be a string or null")
        rv = t.get("review")
        if rv is not None and not (isinstance(rv, dict) and rv.get("verdict") in ("pass", "fail")
                                   and all(isinstance(rv.get(k), str) for k in ("sha", "reasons", "at"))):
            errs.append(f"task {label}: review must be null or {{verdict: pass|fail, sha, reasons, at}}")
    for tid, t in by_id.items():
        for d in t.get("deps") or []:
            if d == tid:
                errs.append(f"task {tid}: depends on itself")
            elif d not in by_id:
                errs.append(f"task {tid}: unknown dep {d}")
    state = {}

    def visit(tid, trail):
        if state.get(tid) == 2:
            return
        if state.get(tid) == 1:
            errs.append(f"dependency cycle: {' -> '.join(trail + [tid])}")
            return
        state[tid] = 1
        for d in by_id[tid].get("deps") or []:
            if d in by_id:
                visit(d, trail + [tid])
        state[tid] = 2

    for tid in by_id:
        visit(tid, [])
    return errs


class Lock:
    def __init__(self, root):
        self.path = Path(root) / LOCK
        self.fd = None

    def __enter__(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        deadline = time.monotonic() + LOCK_TIMEOUT_S
        while True:
            try:
                self.fd = os.open(self.path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
                os.write(self.fd, str(os.getpid()).encode())
                return self
            except FileExistsError:
                try:
                    age = time.time() - os.stat(self.path).st_mtime
                except FileNotFoundError:
                    continue
                if age > LOCK_STALE_S:
                    try:
                        os.unlink(self.path)
                    except FileNotFoundError:
                        pass
                    continue
                if time.monotonic() > deadline:
                    raise KeelError(f"tasks.json is locked ({LOCK}) — another keel process is writing; retry")
                time.sleep(LOCK_RETRY_S)

    def __exit__(self, *exc):
        if self.fd is not None:
            os.close(self.fd)
        try:
            os.unlink(self.path)
        except FileNotFoundError:
            pass
        return False


def write_ledger(root, ledger, touched=()):
    errs = validate(ledger)
    if errs:
        raise KeelError("tasks.json would be invalid: " + "; ".join(errs))
    root = Path(root)
    path, tmp = ledger_path(root), root / "tasks.json.tmp"
    nl = newline_of(read_text(path)) if path.exists() else "\n"
    try:
        write_text(tmp, json.dumps(ledger, indent=2, ensure_ascii=False) + "\n", nl)
        os.replace(tmp, path)
    finally:
        if tmp.exists():
            tmp.unlink()
    render_tasks_file(root, ledger)
    touch(root, ["tasks.json", "TASKS.md", *touched])


# ---------- milestones ----------

MS_HEAD = re.compile(r"^### M(\d+)\s*[—–-]\s*(\S.*?)\s*$")


def milestones(spec_text):
    """Parses `### M<n> — <name>` headings anywhere in SPEC.md. Returns ({n: {name, dropped}}, warnings)."""
    ms, warnings, has_section = {}, [], False
    for line in spec_text.replace("\r\n", "\n").split("\n"):
        if re.match(r"^## Milestones\s*$", line):
            has_section = True
            continue
        if not line.startswith("### M"):
            continue
        m = MS_HEAD.match(line)
        if not m:
            warnings.append(f'warning: SPEC.md malformed milestone heading: "{line.rstrip()}"')
            continue
        n, name, dropped = int(m.group(1)), m.group(2), False
        dm = re.match(r"^(.*?)\s*\(dropped\)$", name)
        if dm:
            name, dropped = dm.group(1), True
        ms[n] = {"name": name, "dropped": dropped}
    if has_section and not ms:
        warnings.insert(0, "warning: SPEC.md ## Milestones parses to 0 milestones")
    return ms, warnings


def spec_milestones(root):
    p = Path(root) / "SPEC.md"
    if not p.exists():
        return {}, []
    return milestones(read_text(p))


# ---------- queries ----------

def _key(t):
    return (t["priority"], t["id"])


def by_id(ledger):
    return {t["id"]: t for t in ledger["tasks"]}


def get_task(ledger, tid):
    t = by_id(ledger).get(tid)
    if t is None:
        raise KeelError(f"no task {tid}")
    return t


def unmet_deps(task, index):
    return [d for d in task["deps"] if index.get(d, {}).get("status") not in ("closed", "dropped")]


def eligible(ledger):
    """in_progress tasks first, then open non-backlog tasks with met deps, by (priority, id)."""
    index = by_id(ledger)
    ip = [t for t in ledger["tasks"] if t["status"] == "in_progress"]
    opens = sorted((t for t in ledger["tasks"] if t["status"] == "open" and t["milestone"] is not None
                    and not unmet_deps(t, index)), key=_key)
    return ip + opens


def plan_candidate(ledger, ms):
    """(n, reasons) for the lowest unplanned non-dropped milestone; (None, []) when all are planned."""
    planned, tasks = set(ledger["planned_milestones"]), ledger["tasks"]
    unplanned = sorted(n for n, m in ms.items() if not m["dropped"] and n not in planned)
    if not unplanned:
        return None, []
    n, reasons = unplanned[0], []
    for k in sorted(k for k, m in ms.items() if not m["dropped"] and k < n):
        if not any(t["status"] == "closed" and t["milestone"] == k for t in tasks):
            reasons.append(f"M{k} has no closed task")
        if any(t["kind"] == "clarify" and t["status"] == "blocked" and t["milestone"] == k for t in tasks):
            reasons.append(f"M{k} has a blocked clarify task")
    if any(t["kind"] == "clarify" and t["status"] == "blocked" and t["milestone"] == n for t in tasks):
        reasons.append(f"M{n} has a blocked clarify task")
    return n, reasons


def next_task(ledger, ms):
    """Decides what `next` prints: a dict with "kind" in task | plan | all_blocked | done plus details."""
    tasks, index = ledger["tasks"], by_id(ledger)
    blocked = sorted((t for t in tasks if t["status"] == "blocked" and t["milestone"] is not None), key=_key)
    backlog = sum(1 for t in tasks if t["milestone"] is None and t["status"] in ("open", "blocked"))
    el = eligible(ledger)
    if el:
        return {"kind": "task", "task": el[0], "blocked": blocked, "backlog": backlog}
    n, reasons = plan_candidate(ledger, ms)
    if n is not None and not reasons:
        return {"kind": "plan", "milestone": n, "name": ms[n]["name"], "blocked": blocked, "backlog": backlog}
    lines = [f"{t['id']} · {t['title']} — {t['blocked_on']}" for t in blocked]
    for t in sorted((t for t in tasks if t["status"] == "open" and t["milestone"] is not None), key=_key):
        lines.append(f"{t['id']} · {t['title']} — waits on {', '.join(unmet_deps(t, index))}")
    if n is not None:
        lines.append(f"M{n} · not eligible: {'; '.join(reasons)}")
    if lines:
        return {"kind": "all_blocked", "lines": lines, "blocked": blocked, "backlog": backlog}
    return {"kind": "done", "blocked": blocked, "backlog": backlog}


def none_line(r):
    if r["kind"] == "plan":
        return f"next: none — plan M{r['milestone']} · {r['name']} (SPEC.md ## Milestones)"
    if r["kind"] == "all_blocked":
        return "next: none — all blocked"
    return f"next: none — done · backlog: {r['backlog']} (tasks.py list)"


def next_text(ledger, ms, warnings=(), tip=None):
    """`tip` is the in_progress task's branch-tip sha (cmd_next passes it) so a stale review can be flagged."""
    r, out = next_task(ledger, ms), list(warnings)
    if r["kind"] == "task":
        t = r["task"]
        out.append(f"next: {t['id']} · {t['title']} (M{t['milestone']})")
        out.append(f"file: {t['file']}")
        if t["kind"] != "clarify":
            out.append(f"tests: none — {t['no_tests']}" if t["no_tests"] else f"tests: {t['test_cmd'] or '- (set --test-cmd)'}")
        status = f"status: {t['status']} · attempts: {t['attempts']} · branch: {t['branch'] or '-'}"
        if t["tests_commit"]:
            status += f" · red: {t['tests_commit'][:7]}"
        if t["review"]:
            rv = t["review"]
            verdict = "stale" if tip is not None and rv["sha"] != tip else rv["verdict"]
            status += f" · review: {verdict} ({rv['sha'][:7]})"
        out.append(status)
        if r["blocked"]:
            bl = r["blocked"]
            items = ", ".join(f"{b['id']} ({b['blocked_on']})" for b in bl[:5])
            more = f", +{len(bl) - 5} more" if len(bl) > 5 else ""
            out.append(f"blocked: {len(bl)} — {items}{more}")
    elif r["kind"] == "all_blocked":
        out.append(none_line(r))
        out += r["lines"][:5]
        if len(r["lines"]) > 5:
            out.append(f"+{len(r['lines']) - 5} more (tasks.py list)")
    else:
        out.append(none_line(r))
    return "\n".join(out)


def state_text(root, source="cli"):
    root = Path(root)
    ledger = load_ledger(root)
    ms, warnings = spec_milestones(root)
    ps = root / "PROJECT_STATE.md"
    body = read_norm(ps)[0].rstrip("\n") if ps.exists() else "(PROJECT_STATE.md missing — tasks.py log creates it)"
    out = [f"[keel] state (source: {source})", *warnings, "## PROJECT_STATE.md", body, "## Up next"]
    el = eligible(ledger)
    if el:
        for i, t in enumerate(el[:3], 1):
            extra = f", {t['branch']}" if t["branch"] else ""
            out.append(f"{i}. {t['id']} {t['title']} (M{t['milestone']}) — {t['status']}, attempt {t['attempts']}{extra}")
    else:
        out.append(none_line(next_task(ledger, ms)))
    index, tasks, lines = by_id(ledger), ledger["tasks"], []
    for t in sorted((t for t in tasks if t["status"] == "blocked" and t["milestone"] is not None), key=_key):
        br = f" (branch: {t['branch']}{', stash' if t['stash'] else ''})" if t["branch"] else ""
        lines.append(f"Blocked: {t['id']} {t['title']} — {t['blocked_on']}{br}")
    for t in sorted((t for t in tasks if t["status"] == "open" and t["milestone"] is not None), key=_key):
        u = unmet_deps(t, index)
        if u:
            lines.append(f"Waiting: {t['id']} {t['title']} — waits on {', '.join(u)}")
    planned = set(ledger["planned_milestones"])
    for n in sorted(ms):
        if not ms[n]["dropped"] and n not in planned:
            lines.append(f"Plan: M{n} — {ms[n]['name']} is not planned yet")
    out += lines[:5]
    if len(lines) > 5:
        out.append(f"+{len(lines) - 5} more (tasks.py list)")
    backlog = sum(1 for t in tasks if t["milestone"] is None and t["status"] in ("open", "blocked"))
    if backlog:
        out.append(f"Backlog: {backlog} task(s)")
    return "\n".join(out)


# ---------- TASKS.md ----------

def _note_reason(t, verb):
    parts = [p.strip() for p in t["notes"].split(" | ")]
    hits = [p[len(verb) + 2:] for p in parts if p.startswith(verb + ": ")]
    return hits[-1] if hits else ""


def render_tasks_md(ledger, ms):
    tasks, index, planned = ledger["tasks"], by_id(ledger), set(ledger["planned_milestones"])
    L = ["GENERATED from tasks.json — do not edit; not committed", "", "# Tasks", ""]
    ip = [t for t in tasks if t["status"] == "in_progress"]
    if ip:
        L.append("## In progress")
        L += [f"- {t['id']} {t['title']} (M{t['milestone']}, attempt {t['attempts']})" for t in ip]
        L.append("")
    L.append("## Next")
    nxt = sorted((t for t in tasks if t["status"] == "open" and t["milestone"] is not None), key=_key)
    for i, t in enumerate(nxt, 1):
        u = unmet_deps(t, index)
        L.append(f"{i}. {t['id']} {t['title']} (M{t['milestone']})" + (f" — needs {', '.join(u)}" if u else ""))
    if not nxt:
        L.append("(none)")
    L.append("")
    bl = sorted((t for t in tasks if t["status"] == "blocked" and t["milestone"] is not None), key=_key)
    if bl:
        L.append("## Blocked")
        for t in bl:
            s = f"- {t['id']} {t['title']} (M{t['milestone']}) — Q: {t['blocked_on']}"
            if t["branch"]:
                s += f" — branch: {t['branch']}" + (" (stash)" if t["stash"] else "")
            L.append(s)
        L.append("")
    plan = [n for n in sorted(ms) if not ms[n]["dropped"] and n not in planned]
    if plan:
        L.append("## Plan")
        L += [f"- M{n} — {ms[n]['name']} is not planned yet" for n in plan]
        L.append("")
    back = sorted((t for t in tasks if t["milestone"] is None and t["status"] in ("open", "blocked")), key=_key)
    if back:
        L.append(f"## Backlog ({len(back)})")
        L += [f"- {t['id']} {t['title']}" + (f" — Q: {t['blocked_on']}" if t["status"] == "blocked" else "") for t in back]
        L.append("")
    fin = sorted((t for t in tasks if t["status"] in ("closed", "dropped")),
                 key=lambda t: (t["closed_at"] or "", t["id"]), reverse=True)
    L.append("## Done (last 10)")
    for t in fin[:10]:
        if t["status"] == "closed":
            L.append(f"- {t['closed_at'] or '-'} {t['id']} {t['title']} ({t['commit'] or '-'})")
        else:
            L.append(f"- {t['closed_at'] or '-'} {t['id']} {t['title']} — dropped: {_note_reason(t, 'dropped')}")
    if not fin:
        L.append("(none)")
    if len(fin) > 10:
        L += ["", f"{len(fin) - 10} older closed tasks: `python3 .claude/memory/tasks.py list`. "
                  "Archived task files live in archive/tasks/."]
    return "\n".join(L) + "\n"


def render_tasks_file(root, ledger=None):
    root = Path(root)
    ledger = ledger if ledger is not None else load_ledger(root)
    ms, _ = spec_milestones(root)
    p = root / "TASKS.md"
    nl = newline_of(read_text(p)) if p.exists() else "\n"
    write_text(p, render_tasks_md(ledger, ms), nl)


# ---------- log ----------

def today():
    return _dt.date.today().isoformat()


def one_line(s):
    return " ".join(str(s).split())


def log_append(root, who, verb, summary, sha=None):
    """Appends one Log line, rolls the section to its cap. Returns the number of rolled lines."""
    root = Path(root)
    keep = int(load_keel_json(root)["caps"].get("PROJECT_STATE.md#Log", 40))
    if sha is None:
        sha = short_head(root) or "-"
    parts = [today(), one_line(who), one_line(verb)] + ([one_line(summary)] if summary is not None else [])
    line = " · ".join(parts) + f" ({sha})"
    ps = root / "PROJECT_STATE.md"
    if ps.exists():
        text, nl = read_norm(ps)
    else:
        text, nl = PROJECT_STATE_SKELETON, "\n"
    lines = text.split("\n")
    start = next((i for i, l in enumerate(lines) if re.match(r"^## Log\s*$", l)), None)
    if start is None:
        while lines and lines[-1] == "":
            lines.pop()
        lines += ["", "## Log"]
        start = len(lines) - 1
    end = next((i for i in range(start + 1, len(lines)) if lines[i].startswith("## ")), len(lines))
    entries = [l for l in lines[start + 1:end] if l.strip()] + [line]
    rolled = entries[:-keep] if len(entries) > keep else []
    entries = entries[-keep:]
    tail = [""] + lines[end:] if end < len(lines) else [""]
    write_text(ps, "\n".join(lines[:start + 1] + entries + tail), nl)
    touched = ["PROJECT_STATE.md"]
    if rolled:
        ap = root / ARCHIVE_LOG
        if ap.exists():
            atext, anl = read_norm(ap)
            if not atext.endswith("\n"):
                atext += "\n"
        else:
            atext, anl = ARCHIVE_LOG_HEADER, "\n"
        write_text(ap, atext + "".join(l + "\n" for l in rolled), anl)
        touched.append(ARCHIVE_LOG)
    touch(root, touched)
    return len(rolled)


# ---------- git ----------

def git(root, *args):
    p = subprocess.run(["git", "-C", str(root), *args], capture_output=True)
    return p.returncode, p.stdout.decode("utf-8", "surrogateescape"), p.stderr.decode("utf-8", "surrogateescape")


def git_out(root, *args):
    rc, out, _ = git(root, *args)
    return out.strip() if rc == 0 else None


def current_branch(root):
    return git_out(root, "symbolic-ref", "--short", "-q", "HEAD")


def git_step(root, *args):
    rc, out, err = git(root, *args)
    if rc != 0:
        raise GitFailure(args, out, err, current_branch(root) or "(detached)")
    return out


def head_sha(root):
    return git_out(root, "rev-parse", "--verify", "-q", "HEAD")


def short_head(root):
    return git_out(root, "rev-parse", "--short", "HEAD") if head_sha(root) else None


def ref_exists(root, ref):
    return git(root, "show-ref", "--verify", "--quiet", ref)[0] == 0


def is_ancestor(root, a, b):
    return git(root, "merge-base", "--is-ancestor", a, b)[0] == 0


def git_path_exists(root, name):
    out = git_out(root, "rev-parse", "--git-path", name)
    return out is not None and (Path(root) / out).exists()


def merge_head_is(root, branch):
    mh = git_out(root, "rev-parse", "-q", "--verify", "MERGE_HEAD")
    return mh is not None and mh == git_out(root, "rev-parse", "--verify", f"refs/heads/{branch}")


def unmerged(root):
    return bool(git_out(root, "ls-files", "-u"))


def parse_z(out):
    return [x for x in out.split("\0") if x]


def status_paths(root, pathspec):
    """Paths from `git status --porcelain=v1 -z -uall -- <pathspec>` (both sides of a rename)."""
    rc, out, err = git(root, "status", "--porcelain=v1", "-z", "-uall", "--", *pathspec)
    if rc != 0:
        raise GitFailure(["status", "--porcelain=v1", "-z", "-uall", "--", *pathspec], out, err, current_branch(root))
    paths, toks, i = [], out.split("\0"), 0
    while i < len(toks):
        tok = toks[i]
        i += 1
        if not tok:
            continue
        xy, path = tok[:2], tok[3:]
        paths.append(path)
        if "R" in xy or "C" in xy:
            if i < len(toks) and toks[i]:
                paths.append(toks[i])
            i += 1
    return paths


def code_dirty(root):
    return status_paths(root, EXCL)


def memory_dirty(root):
    return status_paths(root, MEM)


def memory_committed_on(root, work, branch):
    rc, out, _ = git(root, "diff", "--name-only", "-z", f"{work}...{branch}", "--", *MEM)
    return parse_z(out) if rc == 0 else []


def stash_ref(root, tid):
    out = git_out(root, "stash", "list", "--format=%gd%x09%gs") or ""
    for line in out.splitlines():
        gd, _, gs = line.partition("\t")
        if gs.endswith(f": keel {tid} wip"):
            return gd
    return None


def preflight(root, allow_dirty=False, allow_merge_of=None, allow_unmerged=False):
    """Shared checks (section 5). Raises KeelError; never switches branches."""
    if current_branch(root) is None:
        raise KeelError("detached HEAD — switch to a branch first")
    for name in ("MERGE_HEAD", "CHERRY_PICK_HEAD", "rebase-merge", "rebase-apply"):
        if git_path_exists(root, name):
            if name == "MERGE_HEAD" and allow_merge_of and merge_head_is(root, allow_merge_of):
                continue
            raise KeelError(f"{name} exists — a merge, rebase or cherry-pick is in progress; finish or abort it first")
    if not allow_unmerged and unmerged(root):
        raise KeelError("unmerged index entries (git ls-files -u) — resolve them first")
    if not allow_dirty:
        dirty = code_dirty(root)
        if dirty:
            shown = ", ".join(dirty[:5]) + (" …" if len(dirty) > 5 else "")
            raise KeelError(f"uncommitted code: {shown} — commit or stash it first (build or test artifacts? add them to .gitignore instead of committing them)")


def memory_commit(root, message="keel: memory"):
    """Stages exactly what `git status -- MEM` lists and commits it. Returns the short sha or None."""
    paths = memory_dirty(root)
    if not paths:
        return None
    git_step(root, "add", "--", *paths)
    if git(root, "diff", "--cached", "--quiet")[0] == 0:
        return None
    h0 = head_sha(root)
    git_step(root, "commit", "-m", message)
    if head_sha(root) == h0:
        raise GitFailure(["commit", "-m", message], "", "HEAD did not move", current_branch(root))
    return short_head(root)


def memory_on_branch_error(root, work, branch, tid, cmd):
    paths = memory_committed_on(root, work, branch)
    if paths:
        plist = " ".join(paths)
        raise KeelError(
            f"memory committed on {branch}: {', '.join(paths)} — run: git restore --source={work} --staged -- {plist} "
            f'&& git commit -m "{tid}: restore memory" (your working-tree edits survive), then run {cmd} again')


def require_branch(root, expected, message=None):
    cur = current_branch(root) or "(detached)"
    if cur != expected:
        raise KeelError(message or f"on {cur} — expected {expected}")
    return cur


# ---------- test commands ----------

def shell_argv():
    """The POSIX shell that runs user test commands: Git Bash on Windows, /bin/sh elsewhere."""
    if os.name != "nt":
        return ["/bin/sh", "-c"]
    roots = []
    g = shutil.which("git")
    if g:
        gp = Path(g).resolve()
        roots += [gp.parents[1]] + ([gp.parents[2]] if len(gp.parents) > 2 else [])
    for r in roots:
        for rel in ("bin/bash.exe", "usr/bin/bash.exe"):
            if (r / rel).exists():
                return [str(r / rel), "-c"]
    b = shutil.which("bash")
    if b and "system32" not in b.lower():
        return [b, "-c"]
    raise KeelError("no POSIX shell found to run test commands — install Git for Windows")


def _kill_tree(p):
    """Kills the shell and every process it started (a hung test server must not outlive the timeout)."""
    try:
        if os.name == "nt":
            subprocess.run(["taskkill", "/F", "/T", "/PID", str(p.pid)], capture_output=True)
        else:
            os.killpg(p.pid, signal.SIGKILL)
    except OSError:
        pass
    try:
        p.kill()
    except OSError:
        pass


def run_shell(root, cmd, timeout):
    """Runs a user shell string in the repo root. Returns (rc, output): rc 127 = not found, -1 = timeout.
    The command gets no stdin, runs in its own process group, and the whole group is killed on timeout."""
    argv = shell_argv() + [cmd]
    group = {"creationflags": subprocess.CREATE_NEW_PROCESS_GROUP} if os.name == "nt" else {"start_new_session": True}
    p = subprocess.Popen(argv, cwd=str(root), stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                         stderr=subprocess.STDOUT, **group)
    try:
        out, _ = p.communicate(timeout=timeout)
    except subprocess.TimeoutExpired:
        _kill_tree(p)
        try:
            out, _ = p.communicate(timeout=10)
        except subprocess.TimeoutExpired:
            out = b""
        return -1, (out or b"").decode("utf-8", "replace")
    return p.returncode, (out or b"").decode("utf-8", "replace")


def output_tail(output, n=OUTPUT_TAIL):
    lines = output.replace("\r\n", "\n").rstrip("\n").split("\n")
    return "\n".join(lines[-n:]) if output.strip() else ""


# ---------- commands ----------

COMMANDS = {}


def command(name):
    def deco(fn):
        COMMANDS[name] = fn
        return fn
    return deco


class _Parser(argparse.ArgumentParser):
    def error(self, message):
        raise KeelError(f"{self.prog}: {message}")


def parser(name, *specs):
    p = _Parser(prog=f"tasks.py {name}")
    for args, kw in specs:
        p.add_argument(*args, **kw)
    return p


@command("list")
def cmd_list(root, ledger, argv):
    parser("list").parse_args(argv)
    order = {s: i for i, s in enumerate(("in_progress", "open", "blocked", "closed", "dropped"))}
    for t in sorted(ledger["tasks"], key=lambda t: (order[t["status"]], t["id"])):
        m = f"M{t['milestone']}" if t["milestone"] is not None else "M-"
        deps = f"deps={','.join(t['deps'])}" if t["deps"] else "deps=-"
        print(f"{t['id']}  {t['status']}  p{t['priority']}  {m}  {t['title']}  {deps}  {t['branch'] or '-'}")


@command("next")
def cmd_next(root, ledger, argv):
    parser("next").parse_args(argv)
    ms, warnings = spec_milestones(root)
    tip = None
    for t in ledger["tasks"]:
        if t["status"] == "in_progress" and t["branch"]:
            tip = git_out(root, "rev-parse", "--verify", f"refs/heads/{t['branch']}")
    print(next_text(ledger, ms, warnings, tip))


@command("state")
def cmd_state(root, ledger, argv):
    a = parser("state", (("--source",), {"default": "cli"})).parse_args(argv)
    print(state_text(root, a.source))


@command("log")
def cmd_log(root, ledger, argv):
    a = parser("log", (("who",), {}), (("verb",), {}), (("summary",), {"nargs": "?", "default": None}),
               (("--sha",), {"default": None})).parse_args(argv)
    sha = a.sha
    if sha is None and a.verb == "closed":  # HEAD may already be past the merge (an adhoc commit)
        t = next((x for x in ledger["tasks"] if x["id"] == a.who), None)
        if t and t.get("commit") and t["commit"] != "-":
            sha = t["commit"]
    rolled = log_append(root, a.who, a.verb, a.summary, sha)
    print("logged" if not rolled else f"logged; rolled {rolled} line{'s' if rolled != 1 else ''}")


@command("start")
def cmd_start(root, ledger, argv):
    a = parser("start", (("id",), {})).parse_args(argv)
    t = get_task(ledger, a.id)
    work = ledger["work_branch"]
    if t["kind"] == "clarify":
        raise KeelError(f"{t['id']} is a clarify task — work it on {work} without start, then tasks.py close {t['id']}")
    others = [x for x in ledger["tasks"] if x["status"] == "in_progress" and x["id"] != t["id"]]
    if others:
        raise KeelError(f"another task is in progress: {others[0]['id']} — close, block or pause it first")
    if t["status"] == "blocked":
        raise KeelError(f"{t['id']} is blocked — tasks.py unblock {t['id']} first")
    if t["status"] in ("closed", "dropped"):
        raise KeelError(f"{t['id']} is {t['status']} — tasks.py reopen {t['id']} first")
    if t["milestone"] is None:
        raise KeelError(f"{t['id']} is backlog — tasks.py set {t['id']} --milestone N first")
    if head_sha(root) is None:
        raise KeelError("no commits yet — commit first (init makes the keel: init commit)")
    branch = f"keel/{t['id']}"
    cur = current_branch(root) or "(detached)"
    if t["status"] == "in_progress" and cur == t["branch"]:
        note = ""
        if t["stash"] and stash_ref(root, t["id"]) is None:
            t["stash"] = None
            write_ledger(root, ledger)
            note = " · stash was popped by hand"
        print(f"resumed {t['id']} (attempt {t['attempts']}){note}")
        return
    if t["branch"] is None:
        if ref_exists(root, f"refs/heads/{branch}"):
            raise KeelError(f"{branch} exists but {t['id']} was never started in this ledger — rename or delete that branch first")
        preflight(root)
        require_branch(root, work, f"not on work branch {work} (on {cur})")
        git_step(root, "switch", "-c", branch)
        require_branch(root, branch, f"git switch -c {branch} did not land on {branch}")
        t["status"], t["branch"] = "in_progress", branch
        if t["attempts"] == 0:
            t["attempts"] = 1
        write_ledger(root, ledger)
        print(f"started {t['id']} (attempt {t['attempts']}) · {branch} from {work}")
        return
    # resume
    parts, fresh = [], False
    if cur == work:
        preflight(root)
        memory_commit(root)
        if ref_exists(root, f"refs/heads/{branch}"):
            git_step(root, "switch", branch)
        else:
            print(f"warning: previous branch {branch} not found — starting fresh", file=sys.stderr)
            git_step(root, "switch", "-c", branch)
            fresh = True
        require_branch(root, branch, f"git switch did not land on {branch}")
    elif cur == branch:
        pass  # re-run after a conflict was resolved
    else:
        raise KeelError(f"not on work branch {work} (on {cur})")
    parts.append(f"resumed {branch}")
    if not fresh:
        if git_path_exists(root, "MERGE_HEAD"):
            raise KeelError(f"merge conflict on {branch} — resolve, git commit, then run start again")
        if not is_ancestor(root, work, "HEAD"):
            rc, out, err = git(root, "merge", "--no-edit", work)
            if rc != 0:
                if unmerged(root) or git_path_exists(root, "MERGE_HEAD"):
                    raise KeelError(f"merge conflict on {branch} — resolve, git commit, then run start again")
                raise GitFailure(["merge", "--no-edit", work], out, err, current_branch(root))
            parts.append(f"merged {work}")
    if t["stash"]:
        ref = stash_ref(root, t["id"])
        if ref is not None:
            rc, out, err = git(root, "stash", "pop", ref)
            if rc != 0 or stash_ref(root, t["id"]) == ref:
                raise KeelError(f"stash conflict — resolve, git stash drop {ref}, then run start again")
            parts.append("popped stash")
    t["status"], t["stash"] = "in_progress", None
    write_ledger(root, ledger)
    print(f"started {t['id']} (attempt {t['attempts']}) · " + " · ".join(parts))


def _park(root, ledger, t, cmd):
    """Shared git ops of block/pause. Returns (wip sha or None, stash message or None, note)."""
    work, branch = ledger["work_branch"], t["branch"]
    cur = current_branch(root) or "(detached)"
    if cur != branch:
        raise KeelError(f"on {cur} — expected {branch}")
    preflight(root, allow_dirty=True)
    memory_on_branch_error(root, work, branch, t["id"], cmd)
    stash = t["stash"] or (f"keel {t['id']} wip" if stash_ref(root, t["id"]) else None)
    wip, note = None, ""
    git_step(root, "add", "-A", "--", *EXCL)
    if git(root, "diff", "--cached", "--quiet")[0] != 0:
        h0 = head_sha(root)
        rc, out, err = git(root, "commit", "-m", f"{t['id']}: wip")
        if rc == 0 and head_sha(root) != h0:
            wip = short_head(root)
        else:
            reason = one_line((err or out).strip().splitlines()[0] if (err or out).strip() else "commit failed")
            msg = f"keel {t['id']} wip"
            rc2, out2, err2 = git(root, "stash", "push", "-u", "-m", msg, "--", *EXCL)
            if rc2 != 0 or stash_ref(root, t["id"]) is None:
                raise GitFailure(["stash", "push", "-u", "-m", msg, "--", *EXCL], out + out2,
                                 f"wip commit failed: {reason}\n" + err + err2, current_branch(root))
            stash, note = msg, f" (stash: {msg} — commit rejected: {reason})"
    git_step(root, "switch", work)
    require_branch(root, work, f"git switch did not land on {work}")
    return wip, stash, note


def _park_text(t, wip, stash, note, work):
    if wip:
        return f"parked on {t['branch']} (wip {wip}) · on {work}"
    if note:
        return f"parked on {t['branch']}{note} · on {work}"
    return f"parked on {t['branch']} (nothing new to commit) · on {work}"


@command("block")
def cmd_block(root, ledger, argv):
    a = parser("block", (("id",), {}), (("question",), {})).parse_args(argv)
    t = get_task(ledger, a.id)
    question = one_line(a.question)
    if not question:
        raise KeelError("block needs a question")
    if t["status"] in ("closed", "dropped"):
        raise KeelError(f"{t['id']} is {t['status']} — tasks.py reopen {t['id']} first")
    if t["status"] != "in_progress":
        t["status"], t["blocked_on"] = "blocked", question
        write_ledger(root, ledger)
        print(f"blocked {t['id']}: {question}")
        return
    wip, stash, note = _park(root, ledger, t, "block")
    t["status"], t["blocked_on"], t["stash"] = "blocked", question, stash
    write_ledger(root, ledger)
    print(f"blocked {t['id']}: {question} · {_park_text(t, wip, stash, note, ledger['work_branch'])}")


@command("pause")
def cmd_pause(root, ledger, argv):
    a = parser("pause", (("id",), {})).parse_args(argv)
    t = get_task(ledger, a.id)
    if t["status"] != "in_progress":
        raise KeelError(f"{t['id']} is {t['status']} — only an in_progress task can be paused")
    wip, stash, note = _park(root, ledger, t, "pause")
    t["status"], t["stash"] = "open", stash
    write_ledger(root, ledger)
    print(f"paused {t['id']} · {_park_text(t, wip, stash, note, ledger['work_branch'])}")


def _count_attempt(root, t):
    """attempts += 1 (the caller writes the ledger); returns `attempt n of max` plus the exhaustion line at the cap."""
    cap = load_keel_json(root)["max_attempts"]
    t["attempts"] += 1
    text = f"attempt {t['attempts']} of {cap}"
    if t["attempts"] >= cap:
        text += f" · attempts exhausted ({t['attempts']}/{cap}) → block this task"
    return text


def _gate_task(ledger, tid, verb):
    t = get_task(ledger, tid)
    if t["kind"] == "clarify":
        raise KeelError(f"{t['id']} is a clarify task — no gates apply")
    if t["status"] != "in_progress":
        what = "red runs on the in_progress task" if verb == "red" else f"{verb} the in_progress task"
        raise KeelError(f"{t['id']} is {t['status']} — {what}")
    return t


# Test code that does not parse is never a valid red; an import of not-yet-written code is.
LOAD_ERROR = re.compile(r"\b(SyntaxError|IndentationError|TabError)\b")
COLLECTION_ERROR = re.compile(r"errors? during collection|ERROR collecting", re.I)


@command("red")
def cmd_red(root, ledger, argv):
    a = parser("red", (("id",), {})).parse_args(argv)
    t = _gate_task(ledger, a.id, "red")
    work = ledger["work_branch"]
    if t["no_tests"]:
        raise KeelError(f"{t['id']} is marked no-tests ({t['no_tests']}) — skip red and implement")
    if not t["test_cmd"]:
        raise KeelError(f'{t["id"]} has no test_cmd — tasks.py set {t["id"]} --test-cmd "<command>" or --no-tests "<reason>"')
    require_branch(root, t["branch"])
    dirty = code_dirty(root)
    if dirty:
        raise KeelError(f"uncommitted code on {t['branch']} — commit the tests first ({', '.join(dirty[:5])})")
    if not git_out(root, "log", "--format=%H", f"{work}..HEAD"):
        raise KeelError(f"no tests commit on {t['branch']} — write the tests and commit them first")
    timeout = load_keel_json(root)["test_timeout"]
    rc, out = run_shell(root, t["test_cmd"], timeout)
    if rc == 0:
        raise KeelError(f"tests pass before implementation — they don't test the task (exit 0): {t['test_cmd']}")
    if rc == 127:
        raise KeelError(f"test command not found (exit 127): {t['test_cmd']}\n{output_tail(out)}")
    if rc == -1:
        raise KeelError(f"test command timed out after {timeout} s: {t['test_cmd']}")
    m = LOAD_ERROR.search(out)
    if m:
        raise KeelError(f"the tests do not load ({m.group(1)}) — fix the test code, commit, re-run red\n{output_tail(out)}")
    head = head_sha(root)
    t["tests_commit"], t["review"] = head, None
    write_ledger(root, ledger)
    tail = output_tail(out)
    if tail:
        print(tail)
    if COLLECTION_ERROR.search(out):
        print("warning: red failed at collection, not on an assertion — confirm the error is the missing code this "
              "task adds (e.g. an import of a module it creates), not broken test code")
    print(f"red {t['id']}: tests fail as required (exit {rc}) · tests commit {head[:7]}")


@command("review")
def cmd_review(root, ledger, argv):
    a = parser("review", (("id",), {}), (("verdict",), {"choices": ("pass", "fail")}), (("reasons",), {})).parse_args(argv)
    t = _gate_task(ledger, a.id, "review")
    require_branch(root, t["branch"])
    dirty = code_dirty(root)
    if dirty:
        raise KeelError(f"uncommitted code on {t['branch']} — commit it first so the review binds to a sha (build or test artifacts? add them to .gitignore instead of committing them): {', '.join(dirty[:5])}")
    head, reasons = head_sha(root), one_line(a.reasons)
    prev = t["review"]
    if a.verdict == "pass" and prev and prev["verdict"] == "fail" and prev["sha"] == head:
        raise KeelError(f"{t['id']}'s review failed on this commit ({head[:7]}) — fix the numbered reasons and commit "
                        f"before a new review")
    t["review"] = {"verdict": a.verdict, "sha": head, "reasons": reasons, "at": today()}
    line = f"review {t['id']}: {a.verdict} ({head[:7]})"
    if a.verdict == "fail":
        line += f" · {_count_attempt(root, t)} — {reasons}"
    write_ledger(root, ledger)
    print(line)


@command("brief")
def cmd_brief(root, ledger, argv):
    a = parser("brief", (("id",), {})).parse_args(argv)
    t = _gate_task(ledger, a.id, "brief")
    p = Path(root) / REVIEW_PROMPT
    if not p.exists():
        raise KeelError("review-prompt.md missing — run /keel upgrade")
    files = "-"
    if t["tests_commit"]:
        names = git_out(root, "diff", "--name-only", "-z", f"{ledger['work_branch']}...{t['tests_commit']}") or ""
        files = " ".join(shlex.quote(n) for n in names.split("\0") if n) or "-"
    suite = load_keel_json(root)["test_command"]
    subs = {"{{ID}}": t["id"], "{{TITLE}}": t["title"], "{{FILE}}": t["file"], "{{WORK_BRANCH}}": ledger["work_branch"],
            "{{BRANCH}}": t["branch"] or "-", "{{TESTS_COMMIT}}": t["tests_commit"] or "-", "{{TEST_FILES}}": files,
            "{{TEST_CMD}}": t["test_cmd"] or "-", "{{TEST_COMMAND}}": suite or "(empty — skip)",
            "{{NO_TESTS}}": t["no_tests"] or "no"}
    text = read_norm(p)[0]
    for k, v in subs.items():
        text = text.replace(k, v)
    print(text.rstrip("\n"))


def _fail_gate(root, ledger, t, what, cmd, out):
    msg = f"{what} — {_count_attempt(root, t)}: {cmd}"
    write_ledger(root, ledger)
    tail = output_tail(out)
    raise KeelError(msg + ("\n" + tail if tail else ""))


def _check_g1_g2(t, head):
    """G1 (tests commit or no-tests) and G2 (a pass review bound to `head`): returns the gate-line parts or raises."""
    parts = []
    if t["no_tests"]:
        parts.append(f"tests skipped (no-tests: {t['no_tests']})")
    elif not t["tests_commit"]:
        raise KeelError(f'{t["id"]} has no tests commit — write the tests, commit them, run tasks.py red {t["id"]} '
                        f'(or set {t["id"]} --no-tests "<reason>")')
    else:
        parts.append(f"tests {t['tests_commit'][:7]}")
    rv = t["review"]
    if not rv:
        raise KeelError(f"{t['id']} has no review — run tasks.py brief {t['id']} and dispatch the reviewer")
    if rv["verdict"] != "pass":
        raise KeelError(f"{t['id']}'s last review failed ({rv['sha'][:7]}): {rv['reasons']} — fix, commit, re-review")
    if rv["sha"] != head:
        raise KeelError(f"{t['id']}'s review ({rv['sha'][:7]}) is older than the branch tip ({head[:7]}) — re-review")
    parts.append(f"review pass {head[:7]}")
    return parts


def _gates(root, ledger, t):
    """close's gates G1–G4 on keel/<id>: prints the gates line or raises (G3/G4 failures cost an attempt)."""
    keel = load_keel_json(root)
    parts = _check_g1_g2(t, head_sha(root))
    timeout, checks = keel["test_timeout"], []
    if t["no_tests"]:
        parts.append("task tests skipped (no-tests)")
    else:
        if not t["test_cmd"]:
            raise KeelError(f'{t["id"]} has no test_cmd — tasks.py set {t["id"]} --test-cmd "<command>"')
        checks.append(("task tests", t["test_cmd"]))
    if keel["test_command"]:
        checks.append(("suite", keel["test_command"]))
    for label, cmd in checks:
        rc, out = run_shell(root, cmd, timeout)
        if rc == 127:
            raise KeelError(f"test command not found (exit 127): {cmd}\n{output_tail(out)}")
        if rc == -1:
            raise KeelError(f"test command timed out after {timeout} s: {cmd}")
        if rc != 0:
            _fail_gate(root, ledger, t, f"{'full suite' if label == 'suite' else label} failed (exit {rc})", cmd, out)
        parts.append(f"{label} exit 0")
    if not keel["test_command"]:
        print("note: keel.json test_command is empty — full suite not run")
        parts.append("suite skipped (test_command empty)")
    print(f"gates {t['id']}: " + " · ".join(parts))


@command("close")
def cmd_close(root, ledger, argv):
    a = parser("close", (("id",), {})).parse_args(argv)
    t = get_task(ledger, a.id)
    work = ledger["work_branch"]
    if t["kind"] == "clarify" and t["status"] == "open" and t["branch"] is None:
        t["status"], t["closed_at"], t["commit"] = "closed", today(), "-"
        write_ledger(root, ledger)
        print(f"closed {t['id']} at {t['closed_at']} · memory-only (-)")
        return
    if t["status"] != "in_progress":
        raise KeelError(f"{t['id']} is {t['status']} — only an in_progress task can be closed")
    branch = t["branch"]
    cur = current_branch(root) or "(detached)"
    if cur == branch:
        preflight(root, allow_dirty=True)
        dirty = code_dirty(root)
        if dirty:
            raise KeelError(f"uncommitted code on {branch} — commit it first ({', '.join(dirty[:5])}) (build or test artifacts? add them to .gitignore instead of committing them)")
        memory_on_branch_error(root, work, branch, t["id"], "close")
        _gates(root, ledger, t)
        git_step(root, "switch", work)
        require_branch(root, work, f"git switch did not land on {work}")
    elif cur == work:
        preflight(root, allow_dirty=True, allow_merge_of=branch, allow_unmerged=True)
        memory_on_branch_error(root, work, branch, t["id"], "close")
        tip = git_out(root, "rev-parse", "--verify", f"refs/heads/{branch}")
        landed = git_out(root, "rev-parse", "-q", "--verify", "HEAD^2") == tip
        if not merge_head_is(root, branch) and not landed:
            raise KeelError(f"on {work} — the merge has not started; run close from {branch} so the gates run")
        _check_g1_g2(t, tip)
    else:
        raise KeelError(f"on {cur} — expected {branch} or {work}")
    if merge_head_is(root, branch):
        if unmerged(root):
            raise KeelError("merge conflict — resolve, git add, then run close again")
        rc, out, err = git(root, "commit", "--no-edit")
        if rc != 0:
            raise KeelError(f"commit rejected by hook/identity: {(out + err).strip()}")
        how = f"merged {branch} into {work}"
    elif unmerged(root):
        raise KeelError("unmerged index entries (git ls-files -u) — resolve them first")
    elif not git_out(root, "log", "--format=%H", f"HEAD..{branch}"):
        second = git_out(root, "rev-parse", "-q", "--verify", "HEAD^2")
        tip = git_out(root, "rev-parse", "--verify", f"refs/heads/{branch}")
        how = f"merged {branch} into {work}" if second and second == tip else "no code changes"
    else:
        rc, out, err = git(root, "merge", "--no-ff", branch, "-m", f"{t['id']}: merge {t['title']}")
        if rc != 0:
            if unmerged(root):
                raise KeelError("merge conflict — resolve, git add, then run close again")
            raise KeelError(f"commit rejected by hook/identity: {(out + err).strip()}")
        how = f"merged {branch} into {work}"
    t["status"], t["closed_at"], t["commit"] = "closed", today(), short_head(root)
    write_ledger(root, ledger)
    print(f"closed {t['id']} at {t['closed_at']} · {how} ({t['commit']})")


@command("retry")
def cmd_retry(root, ledger, argv):
    a = parser("retry", (("id",), {})).parse_args(argv)
    t = get_task(ledger, a.id)
    if t["status"] != "in_progress":
        raise KeelError(f"{t['id']} is {t['status']} — retry counts an abandoned approach of the in_progress task")
    cap = load_keel_json(root)["max_attempts"]
    t["attempts"] += 1
    write_ledger(root, ledger)
    line = f"retry {t['id']} (attempt {t['attempts']} of {cap})"
    if t["attempts"] >= cap:
        line += f" · attempts exhausted ({t['attempts']}/{cap}) → block this task"
    print(line)


@command("unblock")
def cmd_unblock(root, ledger, argv):
    a = parser("unblock", (("id",), {})).parse_args(argv)
    t = get_task(ledger, a.id)
    if t["status"] != "blocked":
        raise KeelError(f"{t['id']} is {t['status']} — not blocked")
    t["status"], t["blocked_on"] = "open", None
    reset = t["attempts"] >= load_keel_json(root)["max_attempts"]
    if reset:
        t["attempts"] = 1
    write_ledger(root, ledger)
    print(f"unblocked {t['id']}" + (f" · {t['branch']} resumes on start" if t["branch"] else "")
          + (" · attempts reset to 1" if reset else ""))


def _mutate_notes(t, verb, why):
    note = f"{verb}: {one_line(why)}"
    t["notes"] = f"{t['notes']} | {note}" if t["notes"] else note


@command("drop")
def cmd_drop(root, ledger, argv):
    a = parser("drop", (("id",), {}), (("why",), {})).parse_args(argv)
    t = get_task(ledger, a.id)
    if t["status"] == "in_progress":
        raise KeelError(f"{t['id']} is in progress — pause or block it first")
    if t["status"] in ("closed", "dropped"):
        raise KeelError(f"{t['id']} is already {t['status']}")
    t["status"], t["closed_at"], t["blocked_on"] = "dropped", today(), None
    _mutate_notes(t, "dropped", a.why)
    write_ledger(root, ledger)
    line = f"dropped {t['id']}: {one_line(a.why)}"
    if t["branch"] and ref_exists(root, f"refs/heads/{t['branch']}"):
        state = "merged" if is_ancestor(root, t["branch"], ledger["work_branch"]) else "unmerged"
        line += f" · branch {t['branch']} kept ({state})"
    print(line)


@command("reopen")
def cmd_reopen(root, ledger, argv):
    a = parser("reopen", (("id",), {}), (("why",), {})).parse_args(argv)
    t = get_task(ledger, a.id)
    if t["status"] not in ("closed", "dropped"):
        raise KeelError(f"{t['id']} is {t['status']} — only a closed or dropped task can be reopened")
    t["status"], t["closed_at"], t["commit"], t["attempts"], t["blocked_on"] = "open", None, None, 0, None
    t["tests_commit"], t["review"] = None, None
    if t["branch"] and not ref_exists(root, f"refs/heads/{t['branch']}"):
        t["branch"] = None
    _mutate_notes(t, "reopened", a.why)
    touched, restored = [], ""
    if t["file"].startswith("archive/tasks/"):
        new = "docs/tasks/" + t["file"][len("archive/tasks/"):]
        src, dst = Path(root) / t["file"], Path(root) / new
        if src.exists():
            dst.parent.mkdir(parents=True, exist_ok=True)
            os.replace(src, dst)
            touched += [t["file"], new]
            restored = f" (file restored to {new})"
        t["file"] = new
    write_ledger(root, ledger, touched)
    print(f"reopened {t['id']}: {one_line(a.why)}{restored}")


def _milestone_default(ledger):
    ip = [t for t in ledger["tasks"] if t["status"] == "in_progress" and t["milestone"] is not None]
    if ip:
        return ip[0]["milestone"]
    if ledger["planned_milestones"]:
        return max(ledger["planned_milestones"])
    return 1


def _warn_unplanned(ledger, n):
    if n is not None and n not in ledger["planned_milestones"]:
        print(f"warning: M{n} is not in planned_milestones — run tasks.py plan {n} after adding its tasks")


def _parse_deps(s):
    return [d.strip() for d in s.split(",") if d.strip()] if s else []


def slugify(title):
    s = unicodedata.normalize("NFKD", title).encode("ascii", "ignore").decode("ascii").lower()
    s = re.sub(r"[^a-z0-9]+", "-", s).strip("-")[:40].strip("-")
    return s or "task"


@command("add")
def cmd_add(root, ledger, argv):
    p = parser("add", (("title",), {}), (("--priority",), {"type": int, "default": 5}),
               (("--deps",), {"default": ""}), (("--slug",), {"default": None}),
               (("--notes",), {"default": ""}), (("--kind",), {"choices": KINDS, "default": "task"}),
               (("--test-cmd",), {"default": None, "dest": "test_cmd"}))
    g = p.add_mutually_exclusive_group()
    g.add_argument("--milestone", type=int, default=None)
    g.add_argument("--backlog", action="store_true")
    a = p.parse_args(argv)
    title = one_line(a.title)
    if not title:
        raise KeelError("add needs a title")
    if len(title) > 80:
        raise KeelError("title must be 80 characters or fewer")
    ids = [int(t["id"]) for t in ledger["tasks"]]
    tid = f"{(max(ids) + 1 if ids else 1):03d}"
    milestone = None if a.backlog else (a.milestone if a.milestone is not None else _milestone_default(ledger))
    file = f"docs/tasks/{tid}-{a.slug or slugify(title)}.md"
    task = {"id": tid, "title": title, "status": "open", "priority": a.priority, "milestone": milestone,
            "deps": _parse_deps(a.deps), "file": file, "blocked_on": None, "attempts": 0, "branch": None,
            "stash": None, "closed_at": None, "commit": None, "notes": one_line(a.notes), "kind": a.kind,
            "test_cmd": one_line(a.test_cmd) if a.test_cmd else None, "tests_commit": None, "no_tests": None, "review": None}
    ledger["tasks"].append(task)
    errs = validate(ledger)
    if errs:
        raise KeelError("; ".join(errs))
    body = TASK_TEMPLATE.replace("{{ID}}", tid).replace("{{TITLE}}", title)
    if task["test_cmd"]:
        body = body.replace("{{TEST_CMD}}", task["test_cmd"])
    write_text(Path(root) / file, body, "\n")
    write_ledger(root, ledger, [file])
    _warn_unplanned(ledger, milestone)
    print(f"added {tid} · {title} ({'M' + str(milestone) if milestone is not None else 'backlog'}) → {file}")
    if a.kind == "task" and not task["test_cmd"]:
        print(f"warning: {tid} has no test_cmd — set it (or --no-tests) before red")


@command("set")
def cmd_set(root, ledger, argv):
    p = parser("set", (("id",), {}), (("--priority",), {"type": int, "default": None}),
               (("--deps",), {"default": None}), (("--title",), {"default": None}), (("--notes",), {"default": None}),
               (("--test-cmd",), {"default": None, "dest": "test_cmd"}))
    g = p.add_mutually_exclusive_group()
    g.add_argument("--milestone", type=int, default=None)
    g.add_argument("--backlog", action="store_true")
    g2 = p.add_mutually_exclusive_group()
    g2.add_argument("--no-tests", default=None, dest="no_tests")
    g2.add_argument("--require-tests", action="store_true", dest="require_tests")
    a = p.parse_args(argv)
    t = get_task(ledger, a.id)
    changes, cleared = [], []

    def invalidate(red_too):
        if red_too and t["tests_commit"]:
            t["tests_commit"] = None
            cleared.append("red")
        if t["review"]:
            t["review"] = None
            cleared.append("review")

    if a.test_cmd is not None:
        t["test_cmd"] = one_line(a.test_cmd) or None
        changes.append(f"test_cmd → {t['test_cmd'] or '-'}")
        invalidate(True)
    if a.no_tests is not None:
        reason = one_line(a.no_tests)
        if not reason:
            raise KeelError("--no-tests needs a reason")
        t["no_tests"] = reason
        changes.append(f"no-tests → {reason}")
        invalidate(False)
    if a.require_tests:
        t["no_tests"] = None
        changes.append("tests required")
        invalidate(True)
    if a.priority is not None:
        changes.append(f"priority {t['priority']} → {a.priority}")
        t["priority"] = a.priority
    if a.deps is not None:
        new = _parse_deps(a.deps)
        changes.append(f"deps {','.join(t['deps']) or '-'} → {','.join(new) or '-'}")
        t["deps"] = new
    if a.title is not None:
        changes.append(f"title → {one_line(a.title)}")
        t["title"] = one_line(a.title)
    if a.notes is not None:
        changes.append("notes updated")
        t["notes"] = one_line(a.notes)
    if a.backlog:
        if t["status"] == "in_progress":
            raise KeelError(f"{t['id']} is in progress — pause or block it before moving it to the backlog")
        changes.append(f"milestone {t['milestone'] if t['milestone'] is not None else 'backlog'} → backlog")
        t["milestone"] = None
    if a.milestone is not None:
        changes.append(f"milestone {t['milestone'] if t['milestone'] is not None else 'backlog'} → {a.milestone}")
        t["milestone"] = a.milestone
    if not changes:
        raise KeelError("set: nothing to change")
    write_ledger(root, ledger)
    if a.milestone is not None:
        _warn_unplanned(ledger, a.milestone)
    for c in changes:
        print(f"set {t['id']}: {c}")
    if cleared:
        print(f"set {t['id']}: cleared {' and '.join(cleared)} — re-run {'red and ' if 'red' in cleared else ''}the review")


@command("set-work-branch")
def cmd_set_work_branch(root, ledger, argv):
    a = parser("set-work-branch", (("name",), {})).parse_args(argv)
    ip = [t for t in ledger["tasks"] if t["status"] == "in_progress"]
    if ip:
        raise KeelError(f"{ip[0]['id']} is in progress — pause or block {ip[0]['id']} first")
    if not ref_exists(root, f"refs/heads/{a.name}"):
        raise KeelError(f"branch {a.name} does not exist")
    old = ledger["work_branch"]
    ledger["work_branch"] = a.name
    write_ledger(root, ledger)
    print(f"work_branch: {old} → {a.name}")


@command("plan")
def cmd_plan(root, ledger, argv):
    a = parser("plan", (("n",), {"type": int})).parse_args(argv)
    work = ledger["work_branch"]
    cur = current_branch(root) or "(detached)"
    if cur != work:
        raise KeelError(f"not on work branch {work} (on {cur})")
    ms, _ = spec_milestones(root)
    if a.n not in ms:
        print(f"warning: SPEC.md has no ### M{a.n} heading")
    elif ms[a.n]["dropped"]:
        print(f"warning: M{a.n} is marked (dropped) in SPEC.md")
    if a.n not in ledger["planned_milestones"]:
        ledger["planned_milestones"].append(a.n)
    write_ledger(root, ledger)
    count = sum(1 for t in ledger["tasks"] if t["milestone"] == a.n)
    print(f"planned M{a.n} ({count} tasks)")


def main(argv=None):
    argv = sys.argv[1:] if argv is None else list(argv)
    if not argv or argv[0] not in COMMANDS:
        print(f"usage: tasks.py <{'|'.join(COMMANDS)}> [args]", file=sys.stderr)
        return 1
    try:
        root = repo_root()
        if not ledger_path(root).exists():
            raise NotKeelRepo(f"not a keel repo: {ledger_path(root)} is missing")
        with Lock(root):
            ledger = load_ledger(root)
            COMMANDS[argv[0]](root, ledger, argv[1:])
        return 0
    except NotKeelRepo as e:
        print(f"tasks.py: {e}", file=sys.stderr)
        return 2
    except KeelError as e:
        print(f"tasks.py: {e}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
