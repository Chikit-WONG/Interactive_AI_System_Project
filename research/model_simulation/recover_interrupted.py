"""Preserve orphaned attempt files and label their missing process completion.

Run only after the controller and its child processes have been checked absent.
No raw output or input is replaced. A terminal model response may be present,
but the unobserved process exit remains null, never invented as success.
"""
import json
from datetime import datetime, timezone, timedelta
from run_simulation import HERE, make_jobs, audit_attempt, write_json, now, digest

jobs = {job['run_id']: job for job in make_jobs()}
recovered = []
for directory in (HERE / 'raw').glob('*/*'):
    if not directory.is_dir() or (directory / 'audit.json').exists() or not (directory / 'input.txt').exists():
        continue
    job = jobs[directory.parent.name]
    number = int(directory.name.split('_')[-1])
    start = datetime.fromtimestamp((directory / 'input.txt').stat().st_mtime, timezone(timedelta(hours=8))).isoformat()
    raw = directory / 'stdout.jsonl'
    execution = {
        'attempt': number, 'started_at': start, 'started_at_source': 'input_file_mtime_approximation',
        'finished_at': None, 'controller_loss_observed_at': now(), 'duration_seconds': None,
        'exit_code': None, 'timed_out': False, 'timeout_seconds': 240,
        'interrupted': True, 'exception': 'Controller disappeared before execution metadata was written; processes verified absent. Raw evidence preserved.',
        'last_raw_write_at': datetime.fromtimestamp(raw.stat().st_mtime, timezone(timedelta(hours=8))).isoformat(),
        'cli_mode': 'ask', 'output_format': 'stream-json', 'used_resume': False,
        'fresh_session_requested': True, 'proxy_mode': 'process_scope_HTTP_PROXY_only',
        'proxy_url': 'http://127.0.0.1:7897', 'global_config_changed': False,
        'prompt_source_path': 'prompts/' + job['scenario'] + '.txt', 'prompt_sha256': digest(directory / 'input.txt'),
    }
    write_json(directory / 'execution.json', execution)
    record = audit_attempt(directory, job, execution)
    recovered.append({'run_id': job['run_id'], 'attempt': number, 'status': record['status'], 'answer_received': record['answer_received'], 'errors': record['errors']})
write_json(HERE / 'controller_interruption_recovery.json', {'recorded_at': now(), 'raw_files_modified': False, 'recovered_attempts': recovered})
print(json.dumps(recovered, ensure_ascii=False, indent=2))
