"""Merge Cursor and parent-recorded Codex runs, keeping attempts distinct."""
import hashlib
import json
import runpy
import sys
from collections import Counter
from pathlib import Path

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parent
validate = runpy.run_path(str(ROOT / "run_reviews.py"))["validate"]


def read(path):
    return json.loads(path.read_text(encoding="utf-8"))


cursor = read(ROOT / "manifest.json")
compiled = read(ROOT / "compiled_responses.json")
codex = read(ROOT / "codex_manifest.json")
prompt_hash = hashlib.sha256((ROOT / "frozen_prompt.txt").read_bytes()).hexdigest()
assert cursor["input_sha256"] == compiled["input_sha256"] == codex["prompt_sha256"] == prompt_hash
responses = list(compiled["responses"])
logical_runs = list(cursor["runs"])
codex_reaudit = []
for repeat in [1, 2, 3]:
    attempts = [a for a in codex["runs"] if a["repeat"] == repeat]
    accepted = []
    for meta in attempts:
        assert meta["prompt_sha256"] == prompt_hash
        if meta["accepted"]:
            response = read(ROOT / meta["raw_directory"] / "response.json")
            errors = validate(response)
            if meta["tool_event_count"]:
                errors.append("Tool events present")
            if not meta["session_id"]:
                errors.append("Session ID missing")
            if meta["exit_code"] or meta["timed_out"]:
                errors.append("Failed or timed-out process")
            codex_reaudit.append({"run_id": meta["run_id"], "independent_structure_errors": errors})
            if not errors:
                accepted.append((meta, response))
    assert len(accepted) <= 1
    logical_id = f"codex-gpt-5.6-sol__r{repeat}"
    logical_runs.append({
        "run_id": logical_id, "provider": "codex", "requested_model": "gpt-5.6-sol",
        "replicate": repeat, "valid": bool(accepted), "attempts": attempts,
        "status": "valid" if accepted else "failed_or_excluded",
    })
    if accepted:
        meta, response = accepted[0]
        responses.append({
            "run_id": logical_id, "provider": "codex", "requested_model": "gpt-5.6-sol",
            "requested_reasoning_effort": "high", "returned_models": [],
            "model_identity_status": "not_reported", "replicate": repeat,
            "session_ids": [meta["session_id"]], "input_sha256": prompt_hash,
            "raw_directory": meta["raw_directory"], "response": response,
        })
for response in responses:
    assert response["input_sha256"] == prompt_hash
    assert not validate(response["response"])
session_ids = [sid for row in responses for sid in row["session_ids"]]
assert len(session_ids) == len(set(session_ids))
by_model = []
for provider, model in dict.fromkeys((r["provider"], r["requested_model"]) for r in logical_runs):
    runs = [r for r in logical_runs if r["provider"] == provider and r["requested_model"] == model]
    by_model.append({
        "provider": provider, "requested_model": model, "planned": 3,
        "completed_logical_runs": len(runs), "valid_runs": sum(r["valid"] for r in runs),
        "failed_or_excluded_runs": sum(not r["valid"] for r in runs),
        "attempts": sum(len(r["attempts"]) for r in runs),
    })
merged = {
    "source_type": "model_simulation", "exposure": "description_only", "new_human_participants": 0,
    "input_sha256": prompt_hash, "planned_logical_runs": 30,
    "completed_logical_runs": len(logical_runs),
    "valid_runs": len(responses),
    "failed_or_excluded_logical_runs": sum(not r["valid"] for r in logical_runs),
    "pending_logical_runs": 30 - len(logical_runs),
    "total_attempts": sum(len(r["attempts"]) for r in logical_runs),
    "valid_runtime_model_not_reported": sum(r["model_identity_status"] == "not_reported" for r in responses),
    "unique_valid_session_ids": len(set(session_ids)),
    "tool_event_count_in_valid_responses": 0,
    "finalized": bool(cursor["finished"] and codex["finalized"]),
    "by_model": by_model, "codex_independent_reaudit": codex_reaudit,
    "limitations": cursor["limitations"] + [
        "Codex first attempts failed during local configuration parsing before a model session. They remain attempts, not additional logical runs.",
        "All results preserve their original source_type. Valid schema is not a guarantee that a suggestion is correct or desirable.",
        "Models received the same user prompt text but provider system instructions and service internals are not controlled."
    ],
    "responses": responses, "logical_runs": logical_runs,
}
(ROOT / "all_reviews.json").write_text(json.dumps(merged, ensure_ascii=False, indent=2), encoding="utf-8")
all_attempts = [a for run in logical_runs for a in run["attempts"]]
all_sessions = [
    sid for attempt in all_attempts
    for sid in (attempt.get("session_ids") or ([attempt["session_id"]] if attempt.get("session_id") else []))
]
input_hashes = []
failures = []
for attempt in all_attempts:
    path = ROOT / attempt["raw_directory"] / "input.txt"
    input_hashes.append({"path": str(path.relative_to(ROOT)),
                         "sha256": hashlib.sha256(path.read_bytes()).hexdigest() if path.exists() else None})
    accepted = attempt.get("valid", attempt.get("accepted", False))
    if not accepted:
        stderr_path = ROOT / attempt["raw_directory"] / "stderr.txt"
        stderr = stderr_path.read_text(encoding="utf-8", errors="replace") if stderr_path.exists() else ""
        cause = "CLI 配置解析失败：windows.sandbox=mxc 不被此 CLI 接受；尚未创建模型会话。" if "unknown variant `mxc`" in stderr else "模型输出 JSON 语法或字段结构不符合固定 schema。"
        failures.append({"raw_directory": attempt["raw_directory"],
                         "cause_zh": cause,
                         "errors": attempt.get("errors", attempt.get("validation_errors", [])),
                         "timed_out": attempt["timed_out"], "exit_code": attempt["exit_code"],
                         "session_ids": attempt.get("session_ids", [attempt.get("session_id")])})
quality = {
    "finalized": merged["finalized"],
    "planned_logical_runs": 30, "completed_logical_runs": len(logical_runs),
    "valid_logical_runs": len(responses), "failed_logical_runs": merged["failed_or_excluded_logical_runs"],
    "attempt_count": len(all_attempts), "failed_attempt_count": len(failures),
    "unique_all_reported_session_ids": len(set(all_sessions)),
    "duplicate_all_reported_session_ids": len(all_sessions) - len(set(all_sessions)),
    "attempts_without_session": sum(not a.get("session_ids") and not a.get("session_id") for a in all_attempts),
    "unique_valid_session_ids": len(set(session_ids)),
    "total_tool_events_all_attempts": sum(a["tool_event_count"] for a in all_attempts),
    "input_sha256": prompt_hash,
    "all_saved_input_files_match": all(x["sha256"] == prompt_hash for x in input_hashes),
    "saved_input_files_checked": len(input_hashes),
    "input_hash_audit": input_hashes, "failures": failures,
    "by_model": by_model,
    "runtime_model_identity_unreported_for_valid_runs": merged["valid_runtime_model_not_reported"],
    "new_human_participants": 0,
}
assert quality["all_saved_input_files_match"]
assert quality["duplicate_all_reported_session_ids"] == 0
(ROOT / "run_quality_summary.json").write_text(json.dumps(quality, ensure_ascii=False, indent=2), encoding="utf-8")
lines = [
    "2026-10-20 模型文字走查：运行质量摘要",
    "来源为 model_simulation，新增真人参与者 0；仅评价固定文字说明，没有实际试用产品。",
    f"逻辑运行：计划 30，完成 {len(logical_runs)}，有效 {len(responses)}，最终失败 {merged['failed_or_excluded_logical_runs']}。",
    f"总尝试 {len(all_attempts)}；失败尝试 {len(failures)}（包含重试前的失败，不另计逻辑运行）。",
    f"有效会话 {len(set(session_ids))} 个；全部已报告会话 {len(set(all_sessions))} 个，无重复；未产生会话的尝试 {quality['attempts_without_session']} 个。",
    f"全部尝试的工具事件合计 {quality['total_tool_events_all_attempts']}。",
    f"逐文件核对 {len(input_hashes)} 个 input.txt，SHA256 全部一致：{prompt_hash}",
    "Cursor 返回的模型标签已核对；Codex 的 3 条有效输出没有返回模型标识，requested gpt-5.6-sol high 与 returned null 分别保留。",
    "",
    "各版本有效重复数（分母均为 3）：",
]
lines += [f"{r['provider']} / {r['requested_model']}: {r['valid_runs']}/3；尝试 {r['attempts']}" for r in by_model]
lines += ["", "失败尝试明细："]
lines += [f"{r['raw_directory']}: {r['cause_zh']} {'; '.join(r['errors'])}" for r in failures]
lines += ["", "通过结构检查只表示答复可解析且符合来源约束，不表示建议正确；三次重复不足以证明稳定性或真实用户效果。"]
(ROOT / "run_quality_summary.txt").write_text("\n".join(lines) + "\n", encoding="utf-8")
print(json.dumps({k: merged[k] for k in ["planned_logical_runs", "completed_logical_runs", "valid_runs",
                                       "failed_or_excluded_logical_runs", "total_attempts", "finalized"]}))
