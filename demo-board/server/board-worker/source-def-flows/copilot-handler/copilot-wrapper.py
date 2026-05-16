#!/usr/bin/env python3
"""
Copilot CLI wrapper for board task executor.

Replaces copilot_wrapper.bat + copilot_wrapper_helper.ps1 with a single
cross-platform Python script.

Responsibilities:
  - Session management (--resume UUID for multi-turn continuity)
  - Copilot sandbox flags: -s --no-ask-user --allow-all-tools --add-dir=...
  - Output cleaning: noise stripping, stats footer removal
  - JSON extraction with optional result_shape key matching
  - Agentic retry: if first response isn't valid JSON, retry with correction prompt
  - Logging (per-agent, rotated to last 50)

Usage (called by demo-task-executor.js, not directly):
  python scripts/copilot/wrapper.py \\
    --output-file <path>     Result written here (JSON or raw text)
    --session-dir <path>     Persistent dir for session UUID
    --cwd <path>             Working directory for copilot
    --prompt-file <path>     File containing the prompt
    --result-type json|raw   How to process output (default: json)
    --agent-name <name>      For log file naming (default: executor)
    --add-dir <path>         Can be repeated; passed as --add-dir to copilot
    --result-shape-file <p>  JSON file with expected top-level keys
"""

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import uuid
from datetime import datetime, timedelta
from pathlib import Path


# ---------------------------------------------------------------------------
# Output cleaning — noise line patterns
# ---------------------------------------------------------------------------

NOISE_PATTERNS = [
    re.compile(r"^[\u25cf\u2022] "),           # ● bullet tool ops
    re.compile(r"^X "),                          # X failed tool ops
    re.compile(r"^\$ "),                         # $ shell commands
    re.compile(r"^[\u2514\u251c]"),              # └ ├ tree lines
    re.compile(r"session-state.*\.json"),         # session-state file paths
    re.compile(r"agent.decision has been simulated"),
    re.compile(r"has been simulated and saved"),
    re.compile(r"^\d+ (?:files?|lines?|matches?) found$"),
    re.compile(r"^No matches found$"),
    re.compile(r"^Path does not exist$"),
    re.compile(r"^\d+ lines?(?: read)?$"),
]

STATS_PREFIXES = (
    "Total usage est:", "API time spent:", "Total session time:",
    "Total code changes:", "Breakdown by AI model:", "Session:",
    "Changes", "Requests", "Tokens",
)

KNOWN_NOISE_LINES = [
    "error: unknown option '--no-warnings'",
    "Try 'copilot --help' for more information",
]


def clean_output(raw: str) -> tuple[str, list[str]]:
    """Strip noise lines, tool ops, and trailing stats from copilot output.

    Returns (cleaned_text, noise_lines).
    """
    # Step 1: filter known noise
    lines = [
        line for line in raw.splitlines()
        if not any(noise in line for noise in KNOWN_NOISE_LINES)
    ]

    # Step 2: strip tool operation lines
    noise_lines: list[str] = []
    content_lines: list[str] = []
    for line in lines:
        stripped = line.lstrip()
        if any(p.search(stripped) for p in NOISE_PATTERNS):
            noise_lines.append(line)
        else:
            content_lines.append(line)

    # Step 3: strip trailing usage stats
    result_lines: list[str] = []
    hit_stats = False
    for line in content_lines:
        if not hit_stats:
            for prefix in STATS_PREFIXES:
                if line.lstrip().startswith(prefix):
                    hit_stats = True
                    break
        if not hit_stats:
            result_lines.append(line)

    return "\n".join(result_lines).strip(), noise_lines


# ---------------------------------------------------------------------------
# JSON extraction
# ---------------------------------------------------------------------------

def extract_json(text: str, shape_keys: list[str] | None = None) -> str | None:
    """Extract first JSON object from text, optionally matching shape keys.

    Returns the JSON string if found, None otherwise.
    """

    def has_shape(obj: dict) -> bool:
        if not shape_keys:
            return True
        return all(k in obj for k in shape_keys)

    # 1: Look in ```json fenced blocks first
    m = re.search(r"```json\s*(.*?)```", text, re.DOTALL)
    if m:
        try:
            obj = json.loads(m.group(1).strip())
            if isinstance(obj, dict) and has_shape(obj):
                return m.group(1).strip()
        except (json.JSONDecodeError, TypeError):
            pass

    # 2: Scan for bare JSON objects (brace matching)
    depth = 0
    start = -1
    for i, ch in enumerate(text):
        if ch == "{":
            if depth == 0:
                start = i
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0 and start >= 0:
                candidate = text[start : i + 1]
                try:
                    obj = json.loads(candidate)
                    if isinstance(obj, dict) and has_shape(obj):
                        return candidate
                except (json.JSONDecodeError, TypeError):
                    pass
                start = -1

    return None


def shape_skeleton(shape_keys: list[str] | None) -> str:
    """Build a JSON skeleton from shape keys (all values null)."""
    if shape_keys:
        return json.dumps({k: None for k in shape_keys}, separators=(",", ":"))
    return "{}"


# ---------------------------------------------------------------------------
# Session management
# ---------------------------------------------------------------------------

def get_or_create_session_uuid(session_dir: Path) -> str:
    """Read or create a persistent session UUID."""
    uuid_file = session_dir / "session.uuid"
    if uuid_file.exists():
        return uuid_file.read_text().strip()
    session_uuid = str(uuid.uuid4())
    session_dir.mkdir(parents=True, exist_ok=True)
    uuid_file.write_text(session_uuid)
    return session_uuid


def setup_session_cache(session_dir: Path, cache_session_path: Path) -> None:
    """Move workspace.yaml and related files into copilot's cache session dir."""
    workspace_yaml = session_dir / "workspace.yaml"
    if not workspace_yaml.exists():
        return

    if cache_session_path.exists():
        shutil.rmtree(cache_session_path, ignore_errors=True)
    cache_session_path.mkdir(parents=True, exist_ok=True)

    for item in session_dir.iterdir():
        if item.name == "session.uuid":
            continue
        dest = cache_session_path / item.name
        if item.is_dir():
            shutil.move(str(item), str(dest))
        else:
            shutil.move(str(item), str(dest))


def restore_session_cache(session_dir: Path, cache_session_path: Path) -> None:
    """Move files back from copilot's cache session dir to session dir."""
    if not cache_session_path.exists():
        return
    for item in cache_session_path.iterdir():
        dest = session_dir / item.name
        shutil.move(str(item), str(dest))
    cache_session_path.rmdir()


# ---------------------------------------------------------------------------
# Lock management
# ---------------------------------------------------------------------------

def acquire_lock(lock_file: Path, stale_minutes: int = 20) -> None:
    """Simple file-based lock with stale detection."""
    if lock_file.exists():
        try:
            mtime = datetime.fromtimestamp(lock_file.stat().st_mtime)
            if datetime.now() - mtime > timedelta(minutes=stale_minutes):
                lock_file.unlink(missing_ok=True)
        except OSError:
            pass

    # Spin until we can create the lock file exclusively
    import time
    for _ in range(120):  # max 2 minutes
        try:
            fd = os.open(str(lock_file), os.O_CREAT | os.O_EXCL | os.O_WRONLY)
            os.write(fd, datetime.now().isoformat().encode())
            os.close(fd)
            return
        except FileExistsError:
            time.sleep(1)

    # Force acquire after timeout
    lock_file.write_text(datetime.now().isoformat())


def release_lock(lock_file: Path) -> None:
    lock_file.unlink(missing_ok=True)


# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------

def write_log(log_dir: Path, agent_name: str, result_type: str,
              cwd: str, prompt: str, response: str, max_logs: int = 50) -> None:
    """Write a timestamped log file and rotate old logs."""
    log_dir.mkdir(parents=True, exist_ok=True)
    ts = datetime.now().strftime("%Y%m%d-%H%M%S")
    log_file = log_dir / f"{agent_name}_{ts}.log"

    content = (
        f"=== PROMPT ({ts}) ===\n"
        f"Agent: {agent_name}\n"
        f"ResultType: {result_type}\n"
        f"Working Dir: {cwd}\n"
        f"---\n"
        f"{prompt}\n\n"
        f"=== RESPONSE ===\n"
        f"{response}\n"
        f"=== END ===\n"
    )
    log_file.write_text(content, encoding="utf-8")

    # Rotate: keep only the last max_logs
    pattern = f"{agent_name}_*.log"
    logs = sorted(log_dir.glob(pattern), key=lambda p: p.name, reverse=True)
    for old_log in logs[max_logs:]:
        old_log.unlink(missing_ok=True)


# ---------------------------------------------------------------------------
# Copilot invocation
# ---------------------------------------------------------------------------

def run_copilot(session_uuid: str, prompt: str | None, prompt_file: Path | None,
                cwd: str, add_dirs: list[str]) -> str:
    """Invoke copilot CLI and return raw output."""
    args = [
        "copilot",
        "-s",                # silent — no stats/decoration
        "--no-ask-user",     # never block on input
        "--allow-all-tools", # allow all tool permissions
    ]
    for d in add_dirs:
        args.append(f"--add-dir={d}")
    args.extend(["--resume", session_uuid])

    if prompt_file:
        # Pipe prompt from file via stdin
        with open(prompt_file, "r", encoding="utf-8") as f:
            input_text = f.read()
    else:
        input_text = prompt
        args.extend(["-p", prompt or ""])

    if input_text and not prompt:
        # Stdin pipe mode (no -p flag, pipe input)
        result = subprocess.run(
            args, input=input_text, capture_output=True, text=True,
            encoding='utf-8', errors='replace',
            cwd=cwd, timeout=300,
        )
    elif prompt_file:
        # Prompt file → pipe via stdin
        result = subprocess.run(
            args, input=input_text, capture_output=True, text=True,
            encoding='utf-8', errors='replace',
            cwd=cwd, timeout=300,
        )
    else:
        # -p mode
        result = subprocess.run(
            args, capture_output=True, text=True,
            encoding='utf-8', errors='replace',
            cwd=cwd, timeout=300,
        )

    output = result.stdout or ""
    if result.stderr:
        output += "\n" + result.stderr
    return output


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> int:
    parser = argparse.ArgumentParser(description="Copilot CLI wrapper for board task executor")
    parser.add_argument("--output-file", required=True, help="Path to write result")
    parser.add_argument("--session-dir", required=True, help="Persistent session directory")
    parser.add_argument("--cwd", required=True, help="Working directory for copilot")
    parser.add_argument("--prompt-file", help="File containing the prompt")
    parser.add_argument("--prompt", help="Inline prompt string")
    parser.add_argument("--result-type", default="json", choices=["json", "raw"])
    parser.add_argument("--agent-name", default="executor")
    parser.add_argument("--add-dir", action="append", default=[], dest="add_dirs")
    parser.add_argument("--result-shape-file", default="")

    args = parser.parse_args()

    output_file = Path(args.output_file)
    session_dir = Path(args.session_dir)
    cwd = args.cwd

    # Load result_shape keys if provided
    shape_keys: list[str] | None = None
    if args.result_shape_file and Path(args.result_shape_file).exists():
        try:
            shape = json.loads(Path(args.result_shape_file).read_text(encoding="utf-8"))
            shape_keys = list(shape.keys()) if isinstance(shape, dict) else None
        except (json.JSONDecodeError, OSError):
            pass

    # Read prompt
    prompt_text = ""
    if args.prompt_file and Path(args.prompt_file).exists():
        prompt_text = Path(args.prompt_file).read_text(encoding="utf-8")
    elif args.prompt:
        prompt_text = args.prompt

    # Session + lock setup
    wd_hash = re.sub(r"[\\/:. ]", "", cwd)
    copilot_base = Path(tempfile.gettempdir()) / "copilot-sessions" / wd_hash
    copilot_cache = copilot_base / "session-state"
    lock_file = copilot_base / "copilot.lock"
    log_dir = copilot_base / "copilot-logs"

    copilot_base.mkdir(parents=True, exist_ok=True)
    copilot_cache.mkdir(parents=True, exist_ok=True)
    session_dir.mkdir(parents=True, exist_ok=True)

    acquire_lock(lock_file)
    try:
        session_uuid = get_or_create_session_uuid(session_dir)
        cache_session_path = copilot_cache / session_uuid

        # Move workspace session files into copilot's cache
        setup_session_cache(session_dir, cache_session_path)

        # --- First copilot invocation ---
        raw_output = run_copilot(
            session_uuid=session_uuid,
            prompt=None if args.prompt_file else args.prompt,
            prompt_file=Path(args.prompt_file) if args.prompt_file else None,
            cwd=cwd,
            add_dirs=args.add_dirs,
        )

        # Log raw output
        write_log(log_dir, args.agent_name, args.result_type, cwd, prompt_text, raw_output)

        # Clean output
        cleaned, noise_lines = clean_output(raw_output)

        # Write noise sidecar
        noise_file = Path(str(output_file) + ".noise")
        if noise_lines:
            noise_file.write_text(
                f"STRIPPED_LINES={len(noise_lines)}\n" + "\n".join(noise_lines),
                encoding="utf-8",
            )
        elif noise_file.exists():
            noise_file.unlink()

        if args.result_type == "raw":
            output_file.write_text(cleaned, encoding="utf-8")
        else:
            # JSON extraction
            if not cleaned:
                output_file.write_text(shape_skeleton(shape_keys), encoding="utf-8")
            else:
                found = extract_json(cleaned, shape_keys)
                if found:
                    output_file.write_text(found, encoding="utf-8")
                else:
                    # --- Retry: ask copilot for just the JSON ---
                    retry_prompt = (
                        "Your previous response did not contain a valid JSON object.\n"
                        "Please respond with ONLY the JSON object — no markdown, "
                        "no explanation, no preamble.\n"
                        "Start your response with { and end with }."
                    )
                    retry_output = run_copilot(
                        session_uuid=session_uuid,
                        prompt=retry_prompt,
                        prompt_file=None,
                        cwd=cwd,
                        add_dirs=args.add_dirs,
                    )
                    retry_cleaned, _ = clean_output(retry_output)
                    retry_found = extract_json(retry_cleaned, shape_keys)
                    if retry_found:
                        output_file.write_text(retry_found, encoding="utf-8")
                    else:
                        # Give up — write shape skeleton so card gets structured (empty) result
                        fallback_noise = (
                            f"FALLBACK=no_json_match\n"
                            f"SHAPE_KEYS={','.join(shape_keys or [])}\n"
                            f"RAW_LENGTH={len(cleaned)}\n---\n{cleaned}"
                        )
                        if noise_file.exists():
                            existing = noise_file.read_text(encoding="utf-8")
                            noise_file.write_text(existing + "\n" + fallback_noise, encoding="utf-8")
                        else:
                            noise_file.write_text(fallback_noise, encoding="utf-8")
                        output_file.write_text(shape_skeleton(shape_keys), encoding="utf-8")

        # Restore session files
        restore_session_cache(session_dir, cache_session_path)

    finally:
        release_lock(lock_file)

    return 0


if __name__ == "__main__":
    sys.exit(main())
