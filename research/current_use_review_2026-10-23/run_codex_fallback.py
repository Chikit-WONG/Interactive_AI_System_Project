from pathlib import Path
import subprocess,json,hashlib,time,datetime,concurrent.futures,re,threading
ROOT=Path(__file__).parent; PROMPT=ROOT/'frozen_prompt.txt'; HASH=hashlib.sha256(PROMPT.read_bytes()).hexdigest();PWSH=r'C:\Program Files\PowerShell\7\pwsh.exe'
MODELS=[('codex','gpt-5.6-sol'),('codex','gpt-5.6-luna')]
lock=threading.Lock();results=[]
def save(p,x):p.write_text(json.dumps(x,ensure_ascii=False,indent=2),encoding='utf8')
def run(provider,model,repeat):
 runid=f'{provider}__{model}__r{repeat}';folder=ROOT/'raw'/runid;folder.mkdir(parents=True,exist_ok=True);scratch=ROOT/'scratch'/runid;scratch.mkdir(parents=True,exist_ok=True)
 for attempt in [1,2]:
  f=folder/f'attempt{attempt}';f.mkdir(exist_ok=True);(f/'input.txt').write_bytes(PROMPT.read_bytes());t=time.monotonic();started=datetime.datetime.now(datetime.timezone.utc).isoformat();timedout=False
  with (f/'stdout.jsonl').open('wb') as out,(f/'stderr.txt').open('wb') as err:
   proc=subprocess.Popen([PWSH,'-NoProfile','-File',str(ROOT/'run_one.ps1'),'-Provider',provider,'-ModelId',model,'-PromptPath',str(PROMPT),'-WorkspacePath',str(scratch)],stdin=subprocess.DEVNULL,stdout=out,stderr=err,cwd=scratch,creationflags=subprocess.CREATE_NO_WINDOW)
   try:code=proc.wait(timeout=240)
   except subprocess.TimeoutExpired:
    timedout=True;subprocess.run(['taskkill','/PID',str(proc.pid),'/T','/F'],capture_output=True,creationflags=subprocess.CREATE_NO_WINDOW);code=proc.wait()
  events=[];badlines=0
  for line in (f/'stdout.jsonl').read_text(encoding='utf8',errors='replace').splitlines():
   try:events.append(json.loads(line))
   except:badlines+=1
  sessions=[];reported=[];tool_events=[];answers=[];complete=False
  for e in events:
   if e.get('session_id'):sessions.append(e['session_id'])
   if e.get('thread_id'):sessions.append(e['thread_id'])
   if e.get('model'):reported.append(e['model'])
   typ=e.get('type','');item=e.get('item',{})
   if 'tool' in typ or item.get('type') in ['command_execution','file_change','mcp_tool_call','web_search','tool_call']:tool_events.append(e)
   if typ=='assistant':
    content=e.get('message',{}).get('content',[])
    if isinstance(content,list):
     txt=''.join(x.get('text','') for x in content if isinstance(x,dict) and x.get('type')=='text')
     if txt:answers.append(txt)
   if typ=='result':
    complete=e.get('subtype')=='success' and not e.get('is_error');answers.append(e.get('result',''))
   if typ=='item.completed' and item.get('type')=='agent_message':answers.append(item.get('text',''))
   if typ=='turn.completed':complete=True
  answer=answers[-1] if answers else '';(f/'answer.txt').write_text(answer,encoding='utf8');errs=[];data=None
  try:
   c=answer.strip();c=re.sub(r'^```(?:json)?\s*','',c);c=re.sub(r'\s*```$','',c);data=json.loads(c)
   if data.get('source_type')!='model_simulation' or data.get('exposure')!='recorded_current_workflow':errs.append('exposure')
   cases=data.get('cases',[])
   if len(cases)!=8 or {c.get('id') for c in cases}!={f'E{i:02}' for i in range(1,9)}:errs.append('cases')
   if any(c.get('assessment') not in ['helpful','mixed','unhelpful'] or not c.get('reason') for c in cases):errs.append('case_labels')
   vals=data.get('value_assessments',{})
   if set(vals)!=set(['selective_attention','context_for_correct_reply','control_over_commitments']):errs.append('value_keys')
   for v in vals.values():
    if v.get('judgment') not in ['supported','mixed','unsupported'] or not v.get('reason') or not v.get('evidence_ids'):errs.append('value_labels')
   if data.get('would_use') not in ['yes','only_in_some_cases','no']:errs.append('would_use')
   if not data.get('safe_final_reply') or not data.get('presentation_claim') or not data.get('not_established'):errs.append('missing_text')
   save(f/'response.json',data)
  except Exception as ex:errs.append('parse:'+str(ex)[:100])
  if not complete or code!=0 or timedout:errs.append('execution')
  if not sessions:errs.append('session_missing')
  if tool_events:errs.append('tool_events')
  meta={'run_id':runid,'provider':provider,'requested_model':model,'reported_models':list(dict.fromkeys(reported)),'repeat':repeat,'attempt':attempt,'sessions':list(dict.fromkeys(sessions)),'prompt_sha256':HASH,'started':started,'seconds':round(time.monotonic()-t,1),'exit_code':code,'timed_out':timedout,'tool_event_count':len(tool_events),'valid':not errs,'errors':errs,'path':str(f.relative_to(ROOT))}
  save(f/'metadata.json',meta)
  with lock:
   results.append(meta);save(ROOT/'manifest_codex_fallback.json',{'planned':6,'prompt_sha256':HASH,'attempts':results});print(json.dumps({k:meta[k] for k in ['run_id','attempt','valid','errors','seconds']}),flush=True)
  if not errs:break
  errtxt=(f/'stderr.txt').read_text(encoding='utf8',errors='replace')
  if re.search(r'not available|unknown model|usage limit|quota|not supported',errtxt+answer,re.I):break
with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
 futures=[pool.submit(run,p,m,r) for r in range(1,4) for p,m in MODELS]
 for f in concurrent.futures.as_completed(futures):
  try:f.result()
  except Exception as e:print('RUNNER_ERROR',str(e),flush=True)
accepted=[x for x in results if x['valid']];records=[]
for x in accepted:records.append({'run':x,'response':json.loads((ROOT/x['path']/'response.json').read_text(encoding='utf8'))})
save(ROOT/'responses_codex_fallback.json',records);print('COMPLETE',len(records),flush=True)
