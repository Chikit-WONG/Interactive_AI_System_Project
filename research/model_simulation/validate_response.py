"""Validate all keywords used by the frozen schema plus questionnaire routing.

This is deliberately restricted to the frozen schema's keyword set. It fails
closed if a new unsupported keyword is introduced, rather than claiming general
JSON Schema implementation support. No answer content is repaired or imputed.
"""
import json
from pathlib import Path

HERE = Path(__file__).resolve().parent
SUPPORTED = {'$schema', '$id', 'type', 'required', 'additionalProperties', 'properties', 'const', 'enum', 'items', 'minItems', 'maxItems', 'minLength', 'oneOf'}


def same(a, b):
    if isinstance(a, bool) != isinstance(b, bool):
        return False
    return a == b


def type_matches(value, expected):
    types = {
        'object': lambda: isinstance(value, dict),
        'array': lambda: isinstance(value, list),
        'string': lambda: isinstance(value, str),
        'integer': lambda: isinstance(value, int) and not isinstance(value, bool),
        'number': lambda: isinstance(value, (int, float)) and not isinstance(value, bool),
        'boolean': lambda: isinstance(value, bool),
        'null': lambda: value is None,
    }
    return expected in types and types[expected]()


def check_schema_keywords(schema):
    if not isinstance(schema, dict):
        return
    unsupported = set(schema) - SUPPORTED
    if unsupported:
        raise RuntimeError('Unsupported frozen schema keywords: ' + repr(unsupported))
    for child in schema.get('properties', {}).values():
        check_schema_keywords(child)
    for child in schema.get('oneOf', []):
        check_schema_keywords(child)
    if isinstance(schema.get('additionalProperties'), dict):
        check_schema_keywords(schema['additionalProperties'])
    if isinstance(schema.get('items'), dict):
        check_schema_keywords(schema['items'])


def schema_errors(value, schema, path='$'):
    errors = []
    if 'oneOf' in schema:
        branches = [schema_errors(value, branch, path) for branch in schema['oneOf']]
        if sum(not branch for branch in branches) != 1:
            best = min(branches, key=len)
            return [f'{path}:oneOf_failure'] + best
        return []
    expected = schema.get('type')
    if expected and not type_matches(value, expected):
        return [f'{path}:expected_{expected}']
    if 'const' in schema and not same(value, schema['const']):
        errors.append(f'{path}:const_mismatch')
    if 'enum' in schema and not any(same(value, item) for item in schema['enum']):
        errors.append(f'{path}:enum_mismatch')
    if isinstance(value, dict):
        for key in schema.get('required', []):
            if key not in value:
                errors.append(f'{path}.{key}:missing_required')
        properties = schema.get('properties', {})
        for key, child in value.items():
            if key in properties:
                errors.extend(schema_errors(child, properties[key], f'{path}.{key}'))
            elif schema.get('additionalProperties') is False:
                errors.append(f'{path}.{key}:unexpected_property')
            elif isinstance(schema.get('additionalProperties'), dict):
                errors.extend(schema_errors(child, schema['additionalProperties'], f'{path}.{key}'))
    if isinstance(value, list):
        if len(value) < schema.get('minItems', 0):
            errors.append(f'{path}:too_few_items')
        if len(value) > schema.get('maxItems', float('inf')):
            errors.append(f'{path}:too_many_items')
        if 'items' in schema:
            for index, child in enumerate(value):
                errors.extend(schema_errors(child, schema['items'], f'{path}[{index}]'))
    if isinstance(value, str) and len(value) < schema.get('minLength', 0):
        errors.append(f'{path}:too_short')
    return errors


def validate_response(response, scenario):
    schema = json.loads((HERE / 'instruments/response.schema.json').read_text(encoding='utf-8-sig'))
    contracts = json.loads((HERE / 'instruments/question_contracts.json').read_text(encoding='utf-8-sig'))['questions']
    rules = json.loads((HERE / 'instruments/skip_rules.json').read_text(encoding='utf-8-sig'))['rules']
    check_schema_keywords(schema)
    errors = schema_errors(response, schema)
    warnings = []
    if not isinstance(response, dict):
        return {'valid': False, 'errors': errors, 'warnings': []}
    if response.get('scenario_id') != scenario:
        errors.append('scenario_id:mismatch')
    questions = response.get('questions')
    if not isinstance(questions, dict):
        return {'valid': False, 'errors': errors, 'warnings': []}
    registry = response.get('assumption_registry', {})
    if not isinstance(registry, dict):
        registry = {}
    required_skips = {}
    for rule in rules:
        question = questions.get(rule['if_question'], {})
        answer = question.get('answer') if isinstance(question, dict) else None
        if isinstance(answer, dict) and answer.get(rule['if_field']) in rule['if_in']:
            for question_id in rule['skip']:
                required_skips.setdefault(question_id, []).append(rule['rule_id'])
    counts = {'answered': 0, 'skipped': 0, 'missing': 0, 'model_assumption_questions': 0, 'instrument_constraint_questions': 0}
    question_audit = {}
    for question_id, contract in contracts.items():
        entry = questions.get(question_id)
        q_errors = []
        if not isinstance(entry, dict):
            counts['missing'] += 1
            question_audit[question_id] = {'present': False, 'errors': ['missing_or_invalid_question']}
            continue
        status = entry.get('status')
        if isinstance(status, str) and status in counts:
            counts[status] += 1
        answer = entry.get('answer')
        basis = entry.get('basis', [])
        assumptions = entry.get('assumptions', [])
        if not isinstance(basis, list):
            basis = []
        if not isinstance(assumptions, list):
            assumptions = []
        skip_reason = entry.get('skip_reason', '')
        if not isinstance(skip_reason, str):
            skip_reason = ''
        if question_id in required_skips:
            if status != 'skipped' or answer is not None:
                q_errors.append('required_skip_not_followed:' + ','.join(required_skips[question_id]))
            elif not any(rule in skip_reason for rule in required_skips[question_id]):
                q_errors.append('skip_reason_missing_applicable_rule_id')
        elif status == 'skipped' and not question_id.startswith('NEW_M'):
            q_errors.append('unauthorized_main_question_skip')
        if status == 'skipped' and not skip_reason.strip():
            q_errors.append('empty_skip_reason')
        if 'model_assumption' in basis:
            counts['model_assumption_questions'] += 1
            if not assumptions:
                q_errors.append('model_assumption_without_reference')
        if 'instrument_constraint' in basis:
            counts['instrument_constraint_questions'] += 1
            if not assumptions:
                warnings.append(f'{question_id}:instrument_constraint_without_registry_reference')
        for assumption_id in assumptions:
            if not isinstance(assumption_id, str) or assumption_id not in registry:
                q_errors.append(f'unresolved_assumption:{assumption_id}')
        if status == 'answered' and isinstance(answer, dict):
            missing = set(contract['required_fields']) - set(answer)
            if missing:
                q_errors.append('missing_subfields:' + ','.join(sorted(missing)))
            for field, value in answer.items():
                if isinstance(value, list) and all(isinstance(x, str) for x in value) and len(value) != len(set(value)):
                    q_errors.append(f'duplicate_array_values:{field}')
        errors.extend(f'{question_id}:{problem}' for problem in q_errors)
        question_audit[question_id] = {'present': True, 'status': status, 'expected_skip_rules': required_skips.get(question_id, []), 'assumption_reference_count': len(assumptions), 'errors': q_errors}
    def ans(question_id):
        entry = questions.get(question_id, {})
        return entry.get('answer') if isinstance(entry, dict) and isinstance(entry.get('answer'), dict) else {}
    q17 = ans('NEW_Q17')
    if q17:
        tasks = q17.get('willing_tasks', [])
        if (q17.get('willing_status') == 'has_task') != bool(tasks):
            errors.append('NEW_Q17:willing_status_tasks_inconsistent')
    q14 = ans('NEW_Q14')
    if q14 and not q14.get('items') and not (isinstance(q14.get('none_status'), str) and q14['none_status'].strip()):
        errors.append('NEW_Q14:empty_items_without_none_status')
    q5 = ans('NEW_Q5')
    if q5 and q5.get('selection') != '有' and q5.get('episode'):
        errors.append('NEW_Q5:episode_must_be_empty_when_no_event')
    q16 = ans('NEW_Q16')
    if q16 and q16.get('selection') != '使用过' and (q16.get('task_example') or q16.get('result_example')):
        errors.append('NEW_Q16:examples_must_be_empty_without_use')
    # These frequencies are deliberately unspecified in all three scenarios.
    # Flag source attribution for manual inspection; do not reinterpret answers.
    for question_id in ('NEW_Q1', 'NEW_Q6', 'NEW_Q11', 'OLD_Q1', 'OLD_Q2'):
        entry = questions.get(question_id, {})
        answer = ans(question_id)
        if answer and answer.get('selection') not in ('记不清',) and not entry.get('assumptions'):
            warnings.append(f'{question_id}:frequency_without_explicit_assumption_reference')
    if ans('NEW_Q1').get('selection') == '0 次':
        errors.append('NEW_Q1:zero_attendance_contradicts_explicit_recent_meeting')
    if scenario in ('S1', 'S2') and ans('NEW_Q11').get('selection') == '没有':
        errors.append('NEW_Q11:no_partial_participation_contradicts_explicit_scenario')
    if scenario == 'S1' and ans('OLD_Q2').get('selection') == '从未':
        errors.append('OLD_Q2:never_conflict_contradicts_explicit_scenario')
    schema_failures = [e for e in errors if e.startswith('$')]
    return {
        'valid': not errors, 'schema_valid': not schema_failures,
        'validator': 'Restricted validator covering every keyword present in frozen response.schema.json plus explicit semantic and routing checks',
        'expected_question_count': len(contracts), 'observed_question_count': len(questions),
        'counts': counts, 'errors': errors, 'warnings': warnings, 'per_question': question_audit,
        'required_skip_question_count': len(required_skips),
        'semantic_limit': 'Machine checks cannot establish realism or truthful attribution of every narrative claim; flagged source attribution and substantive content require human review.',
    }
