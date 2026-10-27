"""Frozen-text concept walkthroughs. No research participants or product feedback."""
import concurrent.futures as cf
import datetime as dt
import hashlib
import json
import re
import subprocess
import sys
import threading
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8")
ROOT = Path(__file__).resolve().parent
PROMPT_BYTES = (ROOT / "frozen_prompt.txt").read_bytes()
PROMPT = PROMPT_BYTES.decode("utf-8-sig")
PROMPT_HASH = hashlib.sha256(PROMPT_BYTES).hexdigest()
PWSH = r"C:\Program Files\PowerShell\7\pwsh.exe"
MODELS = [
    ("cursor", "claude-opus-5-5-high", r"Claude Opus 5\.5.*High"),
    ("cursor", "gemini-4-argon-high", r"Gemini 4 Argon.*High"),
    ("cursor", "grok-4.7-high", r"Grok 4\.7.*High"),
    ("cursor", "claude-sonnet-5-5-high", r"Claude Sonnet 5\.5.*High"),
    ("cursor", "gemini-3.1-pro", r"Gemini 3\.1 Pro"),
    ("cursor", "composer-2.5", r"Composer 2\.5"),
    ("cursor", "kimi-k3-high", r"Kimi K3"),
    ("cursor", "glm-5.2-high", r"GLM 5\.2"),
    ("cursor", "muse-spark-1.3-high", r"Muse Spark 1\.3"),
]
BLOCKED = set()
LOCK = threading.Lock()
STARTED = dt.datetime.now(dt.timezone.utc).isoformat()


def now():
    return dt.datetime.now(dt.timezone.utc).isoformat()


def save(path, data):
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


def validate(data):
    errors = []
    if not isinstance(data, dict):
        return ["Response is not an object"]
    for key, expected in [("source_type", "model_simulation"), ("exposure", "description_only")]:
        if data.get(key) != expected:
            errors.append(f"{key} must be {expected}")
    ans = data.get("answers", {})
    if not isinstance(ans, dict) or set(ans) != {f"Q{i}" for i in range(1, 9)}:
        errors.append("answers must contain exactly Q1-Q8")
        ans = ans if isinstance(ans, dict) else {}
    for key in ["Q1", "Q3", "Q4", "Q5", "Q6", "Q8"]:
        if not isinstance(ans.get(key), str) or not ans[key].strip():
            errors.append(f"{key} is missing text")
    scenarios = ans.get("Q2", {})
    if not isinstance(scenarios, dict) or set(scenarios) != {"S1", "S2", "S3"}:
        errors.append("Q2 must contain S1-S3")
    elif any(not isinstance(v, str) or not v.strip() for v in scenarios.values()):
        errors.append("Q2 scenarios must contain text")
    priorities = ans.get("Q7")
    if not isinstance(priorities, list) or len(priorities) > 3:
        errors.append("Q7 must contain at most three priorities")
    else:
        for i, item in enumerate(priorities):
            if not isinstance(item, dict):
                errors.append(f"Q7[{i}] is not an object")
                continue
            if item.get("priority") not in {"P0", "P1", "P2"}:
                errors.append(f"Q7[{i}] priority invalid")
            ids = item.get("feature_ids")
            if not isinstance(ids, list) or not ids or any(
                not isinstance(x, str) or not re.fullmatch(r"F(0[1-9]|1[0-4])", x) for x in ids
            ):
                errors.append(f"Q7[{i}] feature_ids invalid")
            for key in ["condition", "issue", "suggestion"]:
                if not isinstance(item.get(key), str) or not item[key].strip():
                    errors.append(f"Q7[{i}] {key} missing")
    form = data.get("feedback_form", {})
    if not isinstance(form, dict):
        return errors + ["feedback_form missing"]
    if form.get("usageStage") != "concept_only":
        errors.append("usageStage must be concept_only")
    if "rating" not in form or form["rating"] is not None:
        errors.append("rating must be null")
    if form.get("topic") not in {"timing", "missed_request", "context", "draft", "input", "other"}:
        errors.append("feedback topic invalid")
    for key in ["message", "expected"]:
        if not isinstance(form.get(key), str) or not form[key].strip():
            errors.append(f"feedback {key} missing")
    return errors


def audit(folder, provider, model, pattern, execution):
    raw = (folder / "stdout.jsonl").read_text(encoding="utf-8", errors="replace")
    err = (folder / "stderr.txt").read_text(encoding="utf-8", errors="replace")
    events, malformed = [], []
    for n, line in enumerate(raw.splitlines(), 1):
        if not line.strip():
            continue
        try:
            events.append(json.loads(line))
        except json.JSONDecodeError:
            malformed.append(n)
    models, sessions, tool_events, user_texts, answers = [], [], [], [], []
    success = False
    for event in events:
        typ = event.get("type", "")
        if event.get("model"):
            models.append(str(event["model"]))
        if event.get("session_id"):
            sessions.append(str(event["session_id"]))
        if event.get("thread_id"):
            sessions.append(str(event["thread_id"]))
        if "tool" in typ:
            tool_events.append(event)
        message = event.get("message", {})
        content = message.get("content", []) if isinstance(message, dict) else []
        if isinstance(content, list):
            text = "".join(x.get("text", "") for x in content if isinstance(x, dict) and x.get("type") == "text")
            if typ == "user":
                user_texts.append(text)
            for part in content:
                if isinstance(part, dict) and "tool" in part.get("type", ""):
                    tool_events.append(event)
                    break
            if typ == "assistant" and text:
                answers.append(text)
        if provider == "cursor" and typ == "result":
            success = event.get("subtype") == "success" and event.get("is_error") is not True
            if isinstance(event.get("result"), str):
                answers = [event["result"]]
        item = event.get("item", {})
        if provider == "codex" and isinstance(item, dict):
            if item.get("type") in {"command_execution", "file_change", "mcp_tool_call", "web_search", "tool_call"}:
                tool_events.append(event)
            if typ == "item.completed" and item.get("type") == "agent_message":
                answers.append(item.get("text", ""))
        if provider == "codex" and typ == "turn.completed":
            success = True
        if typ in {"turn.failed", "error"}:
            success = False
    if provider == "codex" and not models:
        match = re.search(r"(?im)^model:\s*(\S+)", err)
        if match:
            models.append(match.group(1))
    models = list(dict.fromkeys(models))
    sessions = list(dict.fromkeys(sessions))
    answer = answers[-1] if answers else ""
    (folder / "answer.txt").write_text(answer, encoding="utf-8")
    parse_error = None
    data = None
    extracted_fence = False
    try:
        candidate = answer.strip()
        fence = chr(96) * 3
        if candidate.startswith(fence) and candidate.endswith(fence):
            candidate = candidate[candidate.find("\n") + 1:-3].strip()
            extracted_fence = True
        data = json.loads(candidate)
    except (json.JSONDecodeError, ValueError) as exc:
        parse_error = str(exc)
    structure_errors = validate(data) if data is not None else ["JSON parse failed: " + str(parse_error)]
    if data is not None:
        save(folder / "parsed_response.json", data)
    mismatch = bool(models) and any(not re.search(pattern, x, re.I) and x != model for x in models)
    prompt_echo = len(user_texts) == 1 and user_texts[0] == PROMPT if provider == "cursor" else None
    quota = bool(re.search(r"quota|usage limit|insufficient credits|resource_exhausted|rate.limit|exceeded.{0,35}limit", err + raw, re.I))
    errors = list(structure_errors)
    if execution["timed_out"]:
        errors.append("timeout")
    if execution["exit_code"] != 0:
        errors.append("nonzero exit")
    if not success:
        errors.append("no successful completion event")
    if not sessions:
        errors.append("session ID missing")
    if tool_events:
        errors.append("tool events present")
    if malformed:
        errors.append("malformed stream JSON")
    if mismatch:
        errors.append("returned model mismatch")
    if provider == "cursor" and not models:
        errors.append("Cursor runtime model missing")
    if provider == "cursor" and not prompt_echo:
        errors.append("Cursor prompt echo mismatch")
    if "\ufffd" in raw:
        errors.append("UTF-8 replacement character in stream")
    if hashlib.sha256((folder / "input.txt").read_bytes()).hexdigest() != PROMPT_HASH:
        errors.append("prompt hash mismatch")
    record = {
        **execution, "provider": provider, "requested_model": model,
        "requested_reasoning_effort": "high" if provider == "codex" else "model_id",
        "returned_models": models, "model_identity_status": "verified" if models and not mismatch else "mismatch" if mismatch else "not_reported",
        "session_ids": sessions, "input_sha256": PROMPT_HASH, "prompt_echo_matches": prompt_echo,
        "prompt_transport_note": "Codex stdin adds a terminal newline; no server input echo." if provider == "codex" else "Exact text equality checked against user stream event.",
        "tool_event_count": len(tool_events), "tool_events": tool_events,
        "malformed_stream_line_numbers": malformed, "extracted_markdown_fence": extracted_fence,
        "structure_errors": structure_errors, "quota_or_rate_limit": quota,
        "valid": not errors, "errors": errors, "raw_directory": str(folder.relative_to(ROOT)),
    }
    save(folder / "audit.json", record)
    return record


def run_job(job):
    provider, model, pattern, rep = job
    run_id = f"{provider}__{model}__r{rep}"
    jobdir = ROOT / "raw" / run_id
    jobdir.mkdir(parents=True, exist_ok=True)
    records = []
    with LOCK:
        blocked = (provider, model) in BLOCKED
    if blocked:
        return {"run_id": run_id, "provider": provider, "requested_model": model, "replicate": rep, "valid": False, "status": "skipped_after_limit", "attempts": []}
    for attempt in [1, 2]:
        folder = jobdir / f"attempt_{attempt}"
        if (folder / "audit.json").exists():
            record = json.loads((folder / "audit.json").read_text(encoding="utf-8"))
            if record.get("input_sha256") != PROMPT_HASH:
                raise RuntimeError("Existing attempt input hash differs")
        else:
            folder.mkdir(exist_ok=True)
            if any(folder.iterdir()):
                raise RuntimeError("Refusing to overwrite incomplete attempt: " + str(folder))
            scratch = ROOT / "scratch" / run_id / f"attempt_{attempt}"
            scratch.mkdir(parents=True, exist_ok=True)
            if any(scratch.iterdir()):
                raise RuntimeError("Scratch is not empty")
            (folder / "input.txt").write_bytes(PROMPT_BYTES)
            command = [PWSH, "-NoLogo", "-NoProfile", "-File", str(ROOT / "run_one.ps1"),
                       "-Provider", provider, "-ModelId", model, "-PromptPath", str(folder / "input.txt"),
                       "-WorkspacePath", str(scratch)]
            execution = {"attempt": attempt, "started_at": now(), "timeout_seconds": 180, "timed_out": False, "exit_code": None}
            print(f"START {run_id} attempt {attempt}", flush=True)
            with (folder / "stdout.jsonl").open("wb") as out, (folder / "stderr.txt").open("wb") as err:
                proc = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=out, stderr=err,
                                        creationflags=subprocess.CREATE_NO_WINDOW)
                execution["process_id"] = proc.pid
                save(folder / "execution.json", execution)
                try:
                    execution["exit_code"] = proc.wait(timeout=180)
                except subprocess.TimeoutExpired:
                    execution["timed_out"] = True
                    subprocess.run(["taskkill", "/PID", str(proc.pid), "/T", "/F"], capture_output=True,
                                   creationflags=subprocess.CREATE_NO_WINDOW)
                    execution["exit_code"] = proc.wait(timeout=15)
            execution["ended_at"] = now()
            save(folder / "execution.json", execution)
            record = audit(folder, provider, model, pattern, execution)
            print(f"END {run_id} attempt {attempt} valid={record['valid']} tools={record['tool_event_count']} errors={record['errors'][:3]}", flush=True)
        records.append(record)
        if record["quota_or_rate_limit"]:
            with LOCK:
                BLOCKED.add((provider, model))
        if record["valid"] or record["timed_out"] or record["quota_or_rate_limit"] or record["tool_event_count"] or record["model_identity_status"] == "mismatch":
            break
    accepted = next((x for x in records if x["valid"]), None)
    result = {"run_id": run_id, "provider": provider, "requested_model": model, "replicate": rep,
              "valid": bool(accepted), "status": "valid" if accepted else "failed_or_excluded",
              "accepted_attempt": accepted["attempt"] if accepted else None, "attempts": records}
    save(jobdir / "run.json", result)
    return result


def write_outputs(results, finished=False):
    ordered = sorted(results, key=lambda r: (r["replicate"], [x[1] for x in MODELS].index(r["requested_model"])))
    valid = [r for r in ordered if r["valid"]]
    attempts = [a for r in ordered for a in r["attempts"]]
    compiled = []
    for row in valid:
        audit_row = next(a for a in row["attempts"] if a["valid"])
        data = json.loads((ROOT / audit_row["raw_directory"] / "parsed_response.json").read_text(encoding="utf-8"))
        compiled.append({"run_id": row["run_id"], "provider": row["provider"], "requested_model": row["requested_model"],
                         "returned_models": audit_row["returned_models"], "model_identity_status": audit_row["model_identity_status"],
                         "replicate": row["replicate"], "session_ids": audit_row["session_ids"],
                         "input_sha256": PROMPT_HASH, "raw_directory": audit_row["raw_directory"], "response": data})
    sessions = [sid for a in attempts for sid in a["session_ids"]]
    manifest = {
        "study": "2026-10-20 frozen-description assistant concept walkthrough",
        "source_type": "model_simulation", "new_human_participants": 0,
        "exposure": "description_only", "input_sha256": PROMPT_HASH,
        "started_at": STARTED, "updated_at": now(), "finished": finished,
        "planned_runs": 27, "completed_logical_runs": len(results), "valid_runs": len(valid),
        "failed_or_excluded_runs": len(results) - len(valid), "pending_runs": 27 - len(results),
        "total_attempts": len(attempts), "tool_policy_excluded_attempts": sum(bool(a["tool_event_count"]) for a in attempts),
        "valid_runtime_identity_not_reported": sum(r["model_identity_status"] == "not_reported" for r in compiled),
        "unique_session_ids": len(set(sessions)), "session_ids_unique_across_attempts": len(sessions) == len(set(sessions)),
        "max_concurrency": 2, "timeout_seconds": 180, "maximum_retries": 1,
        "scope": "27 Cursor runs; parent agent separately runs and audits three native Codex sessions",
        "limitations": [
            "Models reviewed a frozen textual description, not the live product, audio, screenshots or actual model responses.",
            "Three replicates per version do not establish population prevalence, real-user usability, reliability or independent model-family votes.",
            "No ratings or simulated feedback are written to the product feedback store.",
            "Native Codex runtime model identity remains unverified if its event stream does not echo a model; requested ID is recorded separately.",
            "Timeouts and tool/model policy exclusions are retained without retry; other failures permit one retry."
        ],
        "models": [{"provider": p, "requested_model": m, "replicates": 3} for p, m, _ in MODELS],
        "runs": ordered,
    }
    save(ROOT / "manifest.json", manifest)
    save(ROOT / "compiled_responses.json", {"input_sha256": PROMPT_HASH, "source_type": "model_simulation",
                                         "new_human_participants": 0, "count": len(compiled), "responses": compiled})


if __name__ == "__main__":
    jobs = [(p, m, pat, rep) for rep in [1, 2, 3] for p, m, pat in MODELS]
    results = []
    write_outputs(results)
    with cf.ThreadPoolExecutor(max_workers=2) as pool:
        futures = {pool.submit(run_job, job): job for job in jobs}
        for future in cf.as_completed(futures):
            job = futures[future]
            try:
                results.append(future.result())
            except Exception as exc:
                p, m, _, rep = job
                results.append({"run_id": f"{p}__{m}__r{rep}", "provider": p, "requested_model": m, "replicate": rep,
                                "valid": False, "status": "runner_error", "error": repr(exc), "attempts": []})
            write_outputs(results)
            print(f"PROGRESS completed={len(results)}/27 valid={sum(r['valid'] for r in results)}", flush=True)
    write_outputs(results, finished=True)
    print("FINISHED", flush=True)
