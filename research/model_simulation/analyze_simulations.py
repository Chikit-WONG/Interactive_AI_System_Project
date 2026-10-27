"""Describe generated completions, completeness and within-model repetition.

No population estimates, p-values, or pooled user-preference means are computed.
All denominators are explicit generated-answer opportunities.
"""
import csv
import itertools
import json
from collections import Counter, defaultdict
from datetime import datetime, timezone, timedelta
from pathlib import Path

HERE = Path(__file__).resolve().parent


def canonical(value):
    # Multiple-choice selection order is not substantive; prose is preserved.
    if isinstance(value, list):
        value = sorted(value, key=lambda v: json.dumps(v, ensure_ascii=False, sort_keys=True))
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'))


def load_records():
    return [json.loads(line) for line in (HERE / 'responses.jsonl').read_text(encoding='utf-8').splitlines() if line.strip()]


def build_analysis():
    records = load_records()
    manifest = json.loads((HERE / 'manifest.json').read_text(encoding='utf-8'))
    if not manifest.get('finalized'):
        raise RuntimeError('Finish the planned batch and run reconcile_audits.py before final analysis.')
    if not manifest.get('session_ids_unique'):
        raise RuntimeError('Duplicate accepted session IDs require investigation before analysis.')
    contracts = json.loads((HERE / 'instruments/question_contracts.json').read_text(encoding='utf-8'))['questions']
    per_question = []
    for question_id in contracts:
        counts = Counter()
        assumption_runs = []
        for record in records:
            entry = record['response']['questions'].get(question_id)
            if not isinstance(entry, dict):
                counts['missing'] += 1
                continue
            counts[entry.get('status', 'invalid_status')] += 1
            counts['with_assumption_reference'] += bool(entry.get('assumptions'))
            counts['model_assumption_basis'] += 'model_assumption' in entry.get('basis', [])
            counts['instrument_constraint_basis'] += 'instrument_constraint' in entry.get('basis', [])
            if entry.get('assumptions'):
                assumption_runs.append(record['run_id'])
        per_question.append({'question_id': question_id, 'valid_logical_runs': len(records), 'answered': counts['answered'], 'skipped': counts['skipped'], 'missing': counts['missing'], 'with_assumption_reference': counts['with_assumption_reference'], 'model_assumption_basis': counts['model_assumption_basis'], 'instrument_constraint_basis': counts['instrument_constraint_basis'], 'assumption_run_ids': assumption_runs})
    model_repetition = []
    by_model = defaultdict(list)
    for record in records:
        if record['scenario'] == 'S1':
            by_model[record['requested_model']].append(record)
    for model in manifest['main_models']:
        group = sorted(by_model[model], key=lambda r: r['replicate'])
        comparable_pairs = matching_pairs = 0
        applicability_matching = applicability_pairs = 0
        field_results = []
        for question_id, contract in contracts.items():
            entries = [r['response']['questions'][question_id] for r in group]
            for first, second in itertools.combinations(entries, 2):
                applicability_pairs += 1
                applicability_matching += first['status'] == second['status']
            for field in contract.get('options', {}):
                observed = [{'replicate': r['replicate'], 'status': e['status'], 'value': e['answer'].get(field) if isinstance(e.get('answer'), dict) else None} for r, e in zip(group, entries)]
                answered = [x for x in observed if x['status'] == 'answered']
                pair_results = [canonical(a['value']) == canonical(b['value']) for a, b in itertools.combinations(answered, 2)]
                comparable_pairs += len(pair_results)
                matching_pairs += sum(pair_results)
                field_results.append({'question_id': question_id, 'field': field, 'values': observed, 'distinct_answered_values': len({canonical(x['value']) for x in answered}), 'comparable_pairs': len(pair_results), 'matching_pairs': sum(pair_results)})
        model_repetition.append({
            'model_id': model, 'valid_S1_repetitions': len(group),
            'three_repetitions_complete': len(group) == 3,
            'prompt_hashes': sorted({r['prompt_sha256'] for r in group}),
            'closed_field_pairwise_matches': matching_pairs,
            'closed_field_pairwise_comparisons': comparable_pairs,
            'closed_field_exact_agreement': matching_pairs / comparable_pairs if comparable_pairs else None,
            'applicability_pairwise_matches': applicability_matching,
            'applicability_pairwise_comparisons': applicability_pairs,
            'changed_closed_fields': [f for f in field_results if f['distinct_answered_values'] > 1],
            'all_closed_fields': field_results,
            'interpretation': 'Agreement between generated answers to identical S1 input. Does not estimate human preferences or provider reliability. Shared skips excluded from closed-field agreement; applicability is reported separately.',
        })
    attempts = [a for run in manifest['runs'] for a in run['attempts']]
    failures = [{'run_id': a['run_id'], 'attempt': a['attempt'], 'model_id': a['model_id'], 'status': a['status'], 'timed_out': a['timed_out'], 'failure_class': a.get('failure_class'), 'answer_received': a.get('answer_received'), 'schema_valid': a.get('schema_valid'), 'errors': a['errors'], 'raw_directory': a['raw_directory']} for a in attempts if a['status'] != 'completed_valid_simulation']
    warnings = [{'run_id': a['run_id'], 'warnings': a['validation'].get('warnings', [])} for a in attempts if a['status'] == 'completed_valid_simulation' and a['validation'].get('warnings')]
    narratives = []
    for r in records:
        questions = r['response']['questions']
        narratives.append({'run_id': r['run_id'], 'model_id': r['requested_model'], 'scenario': r['scenario'], 'replicate': r['replicate'], 'assumption_count': len(r['response']['assumption_registry']), 'assumption_registry': r['response']['assumption_registry'], 'selected_answers': {q: questions[q] for q in ('NEW_Q5', 'NEW_Q10', 'NEW_Q14', 'NEW_Q17', 'NEW_Q18', 'NEW_Q25', 'OLD_Q7', 'OLD_Q14')}})
    duplicate_groups = defaultdict(list)
    for record in records:
        duplicate_groups[canonical(record['response'])].append(record['run_id'])
    return {
        'compiled_at': datetime.now(timezone(timedelta(hours=8))).isoformat(),
        'source_type': 'model_simulation', 'human_participant_count': 0,
        'counts': {key: manifest.get(key) for key in ('planned_runs', 'completed_logical_runs', 'valid_simulations', 'failed_logical_runs', 'total_attempts', 'attempts_with_substantive_answer_received', 'logical_runs_with_substantive_answer_received', 'schema_valid_attempts', 'logical_runs_with_schema_valid_answer')},
        'valid_runs_by_scenario': dict(Counter(r['scenario'] for r in records)),
        'accepted_session_ids_unique': len({r['session_id'] for r in records}) == len(records),
        'accepted_run_ids_unique': len({r['run_id'] for r in records}) == len(records),
        'exact_duplicate_response_groups': [group for group in duplicate_groups.values() if len(group) > 1],
        'maximum_attempts_per_logical_run': max(len(r['attempts']) for r in manifest['runs']),
        'accepted_prompt_hashes_by_scenario': {scenario: sorted({r['prompt_sha256'] for r in records if r['scenario'] == scenario}) for scenario in ('S1', 'S2', 'S3')},
        'accepted_replacement_character_count': sum(a['replacement_character_count'] for a in attempts if a['status'] == 'completed_valid_simulation'),
        'accepted_tool_event_count': sum(a['tool_event_count'] for a in attempts if a['status'] == 'completed_valid_simulation'),
        'per_question': per_question, 'model_repetition': model_repetition,
        'failed_attempts': failures, 'manual_attribution_warnings': warnings,
        'failed_attempt_counts_by_class': dict(Counter(a.get('failure_class', 'not_classified') for a in failures)),
        'agent_narrative_review_not_human_coding': json.loads((HERE / 'manual_attribution_review.json').read_text(encoding='utf-8')) if (HERE / 'manual_attribution_review.json').exists() else None,
        'narrative_review_extracts': narratives,
        'limits': [
            'Synthetic completions are not additional users and cannot fill the missing human recruitment evidence.',
            'Model versions in the same family and common training sources are not independent respondent strata.',
            'S1 story and questionnaire options constrain the outputs; results are conditional on that fixed input.',
            'S2/S3 each have one run per core model: counterexample exploration only, not repeated-input stability.',
            'The CLI does not expose temperature or seed; backend model identity is nominal init metadata.',
            'Original older questionnaire has solution-framed and forced-choice items; completing it does not validate those assumptions.',
            'This analysis compares closed-field exact answers only. It does not treat different prose wording as a different substantive view.',
            'Machine-valid does not imply realistic or credible. Read assumption_registry and narrative extracts before using an idea as a hypothesis.',
        ],
    }


def save_analysis(analysis):
    (HERE / 'analysis.json').write_text(json.dumps(analysis, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    columns = ['question_id', 'valid_logical_runs', 'answered', 'skipped', 'missing', 'with_assumption_reference', 'model_assumption_basis', 'instrument_constraint_basis']
    with (HERE / 'question_coverage.csv').open('w', encoding='utf-8-sig', newline='') as stream:
        writer = csv.DictWriter(stream, fieldnames=columns, extrasaction='ignore')
        writer.writeheader()
        writer.writerows(analysis['per_question'])
    notebook = {
        'nbformat': 4, 'nbformat_minor': 5,
        'metadata': {'kernelspec': {'display_name': 'Python 3', 'language': 'python', 'name': 'python3'}, 'language_info': {'name': 'python'}},
        'cells': [
            {'cell_type': 'markdown', 'metadata': {}, 'source': ['# 模型模拟问卷审计\n', '这里的记录是模型在固定虚构情境下生成的问卷回答，真人 N=0。\n', '从本目录运行；代码只读取已完成的本地记录，不触发任何模型调用。\n', '完整计算源码在 `analyze_simulations.py`，每条原文、输入哈希和校验在 `raw/`。']},
            {'cell_type': 'code', 'metadata': {}, 'execution_count': None, 'outputs': [], 'source': ['from analyze_simulations import build_analysis\n', 'analysis = build_analysis()\n', 'analysis["counts"], analysis["valid_runs_by_scenario"]']},
            {'cell_type': 'code', 'metadata': {}, 'execution_count': None, 'outputs': [], 'source': ['[(x["model_id"], x["valid_S1_repetitions"], x["closed_field_pairwise_matches"], x["closed_field_pairwise_comparisons"]) for x in analysis["model_repetition"]]']},
            {'cell_type': 'code', 'metadata': {}, 'execution_count': None, 'outputs': [], 'source': ['analysis["failed_attempts"], analysis["manual_attribution_warnings"]']},
            {'cell_type': 'code', 'metadata': {}, 'execution_count': None, 'outputs': [], 'source': ['analysis["per_question"]']},
            {'cell_type': 'markdown', 'metadata': {}, 'source': ['同输入回答一致程度仅描述生成结果；不把不同模型求均值作为用户偏好，也不把 S2/S3 与 S1 的差异解释为随机波动。']},
        ],
    }
    (HERE / 'audit_notebook.ipynb').write_text(json.dumps(notebook, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    manifest = json.loads((HERE / 'manifest.json').read_text(encoding='utf-8'))
    rows = []
    for model in manifest['main_models']:
        runs = [r for r in manifest['runs'] if r['model_id'] == model]
        attempts = [a for r in runs for a in r['attempts']]
        repetition = next(x for x in analysis['model_repetition'] if x['model_id'] == model)
        rows.append('| ' + ' | '.join(map(str, [model, len(runs), len(attempts), sum(any(a.get('answer_received') for a in r['attempts']) for r in runs), sum(any(a.get('schema_valid') for a in r['attempts']) for r in runs), sum(r['accepted_attempt'] is not None for r in runs), repetition['valid_S1_repetitions']])) + ' |')
    choices = []
    for model in manifest['main_models']:
        group = [r for r in load_records() if r['requested_model'] == model and r['scenario'] == 'S1']
        def choice(qid, field):
            by_rep = {r['replicate']: r['response']['questions'][qid] for r in group}
            return ' / '.join(str((by_rep.get(i, {}).get('answer') or {}).get(field, '排除/跳过')) for i in (1, 2, 3))
        choices.append(f'| {model} | {choice("NEW_Q5", "selection")} | {choice("NEW_Q17", "willing_status")} |')
    agreement_rows = []
    for r in analysis['model_repetition']:
        total = r['closed_field_pairwise_comparisons']
        matches = r['closed_field_pairwise_matches']
        display = f'{matches}/{total}（{matches / total:.1%}）' if total else '不足两条可比较回答'
        agreement_rows.append(f'| {r["model_id"]} | {r["valid_S1_repetitions"]} | {display} |')
    c = analysis['counts']
    report = f'''# 多模型原问卷填写与审计结果

生成时间：{analysis['compiled_at']}。这些是固定虚构情境下的模型回答，**真人参与者 N=0**。原先8份“问卷审阅意见”没有混入本批数据。

## 执行与纳入

计划36个逻辑run：10个版本对完全相同的S1输入各开3个新会话（30个），另由Claude Opus、Gemini Argon、Grok分别填写S2/S3（6个）。实际已有{c['completed_logical_runs']}个逻辑run完成审计，共{c['total_attempts']}次CLI尝试，其中{manifest['attempts_with_reported_session_id']}次取得CLI init会话ID；重试仍属于原逻辑run，启动前失败的尝试不声称已完成新会话。

{c['logical_runs_with_substantive_answer_received']}个逻辑run收到实质填写文本，{c['logical_runs_with_schema_valid_answer']}个至少有一次结构符合schema，{c['valid_simulations']}个通过结构、跳题、假设引用、会话和执行检查而纳入定量描述；其余{c['failed_logical_runs']}个保留原文及原因。收到文本、格式合格、可分析是三个不同层次。

| 模型版本 | 逻辑run | 尝试 | 收到填写的run | schema合格的run | 可分析run | 可分析S1重复 |
|---|---:|---:|---:|---:|---:|---:|
{chr(10).join(rows)}

Cursor已覆盖8个主要家族，故未使用WorkBuddy补充。使用官方CLI的ask模式、精确model ID、全新空工作区、无resume；进程内仅设HTTP_PROXY=127.0.0.1:7897。没有修改全局代理或认证配置。CLI没有公开关闭所有工具、温度或随机种子的参数，使用提示禁止工具并检查实际tool事件；全部纳入记录的工具事件为{analysis['accepted_tool_event_count']}。模型名称来自CLI init元数据，不是模型自述或底层权重验证。

## 原问卷覆盖

输入完整保留新27题、旧14题和新问卷7个可选模块，共48个question对象；旧矩阵每行和NEW_Q9a/Q9b分别检查。统一10题只做交叉映射，未替代原问卷。所有冻结文件哈希通过复核。纳入记录的缺题数为{sum(q['missing'] for q in analysis['per_question'])}；合法跳题保留对象、null回答和原因，没有当成缺失。逐题的回答/跳过/假设引用统计见question_coverage.csv。

实际发生一次控制进程中断：15个逻辑run审计已保存，3个attempt未写完执行收尾记录。其输入和stdout都保留；Kimi其中一条已有成功终结文本，但进程退出码未知，因此仅算收到回答并排除分析。恢复后只使用每个逻辑run原定的剩余一次机会，过程见controller_interruption_recovery.json。没有伪造退出码，也没有覆盖失败原文。

## 同输入回答的差异

下面是纳入记录在S1三轮中的选择，按r1/r2/r3排列。“排除/跳过”不能读作否定回答。

| 模型 | NEW_Q5：有无目标与实际落差 | NEW_Q17：是否有愿交给AI的任务 |
|---|---|---|
{chr(10).join(choices)}

S1只规定了间断关注会议与并行作业，没有规定漏问、延迟、不满或需要AI。首轮Grok和Muse选择没有落差，也没有形成Q18任务；这保留了“现有办法可能够用”的反例。其他模型补出的漏问/延迟不能变成真实用户痛点的发生率。不同重复中的变化同样只说明模型如何补全未给定经历。

两个具体例子：Muse的S1第1轮Q5回答“没有”，第3轮补成“期待及时提供数据实际回复晚了些”，但两轮Q17都不愿交给AI新任务，第3轮仍称现有聊天记录够用。这个生成案例提醒研究者不能直接从“有落差”推出“需要新AI工具”。Gemini Argon与Kimi的三次S1在OLD_Q7都依次选择“取决于会议类型或当前任务／低频详细摘要／取决于会议类型或当前任务”；这是同输入下偏好选择的变化，需要回到具体条件追问，不能平均成真实用户希望的提醒频率。

闭合字段比较使用同模型S1回答两两精确一致数/可比较字段对数。多选忽略排列；双方均合法跳过不计作闭合字段一致，跳题适用性另列于analysis.json；自由文本措辞差异没有当成不同立场。少于3条有效S1回答的型号，不能宣称已完成3次有效复测。

| 模型 | 有效S1次数 | 闭合字段两两一致 |
|---|---:|---|
{chr(10).join(agreement_rows)}

这些比例是生成回答的一致程度，不是用户偏好、模型真实性或人群需求估计。样本小、默认采样参数未知，且无效输出的排除会选择性改变可比较集合；不据此做模型排行榜。S2/S3每型号每情境仅一次，只用于寻找反例，不能与S1合并解释为随机稳定性。

## 假设与实际用途

每题保留basis及assumptions引用。机器能检查引用是否存在，不能保证引用覆盖叙事里的每个细节。survey_audit代理的内容抽查发现Gemini3.1首轮的Q4、Q6、Q13有部分补全没有得到足够具体的假设支撑，已记在manual_attribution_review.json；原回答没有事后改写。该抽查由AI代理完成，并非独立人类编码，也没有逐句核对全部回答。结构合格不等于内容已完全归因。

这批数据可用来找问卷歧义、测试跳题和编码、列出需要向真人追问的相反解释。下一步应把“是否出现落差”“哪些部分现有聊天/纪要已足够”“什么时候需要即时贡献而不是会后了解”交给真实参与者回答，再以原型任务观察能否及时贡献及是否增加打断。不能用模型均值替代TA要求的真实用户调研，也不能据此证明原型有效。

## 可复查材料

- manifest.json：全部逻辑run、尝试、模型、会话、哈希、排除原因。
- responses.jsonl：仅纳入分析的回答，所有记录标model_simulation。
- raw/<run>/attempt_n/：input.txt、stdout.jsonl、stderr.txt、execution.json、answer.txt、audit.json；可解析时另有response.json。
- audit_initial.json与reaudit_changes.json：统一复审前的审计和变化；原始答案不改。
- analysis.json、question_coverage.csv、audit_notebook.ipynb：分析数据、逐题覆盖和可复运行计算。
'''
    (HERE / 'results_zh.md').write_text(report, encoding='utf-8')
    inventory_path = HERE.parent / 'model_inventory.json'
    if inventory_path.exists():
        inventory = json.loads(inventory_path.read_text(encoding='utf-8-sig'))
        inventory['questionnaire_simulation'] = {
            'compiled_at': analysis['compiled_at'], 'source_type': 'model_simulation',
            'manifest_path': 'model_simulation/manifest.json', 'analysis_path': 'model_simulation/analysis.json',
            'results_zh_path': 'model_simulation/results_zh.md', 'human_participant_count': 0,
            'counts': analysis['counts'], 'models_with_three_valid_S1_repetitions': sum(x['three_repetitions_complete'] for x in analysis['model_repetition']),
            'requested_model_ids': manifest['main_models'], 'workbuddy_used': False,
            'not_combined_with_prior_model_review_counts': True,
        }
        inventory_path.write_text(json.dumps(inventory, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')


if __name__ == '__main__':
    result = build_analysis()
    save_analysis(result)
    print(json.dumps({'counts': result['counts'], 'by_scenario': result['valid_runs_by_scenario'], 'models_completed_3_S1': sum(r['three_repetitions_complete'] for r in result['model_repetition']), 'failed_attempts': len(result['failed_attempts'])}, ensure_ascii=False, indent=2))
