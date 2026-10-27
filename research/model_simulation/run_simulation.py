"""Run the authorized, frozen questionnaire simulations through the official CLI.

Only the runner's own child process trees may be terminated. Raw bytes and every
failed attempt are retained. Re-running this script resumes the local job ledger,
never a model conversation. No global configuration or authentication is read.
"""
import argparse
import concurrent.futures
import hashlib
import json
import os
import re
import subprocess
import threading
import time
from collections import Counter
from datetime import datetime, timedelta, timezone
from pathlib import Path

from validate_response import validate_response

HERE = Path(__file__).resolve().parent
PWSH = Path(r'C:\Program Files\PowerShell\7\pwsh.exe')
CLI = Path(r'C:\Users\chikitwong\AppData\Local\cursor-agent\agent.ps1')
MODELS = [
    ('claude-opus-5-5-high', r'Claude Opus 5\.5.*High'),
    ('claude-sonnet-5-5-high', r'Claude Sonnet 5\.5.*High'),
    ('gemini-4-argon-high', r'Gemini 4 Argon.*High'),
    ('gemini-3.1-pro', r'Gemini 3\.1 Pro'),
    ('grok-4.7-high', r'Grok 4\.7.*High'),
    ('composer-2.5', r'Composer 2\.5'),
    ('kimi-k3-high', r'Kimi K3'),
    ('glm-5.2-high', r'GLM 5\.2'),
    ('gpt-5.6-sol-high', r'GPT.5\.6 Sol.*High'),
    ('muse-spark-1.3-high', r'Muse Spark 1\.3'),
]
CORE = ['claude-opus-5-5-high', 'gemini-4-argon-high', 'grok-4.7-high']
PRINT_LOCK = threading.Lock()


def now():
    return datetime.now(timezone(timedelta(hours=8))).isoformat()


def write_json(path, obj):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + '.tmp')
    temporary.write_text(json.dumps(obj, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    temporary.replace(path)


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def rel(path):
    return str(path.relative_to(HERE)).replace('\\', '/')


def announce(message):
    with PRINT_LOCK:
        print(f'{now()} {message}', flush=True)


def audit_attempt(directory, job, execution):
    raw = (directory / 'stdout.jsonl').read_bytes()
    errors = []
    try:
        text = raw.decode('utf-8-sig', errors='strict')
    except UnicodeDecodeError as exc:
        text = raw.decode('utf-8-sig', errors='replace')
        errors.append(f'non_utf8_stdout:{exc}')
    events = []
    malformed = []
    for number, line in enumerate(text.splitlines(), 1):
        if not line.strip():
            continue
        try:
            events.append(json.loads(line))
        except json.JSONDecodeError:
            malformed.append(number)
    init = next((e for e in events if e.get('type') == 'system' and e.get('subtype') == 'init'), {})
    result = next((e for e in reversed(events) if e.get('type') == 'result'), {})
    users = [e for e in events if e.get('type') == 'user']
    user_text = ''.join(c.get('text', '') for c in (users[0] if users else {}).get('message', {}).get('content', []) if c.get('type') == 'text')
    prompt = (directory / 'input.txt').read_bytes().decode('utf-8-sig')
    tool_events = [e for e in events if 'tool' in e.get('type', '').lower() or any('tool' in c.get('type', '').lower() for c in e.get('message', {}).get('content', []) if isinstance(c, dict))]
    answer_text = result.get('result', '')
    if not isinstance(answer_text, str):
        answer_text = json.dumps(answer_text, ensure_ascii=False)
    assistant_text = '\n'.join(c.get('text', '') for e in events if e.get('type') == 'assistant' for c in e.get('message', {}).get('content', []) if isinstance(c, dict) and c.get('type') == 'text')
    if assistant_text and not answer_text:
        (directory / 'partial_assistant_text.txt').write_text(assistant_text, encoding='utf-8')
    received_text = answer_text or assistant_text
    received_question_ids = sorted(set(re.findall(r'\b(?:NEW_Q(?:[1-9]|1[0-9]|2[0-7])|OLD_Q(?:[1-9]|1[0-4])|NEW_M[1-7])\b', received_text)))
    answer_path = directory / 'answer.txt'
    derived_answer_comparison = 'exact'
    if not answer_path.exists():
        answer_path.write_bytes(answer_text.encode('utf-8'))
    else:
        prior_answer_text = answer_path.read_bytes().decode('utf-8-sig')
        if prior_answer_text == answer_text:
            pass
        elif prior_answer_text == answer_text.replace('\n', '\r\n'):
            # Earlier Path.write_text calls used Windows newline translation.
            # The authoritative stdout JSON still retains the exact model text.
            derived_answer_comparison = 'Windows_LF_to_CRLF_translation_only'
        else:
            derived_answer_comparison = 'mismatch'
            errors.append('previous_derived_answer_differs_from_raw_result')
    answer = None
    serialization_recovery = None
    strict_json_valid = False
    try:
        answer = json.loads(answer_text.strip())
        strict_json_valid = True
    except (json.JSONDecodeError, TypeError) as exc:
        # Extract one complete JSON code block without editing its contents.
        # Never join fragments, fix commas, rewrite quotes, or impute answers.
        blocks = re.findall(r'```(?:json)?[ \t]*\r?\n([\s\S]*?)```', answer_text)
        if not blocks:
            whole_fence = re.fullmatch(r'```(?:json)?\s*([\s\S]*?)\s*```', answer_text.strip())
            if whole_fence:
                blocks = [whole_fence.group(1)]
        if len(blocks) == 1:
            try:
                answer = json.loads(blocks[0].strip())
                serialization_recovery = 'single_complete_fenced_JSON_block_extracted_without_content_changes'
            except (json.JSONDecodeError, TypeError):
                pass
        if answer is None:
            errors.append(f'invalid_answer_json:{exc}')
    try:
        validation = validate_response(answer, job['scenario']) if isinstance(answer, dict) else {'valid': False, 'errors': ['answer_not_object']}
    except Exception as exc:
        validation = {'valid': False, 'errors': ['validator_exception:' + repr(exc)]}
    if answer is not None:
        response_path = directory / 'response.json'
        if not response_path.exists():
            write_json(response_path, answer)
        elif json.loads(response_path.read_text(encoding='utf-8-sig')) != answer:
            errors.append('previous_derived_response_differs_from_reparsed_raw')
    errors.extend(validation.get('errors', []))
    model_pattern = dict(MODELS)[job['model_id']]
    model_match = bool(re.search(model_pattern, init.get('model', ''), re.IGNORECASE))
    conditions = {
        'exit_code_zero': execution.get('exit_code') == 0,
        'not_timed_out': not execution.get('timed_out'),
        'successful_result': result.get('subtype') == 'success' and not result.get('is_error'),
        'single_user_message': len(users) == 1,
        'prompt_exact_match': user_text == prompt,
        'nominal_model_match': model_match,
        'session_id_present': bool(init.get('session_id')),
        'zero_tool_events': not tool_events,
        'zero_malformed_event_lines': not malformed,
        'zero_replacement_characters': '\ufffd' not in text,
        'response_validation_passed': validation['valid'],
    }
    errors.extend(k for k, v in conditions.items() if not v)
    eligible = all(conditions.values()) and not errors
    stderr_text = (directory / 'stderr.txt').read_bytes().decode('utf-8-sig', errors='replace')
    # Error diagnostics only; never log inherited environment values.
    stderr_excerpt = re.sub(r'(?i)(authorization\s*:\s*bearer|api[_ -]?key\s*[:=])\s*\S+', r'\1 [REDACTED]', stderr_text[:1600])
    if eligible:
        failure_class = None
    elif execution.get('interrupted'):
        failure_class = 'controller_interruption_exit_unobserved'
    elif execution.get('timed_out'):
        failure_class = 'attempt_timeout'
    elif re.search(r'network|TLS|socket|ECONN|connection|aborted', stderr_text, re.IGNORECASE):
        failure_class = 'network_error'
    elif 'Cannot use this model' in stderr_text:
        failure_class = 'availability_or_catalog_error_not_proof_of_model_absence'
    elif answer_text and answer is None:
        failure_class = 'answer_serialization_invalid'
    elif answer is not None and not validation.get('schema_valid'):
        failure_class = 'answer_schema_invalid'
    elif answer is not None and validation.get('errors'):
        failure_class = 'answer_semantics_or_assumption_reference_invalid'
    else:
        failure_class = 'execution_or_audit_failure'
    record = {
        **execution, 'run_id': job['run_id'], 'model_id': job['model_id'],
        'scenario': job['scenario'], 'replicate': job['replicate'], 'purpose': job['purpose'],
        'source_type': 'model_simulation', 'fictional_persona': True,
        'reported_model': init.get('model'), 'session_id': init.get('session_id'),
        'conditions': conditions, 'tool_event_count': len(tool_events),
        'malformed_event_line_numbers': malformed, 'replacement_character_count': text.count('\ufffd'),
        'prompt_sha256': digest(directory / 'input.txt'), 'stdout_sha256': digest(directory / 'stdout.jsonl'),
        'answer_characters': len(answer_text), 'usage': result.get('usage'),
        'validation': validation, 'errors': errors,
        'validator_sha256': digest(HERE / 'validate_response.py'),
        'answer_received': bool(received_text.strip()) and len(received_question_ids) >= 3 and len(re.findall(r'"answer"\s*:', received_text)) >= 3,
        'answer_received_definition': 'A final or partial assistant text containing at least three distinct questionnaire IDs and three answer fields; this indicates attempted structured filling, not validity or completeness. Pure prose refusals or mentions do not qualify.',
        'final_result_text_received': bool(answer_text.strip()),
        'received_question_ids_in_text': received_question_ids,
        'received_text_characters': len(received_text),
        'derived_answer_comparison': derived_answer_comparison,
        'schema_valid': bool(validation.get('schema_valid', False)),
        'analysis_eligible': eligible,
        'failure_class': failure_class, 'stderr_excerpt': stderr_excerpt,
        'status': 'completed_valid_simulation' if eligible else 'failed_validation_or_execution',
        'raw_directory': rel(directory),
        'json_fence_removed_for_parsing': serialization_recovery is not None,
        'strict_json_valid': strict_json_valid,
        'serialization_recovery': serialization_recovery,
        'retry_is_independent_sample': False,
    }
    write_json(directory / 'audit.json', record)
    return record


def run_attempt(job, number, timeout):
    directory = HERE / 'raw' / job['run_id'] / f'attempt_{number}'
    directory.mkdir(parents=True, exist_ok=True)
    prompt_path = HERE / 'prompts' / f"{job['scenario']}.txt"
    frozen_bytes = prompt_path.read_bytes()
    input_path = directory / 'input.txt'
    input_path.write_bytes(frozen_bytes)
    workspace = HERE / 'neutral_workspaces' / job['run_id'] / f'attempt_{number}'
    workspace.mkdir(parents=True, exist_ok=True)
    if any(workspace.iterdir()):
        raise RuntimeError(f'Workspace must be empty before invocation: {workspace}')
    args = [str(PWSH), '-NoLogo', '-NoProfile', '-File', str(HERE / 'run_one.ps1'), '-ModelId', job['model_id'], '-PromptPath', str(input_path), '-WorkspacePath', str(workspace)]
    env = os.environ.copy()
    env['HTTP_PROXY'] = 'http://127.0.0.1:7897'
    env.pop('HTTPS_PROXY', None)
    env.pop('ALL_PROXY', None)
    env['PYTHONIOENCODING'] = 'utf-8'
    started = now()
    clock_start = time.monotonic()
    timed_out = False
    exit_code = None
    process_id = None
    exception = None
    announce(f"START {job['run_id']} attempt={number}")
    with (directory / 'stdout.jsonl').open('wb') as stdout, (directory / 'stderr.txt').open('wb') as stderr:
        try:
            process = subprocess.Popen(args, cwd=str(workspace), env=env, stdin=subprocess.DEVNULL, stdout=stdout, stderr=stderr, creationflags=subprocess.CREATE_NO_WINDOW)
            process_id = process.pid
            try:
                exit_code = process.wait(timeout=timeout)
            except subprocess.TimeoutExpired:
                timed_out = True
                # Only the PID created immediately above, and its owned children.
                subprocess.run(['taskkill', '/PID', str(process.pid), '/T', '/F'], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, creationflags=subprocess.CREATE_NO_WINDOW, timeout=20, check=False)
                try:
                    exit_code = process.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    process.kill()
                    exit_code = process.wait(timeout=10)
        except Exception as exc:
            exception = repr(exc)
            stderr.write((exception + '\n').encode('utf-8'))
    execution = {
        'attempt': number, 'started_at': started, 'finished_at': now(),
        'duration_seconds': round(time.monotonic() - clock_start, 3),
        'exit_code': exit_code, 'timed_out': timed_out, 'timeout_seconds': timeout,
        'exception': exception, 'owned_process_id': process_id,
        'cli_path': str(CLI), 'command_arguments': args,
        'cli_mode': 'ask', 'output_format': 'stream-json', 'used_resume': False,
        'fresh_session_requested': True, 'fresh_empty_workspace': str(workspace),
        'tool_restriction': 'Prompt prohibits all tools; ask mode is read-only; tool events audited. No hard tools-disable flag is exposed by this CLI.',
        'proxy_mode': 'process_scope_HTTP_PROXY_only', 'proxy_url': 'http://127.0.0.1:7897',
        'global_config_changed': False, 'temperature_and_seed': 'CLI does not expose controls; provider defaults are unknown',
        'prompt_source_path': rel(prompt_path), 'prompt_sha256': hashlib.sha256(frozen_bytes).hexdigest(),
    }
    write_json(directory / 'execution.json', execution)
    audit = audit_attempt(directory, job, execution)
    announce(f"END {job['run_id']} attempt={number} status={audit['status']} seconds={execution['duration_seconds']} errors={len(audit['errors'])}")
    return audit


def run_job(job, timeout, retry):
    attempts = []
    for number in range(1, 2 + int(retry)):
        existing = HERE / 'raw' / job['run_id'] / f'attempt_{number}' / 'audit.json'
        if existing.exists():
            record = json.loads(existing.read_text(encoding='utf-8'))
            if record['prompt_sha256'] != digest(HERE / 'prompts' / f"{job['scenario']}.txt"):
                raise RuntimeError('Frozen prompt changed after an existing run; create a new study version.')
            announce(f"REUSE AUDIT {job['run_id']} attempt={number} status={record['status']}")
        else:
            record = run_attempt(job, number, timeout)
        attempts.append(record)
        if record['status'] == 'completed_valid_simulation':
            break
        # Never auto-retry a tool-policy or unexpected-model violation.
        if record['tool_event_count'] or (record['reported_model'] and not record['conditions']['nominal_model_match']):
            break
    return {**job, 'attempts': attempts, 'accepted_attempt': next((r['attempt'] for r in attempts if r['status'] == 'completed_valid_simulation'), None)}


def make_jobs():
    jobs = []
    for replicate in range(1, 4):
        for model, _ in MODELS:
            jobs.append({'run_id': f'{model}__S1__r{replicate}', 'model_id': model, 'scenario': 'S1', 'replicate': replicate, 'purpose': 'fixed_input_repetition'})
    for scenario in ('S2', 'S3'):
        for model in CORE:
            jobs.append({'run_id': f'{model}__{scenario}__r1', 'model_id': model, 'scenario': scenario, 'replicate': 1, 'purpose': 'counterexample_exploration'})
    return jobs


def refresh_manifest(jobs, records, concurrency, timeout):
    ordered = sorted(records, key=lambda r: [j['run_id'] for j in jobs].index(r['run_id']))
    accepted = [next(a for a in r['attempts'] if a['attempt'] == r['accepted_attempt']) for r in ordered if r['accepted_attempt']]
    session_counts = Counter(a['session_id'] for a in accepted)
    duplicates = [s for s, n in session_counts.items() if n > 1]
    all_session_counts = Counter(a['session_id'] for r in ordered for a in r['attempts'] if a.get('session_id'))
    responses = []
    for record in accepted:
        response = json.loads((HERE / record['raw_directory'] / 'response.json').read_text(encoding='utf-8'))
        responses.append({'run_id': record['run_id'], 'requested_model': record['model_id'], 'reported_model': record['reported_model'], 'session_id': record['session_id'], 'scenario': record['scenario'], 'replicate': record['replicate'], 'purpose': record['purpose'], 'accepted_attempt': record['attempt'], 'prompt_sha256': record['prompt_sha256'], 'source_type': 'model_simulation', 'fictional_persona': True, 'response': response})
    (HERE / 'responses.jsonl').write_text(''.join(json.dumps(r, ensure_ascii=False) + '\n' for r in responses), encoding='utf-8')
    manifest = {
        'compiled_at': now(), 'source_type': 'model_simulation', 'human_participant_count': 0,
        'finalized': len(ordered) == len(jobs) and all('analysis_eligible' in a and 'failure_class' in a for r in ordered for a in r['attempts']),
        'finalization_note': 'Final analysis requires every planned logical run audited and the unified post-batch audit metadata present. During execution, interim counts are provisional.',
        'interpretation': 'Synthetic scenario-conditioned questionnaire completions. Counts and agreement describe generated answers only; not user prevalence, participant independence, or real-world validation.',
        'design': '10 model versions x same S1 prompt x 3 fresh sessions = 30. Core Claude/Gemini/Grok x S2 and S3 once = 6 counterexample runs. No conversation resumes.',
        'planned_runs': len(jobs), 'completed_logical_runs': len(ordered), 'valid_simulations': len(accepted),
        'failed_logical_runs': sum(r['accepted_attempt'] is None for r in ordered),
        'total_attempts': sum(len(r['attempts']) for r in ordered),
        'attempts_with_substantive_answer_received': sum(bool(a.get('answer_received')) for r in ordered for a in r['attempts']),
        'logical_runs_with_substantive_answer_received': sum(any(a.get('answer_received') for a in r['attempts']) for r in ordered),
        'schema_valid_attempts': sum(bool(a.get('schema_valid')) for r in ordered for a in r['attempts']),
        'logical_runs_with_schema_valid_answer': sum(any(a.get('schema_valid') for a in r['attempts']) for r in ordered),
        'all_reported_session_ids_unique': all(n == 1 for n in all_session_counts.values()),
        'attempts_with_reported_session_id': sum(all_session_counts.values()),
        'session_ids_unique': not duplicates, 'duplicate_session_ids': duplicates,
        'main_models': [m for m, _ in MODELS], 'supplement_models': CORE,
        'max_concurrency': concurrency, 'attempt_timeout_seconds': timeout, 'max_retries_per_run': 1,
        'retry_note': 'At most one retry of identical frozen input after execution/format failure. Every attempt retained; accepted retry represents the same logical run, not an additional sample.',
        'cli_path': str(CLI), 'proxy_mode': 'HTTP_PROXY only, process scope',
        'hard_tool_disable_available': False, 'tool_policy': 'No tools requested in frozen prompt; post-run event count must be zero.',
        'temperature_seed_controls': 'Not exposed by official CLI; defaults unknown.',
        'freeze_hashes': {rel(p): digest(p) for p in sorted((HERE / 'prompts').glob('S?.txt')) + sorted((HERE / 'instruments').glob('*.json'))},
        'runs': ordered,
    }
    write_json(HERE / 'manifest.json', manifest)
    return manifest


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--concurrency', type=int, default=3, choices=[1, 2, 3])
    parser.add_argument('--timeout', type=int, default=240)
    parser.add_argument('--no-retry', action='store_true')
    parser.add_argument('--limit', type=int)
    args = parser.parse_args()
    for filename in ('S1.txt', 'S2.txt', 'S3.txt'):
        path = HERE / 'prompts' / filename
        content = path.read_bytes().decode('utf-8-sig')
        if len(content) > 28000:
            raise RuntimeError(f'Prompt too long for safe Windows argument transport: {filename}, {len(content)} chars')
    for filename in ('response.schema.json', 'question_contracts.json', 'skip_rules.json'):
        json.loads((HERE / 'instruments' / filename).read_text(encoding='utf-8-sig'))
    jobs = make_jobs()
    if args.limit:
        jobs = jobs[:args.limit]
    records = []
    refresh_manifest(jobs, records, args.concurrency, args.timeout)
    with concurrent.futures.ThreadPoolExecutor(max_workers=args.concurrency) as executor:
        futures = {executor.submit(run_job, job, args.timeout, not args.no_retry): job for job in jobs}
        for future in concurrent.futures.as_completed(futures):
            records.append(future.result())
            manifest = refresh_manifest(jobs, records, args.concurrency, args.timeout)
            announce(f"PROGRESS completed={manifest['completed_logical_runs']}/{len(jobs)} valid={manifest['valid_simulations']} attempts={manifest['total_attempts']}")
    announce('BATCH FINISHED')


if __name__ == '__main__':
    main()
