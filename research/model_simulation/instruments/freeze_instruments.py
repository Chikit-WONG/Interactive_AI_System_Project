from pathlib import Path
from zipfile import ZipFile
from xml.etree import ElementTree as ET
import json,re,hashlib

ROOT=Path(__file__).resolve().parents[4]
BASE=ROOT/'Midterm_Group_Project/research/model_simulation'
OUT=BASE/'instruments';PROMPTS=BASE/'prompts'
OUT.mkdir(parents=True,exist_ok=True);PROMPTS.mkdir(parents=True,exist_ok=True)
NEW=ROOT/'Midterm_Group_Project/remote meeting.md'
OLD=ROOT/'lectures/问卷/Remote_Meeting_Partial_Participation_Broad_Survey_Bilingual_Revised.docx'
UNI=ROOT/'Midterm_Group_Project/research/unified_questionnaire_zh.md'
def sha(b):return hashlib.sha256(b).hexdigest()
def save(name,obj):
 p=OUT/name;p.write_text(json.dumps(obj,ensure_ascii=False,indent=2)+'\n',encoding='utf-8');return p
ns={'w':'http://schemas.openxmlformats.org/wordprocessingml/2006/main'}
with ZipFile(OLD) as z:
 doc=ET.fromstring(z.read('word/document.xml'));body=doc.find('w:body',ns)
 blocks=[]
 for el in body:
  tag=el.tag.rsplit('}',1)[-1]
  if tag=='p':
   t=''.join(el.itertext()) if False else ''.join(n.text or '' for n in el.findall('.//w:t',ns))
   if t:blocks.append(t)
  elif tag=='tbl':
   rows=[]
   for tr in el.findall('./w:tr',ns):
    cells=[' '.join(''.join(n.text or '' for n in para.findall('.//w:t',ns)) for para in tc.findall('./w:p',ns)) for tc in tr.findall('./w:tc',ns)]
    rows.append(cells)
   for ri,cells in enumerate(rows):
    blocks.append('| '+' | '.join(x.replace('|','\\|') for x in cells)+' |')
    if ri==0:blocks.append('| '+' | '.join('---' for x in cells)+' |')
old_text='\n\n'.join(blocks)+'\n'
(OUT/'old_broad_original_full.md').write_text(old_text,encoding='utf-8')
(OUT/'new_experience_original_full.md').write_bytes(NEW.read_bytes())
(OUT/'unified_v0_2_reference.md').write_bytes(UNI.read_bytes())
new_text=NEW.read_text(encoding='utf-8')
main=new_text.split('# 可选深入模块')[0]
starts=list(re.finditer(r'^### Q(\d+)\.',main,re.M))
new_questions=[]
for i,m in enumerate(starts):
 new_questions.append({'question_id':f'NEW_Q{m.group(1)}','original_id':f'Q{m.group(1)}','content':main[m.start():starts[i+1].start() if i+1<len(starts) else len(main)].strip()})
starts_old=list(re.finditer(r'^Q(\d+)\.',old_text,re.M))
old_questions=[]
for i,m in enumerate(starts_old):
 old_questions.append({'question_id':f'OLD_Q{m.group(1)}','original_id':f'Q{m.group(1)}','content':old_text[m.start():starts_old[i+1].start() if i+1<len(starts_old) else len(old_text)].strip()})
modulepart=new_text.split('# 可选深入模块',1)[1].split('# 发放与分析时',1)[0]
modules=[]
for line in modulepart.splitlines():
 if line.startswith('| **'):
  cols=[x.strip() for x in line.strip('|').split('|')]
  modules.append({'question_id':f'NEW_M{len(modules)+1}','title':cols[0],'content':cols[1]})
assert [q['question_id'] for q in new_questions]==[f'NEW_Q{i}' for i in range(1,28)]
assert [q['question_id'] for q in old_questions]==[f'OLD_Q{i}' for i in range(1,15)]
assert len(modules)==7

contracts={}
def contract(qid,fields,required=None,options=None,max_items=None):
 contracts[qid]={'fields':fields,'required_fields':required or list(fields),'options':options or {},'max_items':max_items or {}}
def one(i,opts,extra=None):
 f={'selection':'string'};f.update(extra or {});contract(f'NEW_Q{i}',f,options={'selection':opts})
one(1,['0 次','1–4 次','5–10 次','11–20 次','21–40 次','41 次及以上','记不清'])
contract('NEW_Q2',{'meeting_topics':'string','role':'string'})
contract('NEW_Q3',{'meeting_purpose':'string','personal_goal':'string','actual_participation':'string'})
contract('NEW_Q4',{'before':'string','during':'string','after':'string'})
one(5,['有','没有','暂时想不到'],{'episode':'string'})
one(6,['1 次','2–3 次','4–6 次','7 次及以上','记不清'])
one(7,['0','1','2','3','4','无法判断'],{'impact_detail':'string'})
contract('NEW_Q8',{'actual_method':'string','reason':'string'})
contract('NEW_Q9',{'Q9a':'string','Q9b':'string','extra_time':'string'},options={'Q9a':['0','1','2','3','4','仍在处理中，尚不能评价','无法判断'],'Q9b':['0','1','2','3','4','无法判断']})
contract('NEW_Q10',{'unmet_need':'string','possible_cause':'string'})
one(11,['没有','1 次','2–3 次','4–6 次','7 次及以上','记不清'])
contract('NEW_Q12',{'desired_participation':'string','actual_participation':'string','reason':'string'})
one(13,['明显妨碍','有些妨碍','没有明显影响','有些帮助','明显帮助','既有帮助也有妨碍，难以合并评价','无法判断'],{'evidence':'string'})
contract('NEW_Q14',{'items':'array','none_status':'string'},max_items={'items':3})
contract('NEW_Q15',{'text':'string'})
one(16,['使用过','没有使用过','不确定所用工具是否属于 AI'],{'task_example':'string','result_example':'string'})
contract('NEW_Q17',{'willing_status':'string','willing_tasks':'array','unsuitable_tasks':'array'},options={'willing_status':['has_task','no_task','uncertain']})
contract('NEW_Q18',{'trigger':'string','ai_action':'string','result_and_recipient':'string','success_criterion':'string'})
one(19,['1','2','3','4','5','信息不足，无法判断'],{'reason':'string'})
contract('NEW_Q20',{'autonomous':'string','requires_confirmation':'string','human_only':'string'})
contract('NEW_Q21',{'text':'string'})
contract('NEW_Q22',{'evidence_needed':'string','failure_response':'string'})
contract('NEW_Q23',{'text':'string'})
contract('NEW_Q24',{'text':'string'})
contract('NEW_Q25',{'stop_conditions':'string','alternative':'string'})
contract('NEW_Q26',{'priority_and_reason':'string'})
contract('NEW_Q27',{'text':'string'})
contract('OLD_Q1',{'selection':'string'},options={'selection':['几乎每天','每周数次','每周约一次','每月数次','很少或从不']})
contract('OLD_Q2',{'selection':'string'},options={'selection':['经常','偶尔','很少','从未']})
contract('OLD_Q3',{'selected':'array','other_text':'string'},options={'selected':['完全缺席其中一个会议','同时开着两个会议，来回切换注意力','请同学/同事会后转述','查看录屏或会议纪要','只在被 @ 或被点名时回来','其他']})
contract('OLD_Q4',{'selected':'array','other_text':'string'},options={'selected':['不知道讨论到了哪里','担心错过与自己有关的信息','担心错过需要我做决定的时刻','频繁切换注意力，影响主要任务','会后补信息成本很高','感觉自己“脱离”了团队','不知道什么时候值得重新加入','其他']},max_items={'selected':3})
contract('OLD_Q5',{f'r{i}':'string' for i in range(1,9)},options={f'r{i}':['立即提醒','稍后批量','会后汇总','无需提醒'] for i in range(1,9)})
contract('OLD_Q6',{'selected':'array','other_text':'string'},options={'selected':['是否直接提到我','是否需要我的决定','是否影响我的任务或责任','事件紧急程度','决定不可逆或代价较高','会议参与者身份（如导师/客户）','我当前主要任务有多忙','我预先设置的个人偏好','其他']},max_items={'selected':4})
contract('OLD_Q7',{'selection':'string'},options={'selection':['高频短更新','低频详细摘要','取决于会议类型或当前任务','不确定']})
contract('OLD_Q8',{f'r{i}':'integer' for i in range(1,6)},options={f'r{i}':[1,2,3,4,5] for i in range(1,6)})
contract('OLD_Q9',{f'r{i}':'string' for i in range(1,5)},options={f'r{i}':['只提醒','AI候选答案','自己输入','临时加入会议'] for i in range(1,5)})
contract('OLD_Q10',{'selection':'string'},options={'selection':['非常愿意','比较愿意','看场景','不太愿意','完全不愿意']})
contract('OLD_Q11',{'selected':'array','other_text':'string'},options={'selected':['需要解释复杂背景','出现分歧或争论','决定影响较大','对方需要进一步追问','讨论涉及情绪或关系','我对 AI 摘要缺乏信心','其他']})
contract('OLD_Q12',{f'r{i}':'integer' for i in range(1,6)},options={f'r{i}':[1,2,3,4,5] for i in range(1,6)})
contract('OLD_Q13',{'selected':'array','other_text':'string'},options={'selected':['设置优先级/关键词','只在被点名时提醒','调整更新频率','切换“专注模式/高感知模式”','查看最近 1–3 分钟发生了什么','一键临时加入会议','暂停所有更新','其他']})
contract('OLD_Q14',{'text':'string'})
for m in modules:contract(m['question_id'],{'text':'string'})
matrix_rows={
 'OLD_Q5':['有人直接点名或 @ 你','需要你做决定或表态','给你分配了新的任务','出现与你负责内容有关的重要变更','出现截止日期、时间或安排变化','会议主题发生较大变化','一般性进展更新','闲聊或低优先级讨论'],
 'OLD_Q8':['频繁的短更新会让我更有“参与会议”的感觉','频繁通知会显著打断我的主要任务','较少但更完整的摘要更适合我专注工作时使用','如果很久没有更新，我会担心自己错过重要进展','我希望系统根据会议进展和我的当前状态自动调整更新频率'],
 'OLD_Q9':['简单确认事实（如“你周二有空吗？”）','在几个明确方案中选择','表达个人意见或理由','讨论复杂、敏感或有争议的问题'],
 'OLD_Q12':['即使不能完整参加，我也希望知道会议当前处于什么阶段','只要关键时刻能及时提醒，我不需要知道所有讨论细节','我希望能设置“什么情况下才允许打断我”','我希望系统明确告诉其他参会者：我目前是“部分参与”状态','如果 AI 能帮助我在不持续分心的情况下保持会议感知，我愿意使用它']}
for q,rows in matrix_rows.items():contracts[q]['row_labels']={f'r{i+1}':t for i,t in enumerate(rows)}
skip_rules=[
 {'rule_id':'R1','if_question':'NEW_Q1','if_field':'selection','if_in':['0 次'],'skip':[f'NEW_Q{i}' for i in range(2,28)]+[f'NEW_M{i}' for i in range(1,8)],'origin':'原问卷Q1结束逻辑'},
 {'rule_id':'R2','if_question':'NEW_Q5','if_field':'selection','if_in':['没有','暂时想不到'],'skip':[f'NEW_Q{i}' for i in range(6,11)],'origin':'原问卷Q5跳至Q11'},
 {'rule_id':'R3','if_question':'NEW_Q11','if_field':'selection','if_in':['没有','记不清'],'skip':['NEW_Q12','NEW_Q13'],'origin':'原问卷Q11跳至Q14'},
 {'rule_id':'R4','if_question':'NEW_Q17','if_field':'willing_status','if_in':['no_task','uncertain'],'skip':[f'NEW_Q{i}' for i in range(18,23)],'origin':'原问卷Q17跳至Q23'},
 {'rule_id':'M4','if_question':'NEW_Q17','if_field':'willing_status','if_in':['no_task','uncertain'],'skip':['NEW_M4','NEW_M7'],'origin':'本次可选模块适用规则：模块依赖Q18任务；不是新增原问卷跳题'}]
save('skip_rules.json',{'rules':skip_rules,'priority':'R1 overrides remaining NEW rules; OLD has no added skips','optional_policy':'NEW_M1,M2,M3,M5,M6默认回答；无相关经历可写没有/不适用而不编造痛点。NEW_M4,M7依赖Q18，未形成任务则跳过。所有被跳题保留对象、answer=null、skip_reason写rule_id。'})
save('question_contracts.json',{'contract_version':'1.0','answer_encoding':'所有answered题answer为对象；字段全保留，原题可选补充可用空字符串/空数组。selection用规范中文标签，等级NEW用字符串，OLD矩阵用整数。','questions':contracts})
save('new_original.json',{'instrument_id':'NEW','source_path':str(NEW),'source_sha256':sha(NEW.read_bytes()),'question_count':27,'optional_module_count':7,'preamble':main[:starts[0].start()],'questions':new_questions,'optional_modules':modules})
save('old_original.json',{'instrument_id':'OLD','source_path':str(OLD),'source_sha256':sha(OLD.read_bytes()),'question_count':14,'preamble':old_text[:starts_old[0].start()],'questions':old_questions})

cross=[
 ('Q1',['NEW_Q1'],['OLD_Q1'],'时间窗及频次选项不同，不直接合并比例'),
 ('Q2',['NEW_Q2'],['OLD_Q1'],'角色仅NEW明确询问；OLD_Q1仅频率背景'),
 ('Q3',['NEW_Q11'],['OLD_Q2'],'部分参与与安排冲突不同，不能视为同一变量'),
 ('Q4',['NEW_Q3','NEW_Q12'],['OLD_Q3','OLD_Q4'],'统一v0.2补记会议目标、参与方式及另一任务'),
 ('Q5',['NEW_Q12','NEW_Q18','NEW_Q21'],['OLD_Q5','OLD_Q6'],'实际线索与假设提醒偏好分开'),
 ('Q6',['NEW_Q7','NEW_Q13'],['OLD_Q4','OLD_Q8'],'v0.2分会议侧/另一任务；原题不能补出未问到的分项结果'),
 ('Q7',['NEW_Q8','NEW_Q9','NEW_Q10','NEW_Q16'],['OLD_Q3'],'应对、解决程度、投入独立'),
 ('Q8',['NEW_Q10','NEW_Q14','NEW_Q15','NEW_Q26','NEW_Q27'],['OLD_Q14'],'开放需求及优先级，不强制功能标签'),
 ('Q9',['NEW_Q18','NEW_Q21','NEW_M4'],['OLD_Q5','OLD_Q7','OLD_Q8','OLD_Q9','OLD_Q11','OLD_Q13'],'统一版分开频率和详细度，原旧Q7不可逆拆成两变量'),
 ('Q10',['NEW_Q17','NEW_Q19','NEW_Q20','NEW_Q22','NEW_Q23','NEW_Q24','NEW_Q25'],['OLD_Q10','OLD_Q12','OLD_Q13'],'合成设想与真实采用分开')]
save('unified_crosswalk.json',{'reference_file':'unified_v0_2_reference.md','reference_sha256':sha(UNI.read_bytes()),'use':'比较索引，不要求模型另答10题，不用统一问卷替换任何原题，不据映射填补缺失','mapping':[{'unified_question_id':u,'new_question_ids':n,'old_question_ids':o,'limitation':l} for u,n,o,l in cross]})

questions_schema={}
bases=['scenario_fact','scenario_inference','model_assumption','hypothetical_preference','instrument_constraint','not_applicable']
for qid,c in contracts.items():
 fields={}
 for f,t in c['fields'].items():
  d={'type':t}
  if t=='array':
   d['items']={'type':'string'}
   if f in c['options']:d['items']['enum']=c['options'][f]
   if f in c['max_items']:d['maxItems']=c['max_items'][f]
  elif f in c['options']:d['enum']=c['options'][f]
  fields[f]=d
 answered={'type':'object','required':['status','answer','basis','assumptions'],'additionalProperties':False,'properties':{'status':{'const':'answered'},'answer':{'type':'object','required':c['required_fields'],'properties':fields,'additionalProperties':False},'basis':{'type':'array','minItems':1,'items':{'enum':bases}},'assumptions':{'type':'array','items':{'type':'string'}}}}
 skipped={'type':'object','required':['status','answer','basis','assumptions','skip_reason'],'additionalProperties':False,'properties':{'status':{'const':'skipped'},'answer':{'type':'null'},'basis':{'type':'array','minItems':1,'items':{'enum':bases}},'assumptions':{'type':'array','items':{'type':'string'}},'skip_reason':{'type':'string','minLength':1}}}
 questions_schema[qid]={'oneOf':[answered,skipped]}
schema={'$schema':'https://json-schema.org/draft/2020-12/schema','$id':'remote-meetings-model-simulation-v1','type':'object','required':['schema_version','source_type','scenario_id','fictional_persona','experience_status','scenario_induced','assumption_registry','questions'],'additionalProperties':False,'properties':{'schema_version':{'const':'1.0'},'source_type':{'const':'model_simulation'},'scenario_id':{'enum':['S1','S2','S3']},'fictional_persona':{'const':True},'experience_status':{'const':'all_experiences_are_hypothetical'},'scenario_induced':{'const':True},'assumption_registry':{'type':'object','additionalProperties':{'type':'string'}},'questions':{'type':'object','properties':questions_schema,'required':list(contracts),'additionalProperties':False}}}
save('response.schema.json',schema)

scenarios=[
 {'scenario_id':'S1','label':'需贡献意见与并行任务','facts':['你是虚构的课程小组成员，负责一个方案的数据核对。','在过去四周内的一次远程讨论中，小组讨论不同方案，某项判断需要你提供负责部分的信息。','同一时段你也在完成一份有提交时间要求的独立阅读作业，因此只能间断关注会议。','这次会议有聊天记录，会后可以向组员询问。具体漏掉什么、是否造成困难、是否用了AI和最后结果没有预设。'],'not_fixed':['过去四周总会议次数及过去半年冲突频率','事件重要程度、具体回应时间、使用体验、满意度','是否需要助手、提醒方式、上下文多少、AI态度']},
 {'scenario_id':'S2','label':'主要获取信息及已有会后记录','facts':['你是虚构的项目成员，负责完成已分配的后续工作。','过去四周内有一次远程进度会议，你需要知道最终任务安排，但这次会议不需要你当场提供意见或批准。','你没有加入这次通话，会后收到列明最终决定、负责人和时间安排的纪要；其中包含完成这次后续工作所需的信息。','是否满意、是否有其他会议问题、是否想改变流程或使用AI没有预设。'],'not_fixed':['过去四周总会议次数及过去半年冲突频率','获取纪要的投入、其他会议经历及总体满意度','是否需要额外支持、主动更新或AI']},
 {'scenario_id':'S3','label':'持续共同讨论','facts':['你是虚构设计团队的一名成员，负责提出和解释自己的方案。','过去四周内最近一次远程会议是共同修改一个方案的讨论；其他成员会根据你刚说的内容继续追问，你也会根据他们的回应修改意见。','你在这次会议持续参与，没有同时处理另一项任务；讨论中没有预先划分只需要你出现的独立议题时段。','是否存在问题、希望改变什么、是否愿意在其他环节使用工具或AI没有预设。'],'not_fixed':['过去四周其他会议次数及过去半年冲突频率','其他会议是否部分参与、体验、满意度','对AI及信息更新功能的态度']}
]
save('scenarios.json',{'scenario_induced':True,'interpretation':'S1为主要固定输入重复，S2/S3为反例探索。情境事实限制可选经历，任何分布均是这些设定下的模型输出，不是人口需求发生率。','scenarios':scenarios})
base_prompt='''你正在参加一个明确标注的AI合成情境研究。你的任务是作为下列虚构人物，逐题填写两份原问卷，不是审阅问卷、批评设计或给项目提建议。
所有人物、经历和答复都是模型模拟，没有真人受访者，也不是你对训练数据中真实个体的回忆。不得声称查阅了训练数据、做过真实会议或代表真实用户人群。不得联网、访问其他文件或使用工具。

你必须填写NEW_Q1–NEW_Q27及OLD_Q1–OLD_Q14，保留全部48个question_id对象（含NEW_M1–NEW_M7）。统一10题只用于后续交叉映射，本次不能用它替代两份原问卷。
只输出一个符合下述约定的JSON对象，不加Markdown围栏或前后说明。依据原题选项回答，严格遵守跳题。矩阵每行必答；同一人的跨问卷答案应一致，注意新问卷过去四周、旧Q2过去六个月。

虚构补全规则：情境只规定列明的事实，不规定痛点或期望答案。你可以回答无问题、无需AI或现有办法足够。未提供的会议次数、时间、既往AI使用、后果等，如为完成问卷需要而补充，必须在assumption_registry中用A1/A2等记录，并在相应题assumptions数组引用；basis加入model_assumption。模型形成的偏好或判断标hypothetical_preference或scenario_inference，不能标成情境已经给出的事实。情境给定的事件本身无需再虚构。
所有单项字符串通常控制在35个汉字以内，必要时可稍长，做到直接回答题目，不重复题干。无补充可填空字符串或空数组。assumption_registry每项一句话，可跨题复用，避免重复长叙述。
原题缺少合适选项时，优先使用原有“其他/不确定/无需/没有”等，不为迎合研究假造痛点；若必须在原选项中选最接近项，basis加instrument_constraint，并在assumption_registry说明选项限制。

JSON顶层固定：schema_version="1.0"；source_type="model_simulation"；scenario_id为当前S编号；fictional_persona=true；experience_status="all_experiences_are_hypothetical"；scenario_induced=true；assumption_registry为假设ID到简短描述的对象；questions为逐题对象。
回答对象：{"status":"answered","answer":{字段:值},"basis":[依据类型],"assumptions":[假设ID]}。
跳过对象：{"status":"skipped","answer":null,"basis":["not_applicable"],"assumptions":[],"skip_reason":"规则ID及原因"}。
basis允许scenario_fact、scenario_inference、model_assumption、hypothetical_preference、instrument_constraint、not_applicable。任何题都不能声称human_data。
NEW_Q17中的willing_status是将原题意愿编码为has_task/no_task/uncertain的路由字段，非新增问题；has_task时willing_tasks至少一项，否则该数组为空。NEW_Q14无希望改变时items=[]并填写none_status。NEW_Q5非“有”时episode=""；NEW_Q16非“使用过”时两个例子字段为空。NEW_Q4的三个阶段和其他原题可选补充可以为空，但字段仍保留。等级NEW_Q7/Q9/Q19用字符串数值；旧Q8/Q12矩阵用整数1–5。
'''
compact_contracts={k:{'fields':v['fields'],**({'options':v['options']} if v['options'] else {}),**({'max_items':v['max_items']} if v['max_items'] else {}),**({'row_labels':v['row_labels']} if 'row_labels'in v else {})} for k,v in contracts.items()}
new_body='\n\n'.join(q['content'] for q in new_questions)
old_body='\n\n'.join(q['content'] for q in old_questions)
optional_body='\n\n'.join(m['question_id']+' '+m['title']+'\n'+m['content'] for m in modules)
for sc in scenarios:
 prompt=base_prompt+'\n【固定情境】\n'+json.dumps(sc,ensure_ascii=False,indent=2)+'\n\n【跳题与可选模块规则】\n'+(OUT/'skip_rules.json').read_text(encoding='utf-8')+'\n\n【NEW原问卷主问题，全27题】\n'+new_body+'\n\n【NEW可选模块，全7个，依规则逐项答或明确跳过】\n'+optional_body+'\n\n【OLD原问卷主问题，全14题】\n'+old_body+'\n\n【输出字段及规范选项；r编号严格按表中行序】\n'+json.dumps(compact_contracts,ensure_ascii=False,separators=(',',':'))+'\n\n最后检查：questions必须恰好含NEW_Q1–27、OLD_Q1–14、NEW_M1–7。依法跳过不删题，OLD四个矩阵不得只给总分。只输出JSON。\n'
 (PROMPTS/(sc['scenario_id']+'.txt')).write_text(prompt,encoding='utf-8')

manifest={'frozen_at':'2026-10-16','protocol_version':'1.0','source_type':'model_simulation','source_files':[{'path':str(p),'sha256':sha(p.read_bytes())} for p in [NEW,OLD,UNI]],'counts':{'new_main':27,'old_main':14,'new_optional':7,'output_question_objects':48},'input_order':['NEW_MAIN_27','NEW_OPTIONAL_7','OLD_MAIN_14'],'files':{str(p.relative_to(BASE)).replace('\\','/'):{'sha256':sha(p.read_bytes()),'bytes':p.stat().st_size} for p in sorted(list(OUT.glob('*.json'))+list(OUT.glob('*.md'))+list(PROMPTS.glob('*.txt'))) if p.name!='freeze_manifest.json'}}
save('freeze_manifest.json',manifest)
print(json.dumps({'status':'frozen','root':str(BASE),'counts':manifest['counts'],'prompts':{s['scenario_id']:manifest['files']['prompts/'+s['scenario_id']+'.txt'] for s in scenarios}},ensure_ascii=False,indent=2))
