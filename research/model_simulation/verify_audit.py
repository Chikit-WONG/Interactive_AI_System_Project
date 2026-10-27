"""Concrete fault-injection checks against a real completion, in memory only."""
import copy
import json
from pathlib import Path
from validate_response import validate_response

HERE = Path(__file__).resolve().parent


def main():
    source = HERE / 'raw/claude-opus-5-5-high__S1__r1/attempt_1/response.json'
    base = json.loads(source.read_text(encoding='utf-8'))
    results = []
    reference = validate_response(base, 'S1')
    results.append({'case': 'unmodified_completed_response', 'expected_valid': True, 'actual_valid': reference['valid'], 'passed': reference['valid']})
    cases = {
        'missing_NEW_Q9b': lambda q: q['NEW_Q9']['answer'].pop('Q9b'),
        'missing_OLD_Q5_matrix_row': lambda q: q['OLD_Q5']['answer'].pop('r8'),
        'required_skip_disobeyed': lambda q: q['NEW_Q5']['answer'].update({'selection': '没有', 'episode': ''}),
        'unresolved_assumption_reference': lambda q: q['NEW_Q1']['assumptions'].append('NONEXISTENT_ID'),
        'malformed_skip_reason_type': lambda q: q['NEW_Q6'].update({'status': 'skipped', 'answer': None, 'skip_reason': 123}),
    }
    for name, mutate in cases.items():
        candidate = copy.deepcopy(base)
        mutate(candidate['questions'])
        result = validate_response(candidate, 'S1')
        results.append({'case': name, 'expected_valid': False, 'actual_valid': result['valid'], 'passed': not result['valid'], 'detected_errors': result['errors']})
    report = {'all_passed': all(x['passed'] for x in results), 'cases': results, 'raw_outputs_modified': False, 'source_response': str(source.relative_to(HERE)).replace('\\', '/')}
    (HERE / 'validator_verification.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(json.dumps(report, ensure_ascii=False, indent=2))
    if not report['all_passed']:
        raise SystemExit(1)


if __name__ == '__main__':
    main()
