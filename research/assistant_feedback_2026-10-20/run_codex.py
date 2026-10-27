"""Three independent description-only reviews; no product .env or user session is read."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import time
from datetime import datetime, timezone

ROOT = Path(__file__).resolve().parent
PROMPT = ROOT / "frozen_prompt.txt"
SCRATCH = ROOT / "scratch" / "codex"
SCRATCH.mkdir(parents=True, exist_ok=True)
PROMPT_HASH = hashlib.sha256(PROMPT.read_bytes()).hexdigest()
REPORT = ROOT / "codex_manifest.json"
ATTEMPT = int(sys.argv[1]) if len(sys.argv) > 1 else 1
results = json.loads(REPORT.read_text(encoding="utf-8"))["runs"] if REPORT.exists() else []

def save(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8")

for repeat in range(1, 4):
    folder = ROOT / "raw" / (f"codex-gpt-5.6-sol__r{repeat}" + (f"__attempt{ATTEMPT}" if ATTEMPT > 1 else ""))
    folder.mkdir(parents=True, exist_ok=False)
    (folder / "input.txt").write_bytes(PROMPT.read_bytes())
    started = datetime.now(timezone.utc).isoformat()
    before = time.monotonic()
    timed_out = False
    args = ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File",
            str(ROOT / "run_codex.ps1"), "-PromptPath", str(PROMPT), "-WorkspacePath", str(SCRATCH)]
    with (folder / "stdout.jsonl").open("wb") as output, (folder / "stderr.txt").open("wb") as error:
        process = subprocess.Popen(args, cwd=SCRATCH, stdin=subprocess.DEVNULL,
                                   stdout=output, stderr=error, creationflags=subprocess.CREATE_NO_WINDOW)
        try:
            code = process.wait(timeout=180)
        except subprocess.TimeoutExpired:
            timed_out = True
            subprocess.run(["taskkill", "/PID", str(process.pid), "/T", "/F"], capture_output=True,
                           timeout=15, creationflags=subprocess.CREATE_NO_WINDOW, check=False)
            code = process.wait(timeout=10)
    records = []
    for line in (folder / "stdout.jsonl").read_text(encoding="utf-8", errors="replace").splitlines():
        try:
            records.append(json.loads(line))
        except json.JSONDecodeError:
            pass
    messages = [event["item"]["text"] for event in records
                if event.get("type") == "item.completed" and event.get("item", {}).get("type") == "agent_message"]
    tool_events = [event for event in records
                   if event.get("item", {}).get("type") in ("command_execution", "mcp_tool_call", "web_search", "file_change")]
    thread_id = next((event.get("thread_id") for event in records if event.get("type") == "thread.started"), None)
    answer = messages[-1] if messages else ""
    (folder / "answer.txt").write_text(answer, encoding="utf-8")
    errors = []
    parsed = None
    try:
        parsed = json.loads(answer)
        if parsed.get("source_type") != "model_simulation" or parsed.get("exposure") != "description_only":
            errors.append("wrong_source_or_exposure")
        answers = parsed.get("answers", {})
        if set(answers) != {f"Q{i}" for i in range(1, 9)}:
            errors.append("missing_questions")
        if set(answers.get("Q2", {})) != {"S1", "S2", "S3"}:
            errors.append("missing_scenarios")
        if not isinstance(answers.get("Q7"), list) or len(answers.get("Q7", [])) > 3:
            errors.append("invalid_priorities")
        feedback = parsed.get("feedback_form", {})
        if feedback.get("usageStage") != "concept_only" or feedback.get("rating") is not None:
            errors.append("invalid_exposure_or_rating")
        if feedback.get("topic") not in {"timing", "missed_request", "context", "draft", "input", "other"}:
            errors.append("invalid_topic")
        for key in ("Q1", "Q3", "Q4", "Q5", "Q6", "Q8"):
            if not isinstance(answers.get(key), str) or not answers[key].strip():
                errors.append(f"invalid_{key}")
        save(folder / "response.json", parsed)
    except (json.JSONDecodeError, AttributeError, TypeError):
        errors.append("invalid_json")
    if tool_events:
        errors.append("tool_events_present")
    if not thread_id:
        errors.append("no_session_id")
    if code != 0 or timed_out:
        errors.append("process_failed_or_timed_out")
    metadata = {
        "run_id": folder.name, "platform": "Codex CLI", "requested_model": "gpt-5.6-sol",
        "reported_model": None, "reasoning_effort": "high", "repeat": repeat, "attempt": ATTEMPT,
        "session_id": thread_id, "source_type": "model_simulation", "exposure": "description_only",
        "prompt_sha256": PROMPT_HASH, "started_at": started,
        "ended_at": datetime.now(timezone.utc).isoformat(), "duration_seconds": round(time.monotonic() - before, 2),
        "exit_code": code, "timed_out": timed_out, "tool_event_count": len(tool_events),
        "accepted": not errors, "validation_errors": errors,
        "raw_directory": str(folder.relative_to(ROOT))
    }
    save(folder / "metadata.json", metadata)
    results.append(metadata)
    save(REPORT, {"planned": 3, "attempts": len(results), "completed_repeats_this_attempt": repeat,
                  "accepted": sum(r["accepted"] for r in results),
                  "finalized": repeat == 3, "prompt_sha256": PROMPT_HASH, "runs": results})
    print(json.dumps({"run": folder.name, "accepted": not errors, "errors": errors,
                      "seconds": metadata["duration_seconds"]}, ensure_ascii=False), flush=True)
