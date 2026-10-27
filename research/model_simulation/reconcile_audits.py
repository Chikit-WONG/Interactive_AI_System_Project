"""Reaudit preserved model outputs; never calls a model or alters raw evidence."""
import json
from pathlib import Path
from run_simulation import HERE, audit_attempt, make_jobs, refresh_manifest, write_json


def main():
    jobs = make_jobs()
    reconciled = []
    changes = []
    for job in jobs:
        attempts = []
        for number in (1, 2):
            directory = HERE / 'raw' / job['run_id'] / f'attempt_{number}'
            if not (directory / 'execution.json').exists():
                continue
            old = json.loads((directory / 'audit.json').read_text(encoding='utf-8')) if (directory / 'audit.json').exists() else {}
            if old and not (directory / 'audit_initial.json').exists():
                write_json(directory / 'audit_initial.json', old)
            execution = json.loads((directory / 'execution.json').read_text(encoding='utf-8'))
            new = audit_attempt(directory, job, execution)
            attempts.append(new)
            if old.get('status') != new['status'] or old.get('errors') != new['errors']:
                changes.append({'run_id': job['run_id'], 'attempt': number, 'previous_status': old.get('status'), 'current_status': new['status'], 'previous_errors': old.get('errors'), 'current_errors': new['errors']})
        if attempts:
            reconciled.append({**job, 'attempts': attempts, 'accepted_attempt': next((a['attempt'] for a in attempts if a['status'] == 'completed_valid_simulation'), None)})
    manifest = refresh_manifest(jobs, reconciled, 3, 240)
    write_json(HERE / 'reaudit_changes.json', {'changes': changes, 'source_preserved': True, 'raw_inputs_and_outputs_modified': False, 'note': 'Original audit retained as audit_initial.json. Semantic scenario contradictions and defensive malformed-value handling were strengthened; frozen inputs unchanged.'})
    print(json.dumps({'completed': manifest['completed_logical_runs'], 'valid': manifest['valid_simulations'], 'changes': changes}, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
