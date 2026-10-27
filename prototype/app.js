(function(){
  'use strict';
  const $=id=>document.getElementById(id), C=window.MeetingCore, scenarios=window.MEETING_SCENARIOS;
  let s=C.createState(scenarios[0]), activeId=null, toastTimer, meetingTimer=null, exportedLogCount=0;
  let alertSignature='', digestSignature='', transcriptSignature='';
  const modalVisits=new Map();
  function finishModal(id,reason='close'){
    const visit=modalVisits.get(id);
    if(visit){C.log(visit.state,visit.type+'_close',{eventId:visit.eventId,reason});modalVisits.delete(id);}
    if($(id).open)$(id).close();
  }
  function beginModal(id,type,eventId){
    if(modalVisits.has(id))finishModal(id,'context_switch');
    modalVisits.set(id,{state:s,type,eventId});if(!$(id).open)$(id).showModal();
  }
  for(const id of ['reply-dialog','catchup-dialog']){
    $(id).addEventListener('cancel',ev=>{ev.preventDefault();finishModal(id,'escape')});
    $(id).querySelector('form').addEventListener('submit',ev=>{ev.preventDefault();finishModal(id,'close_button')});
    $(id).addEventListener('close',()=>{if(!$(id).open)finishModal(id,'native_close')});
  }
  $('alerts').removeAttribute('aria-live');
  const esc=x=>String(x??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const time=t=>`${Math.floor(t/60).toString().padStart(2,'0')}:${(t%60).toString().padStart(2,'0')}`;
  function toast(msg){$('toast').textContent=msg;$('toast').style.display='block';clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('toast').style.display='none',3500)}
  $('scenario').innerHTML=scenarios.map(x=>`<option value="${x.id}">${esc(x.title)}</option>`).join('');
  function reset(){
    if(s.logs.length&&!confirm('开始新演示会清除当前界面记录。需要保留时请先导出日志。继续吗？'))return false;
    finishModal('reply-dialog','reset');finishModal('catchup-dialog','reset');
    s=C.createState(scenarios.find(x=>x.id===$('scenario').value),$('policy').value);activeId=null;exportedLogCount=0;
    alertSignature='';digestSignature='';transcriptSignature='';
    renderReading();render();return true;
  }
  function renderReading(){const d=s.scenario;
    $('meeting-title').textContent=d.title;$('role').textContent=`你的角色：${d.role}`;$('private-info').textContent=d.privateInfo;
    $('reading').innerHTML=`<h2>${esc(d.reading.title)}</h2>${d.reading.paragraphs.map(p=>`<p>${esc(p)}</p>`).join('')}`;
    $('quiz').innerHTML=d.reading.questions.map((q,i)=>`<div class="quiz-item"><p>${i+1}. ${esc(q.q)}</p><div class="quiz-options">${q.options.map((o,j)=>`<label><input type="radio" name="quiz${i}" value="${j}">${esc(o)}</label>`).join('')}</div></div>`).join('');
    $('quiz-result').textContent='';$('task-state').textContent='阅读并回答 3 题';
  }
  function render(){
    $('clock').textContent=time(s.time);$('play').textContent=s.running?'暂停':'继续演示';if(!s.time)$('play').textContent='开始演示';
    $('run-status').textContent=s.time>=s.scenario.duration?'演示结束':s.running?'会议进行中':s.time?'已暂停':'等待开始';
    $('status-dot').classList.toggle('running',s.running);$('play').disabled=s.time>=s.scenario.duration;$('next').disabled=s.time>=s.scenario.duration;
    $('catchup').disabled=!s.record.length;$('alert-count').textContent=`${s.alertCount} 次即时提醒`;$('event-count').textContent=s.record.length;
    const alerts=s.alerts.filter(a=>!a.snoozeUntil||a.snoozeUntil<=s.time).slice().reverse();
    const nextAlertSignature=JSON.stringify([alerts.map(a=>[a.id,a.status,a.notNeededReason,!!(a.deadline&&s.time>a.deadline)]),!!s.time,s.alerts.some(a=>a.snoozeUntil)]);
    if(nextAlertSignature!==alertSignature){
    const focusedId=document.activeElement?.dataset.open;
    $('alerts').innerHTML=alerts.length?alerts.map(a=>{
      const replied=s.responses.some(r=>r.eventId===a.id), dismissed=a.status==='not_needed', late=a.deadline&&s.time>a.deadline;
      return `<article class="alert ${replied||dismissed?'resolved':''}"><div class="alert-top"><span>${replied?'已确认回复':dismissed?'已标记无需回应':a.critical?'需要你的判断':'向你征求意见'}</span><span>${time(a.at)}</span></div><h3>${esc(a.question)}</h3><p data-deadline="${a.id}" class="${late&&!replied&&!dismissed?'late':''}">${replied?'回复已写入本地演示记录':dismissed?'你的判断已记录；该操作不计作回复':a.deadline?(late?'脚本截止时间已过，仍可补充回复':`请在 ${time(a.deadline)} 前回应，剩余 ${a.deadline-s.time} 秒`):'可稍后处理，没有脚本截止时间'}</p><button data-open="${a.id}">${replied?'查看回复与来源':dismissed?'查看 / 恢复提醒':'查看上下文 / 回复'}</button></article>`;
    }).join(''):`<div class="empty"><b>${s.alerts.some(a=>a.snoozeUntil)?'已暂缓提醒':'当前没有待处理提醒'}</b>${s.time?'常规讨论会在阶段摘要中出现。':'点击开始，或用“下一事件”逐步演示。'}</div>`;
    alertSignature=nextAlertSignature;
    if(focusedId&&!$('reply-dialog').open)$('alerts').querySelector(`[data-open="${focusedId}"]`)?.focus();
    $('notification-status').textContent=`当前有 ${alerts.filter(a=>a.status==='pending').length} 条待处理提醒。`;
    }
    for(const a of alerts){if(a.deadline&&a.status==='pending'&&s.time<=a.deadline){const p=$('alerts').querySelector(`[data-deadline="${a.id}"]`);if(p)p.textContent=`请在 ${time(a.deadline)} 前回应，剩余 ${a.deadline-s.time} 秒`;}}
    const nextDigestSignature=JSON.stringify(s.digests.map(d=>[d.at,d.items.map(e=>e.id)]));
    if(nextDigestSignature!==digestSignature){
    $('digests').innerHTML=s.digests.length?s.digests.map(d=>`<div class="digest"><time>${time(d.at)} 更新</time>${d.items.map(e=>`<p>${esc(e.summary)} ${e.question?`<button class="text-link" data-open="${e.id}">查看 / 回复</button>`:''}</p>`).join('')}</div>`).join(''):'<p class="empty">首条摘要将在会议 00:30 出现。</p>';
    digestSignature=nextDigestSignature;}
    const nextTranscriptSignature=s.record.map(e=>e.id).join(',')||'empty';
    if(nextTranscriptSignature!==transcriptSignature){
    $('transcript-pane').innerHTML=s.record.length?s.record.map(e=>`<div class="transcript-line"><b>${esc(e.speaker)}</b><time>${time(e.at)}</time><p>${esc(e.text)}</p>${e.question?`<button class="text-link" data-open="${e.id}">查看 / 回复</button>`:''}</div>`).join(''):'<p class="empty">会议开始后，已发生的讨论会显示在这里。</p>';
    transcriptSignature=nextTranscriptSignature;}
    if($('reply-dialog').open&&activeId){const e=s.record.find(e=>e.id===activeId);$('dialog-deadline').textContent=e.deadline?(s.time>e.deadline?`脚本截止时间 ${time(e.deadline)} 已过`:`脚本回应期限 ${time(e.deadline)} · 剩余 ${e.deadline-s.time} 秒`):'此问题可以稍后处理。';}
    if(activeId){const currentAlert=s.alerts.find(a=>a.id===activeId);$('relevance-controls').hidden=!currentAlert||s.responses.some(r=>r.eventId===activeId);$('not-needed').hidden=currentAlert?.status==='not_needed';$('relevance-reason').hidden=currentAlert?.status==='not_needed';$('restore-alert').hidden=currentAlert?.status!=='not_needed';const remaining=Math.max(0,Math.min(15,s.scenario.duration-s.time));$('defer').textContent=`${remaining} 秒后再提醒`;$('defer').disabled=remaining===0||s.responses.some(r=>r.eventId===activeId)||!s.alerts.some(a=>a.id===activeId&&a.status==='pending');}
  }
  function openReply(id){const e=s.record.find(e=>e.id===id);if(!e)return;activeId=id;const r=s.responses.find(r=>r.eventId===id);
    finishModal('catchup-dialog','context_jump');$('relevance-reason').value='';C.log(s,'open_context',{eventId:id});$('dialog-question').textContent=e.question;
    $('dialog-why').textContent=e.why||'这条讨论包含向你提出的问题。';
    const context=s.record.filter(x=>(e.contextIds||[]).includes(x.id));
    $('dialog-context').innerHTML=(context.length?context:[e]).map(x=>`<p>${esc(x.summary)}</p>`).join('');
    $('dialog-sources').innerHTML=[...context,e].map(x=>`<p class="source-line">${time(x.at)} ${esc(x.speaker)}：${esc(x.text)}</p>`).join('');
    $('reply-text').value=r?r.text:'';$('reply-text').disabled=!!r;$('confirm').disabled=!!r;$('clarify').disabled=!!r;
    $('defer').disabled=!!r||!s.alerts.some(a=>a.id===id)||s.time>=s.scenario.duration;
    $('suggestions').innerHTML=r?'':(e.suggestions||[]).map((x,i)=>`<button data-suggestion="${i}">使用草稿：${esc(x)}</button>`).join('');
    beginModal('reply-dialog','context',id);render();
  }
  function openCatchup(refresh=false){const snapshot=C.recentContext(s);C.log(s,refresh?'catchup_refresh':'catchup_open',{from:snapshot.from,to:snapshot.to,eventIds:snapshot.events.map(e=>e.id)});$('catchup-range').textContent=`会议 ${time(snapshot.from)}–${time(snapshot.to)} 的记录快照 · ${snapshot.events.length} 条`; $('catchup-events').innerHTML=snapshot.events.length?snapshot.events.map(e=>`<article class="catchup-event"><div><b>${esc(e.speaker)}</b><time>${time(e.at)}</time></div><p>${esc(e.text)}</p>${e.question?`<button data-open="${e.id}">查看上下文 / 回应</button>`:''}</article>`).join(''):'<p class="muted">这段时间内没有新增发言，可通过完整记录查看更早内容。</p>';if(!$('catchup-dialog').open)beginModal('catchup-dialog','catchup');}
  document.addEventListener('click',ev=>{const btn=ev.target.closest('button');if(!btn)return;
    if(btn.dataset.open)openReply(btn.dataset.open);
    if(btn.dataset.suggestion!==undefined){const e=s.record.find(e=>e.id===activeId);$('reply-text').value=e.suggestions[Number(btn.dataset.suggestion)];C.log(s,'draft_selected',{eventId:activeId,index:Number(btn.dataset.suggestion)});}
    if(btn.dataset.view){['demo','research','brief'].forEach(v=>$(v+'-view').hidden=v!==btn.dataset.view);document.querySelectorAll('.nav').forEach(n=>n.classList.toggle('active',n===btn));if(btn.dataset.view!=='demo'){if(s.running)C.log(s,'navigation_pause',{view:btn.dataset.view});s.running=false;render();}}
    if(btn.dataset.pane){['inbox','transcript'].forEach(p=>$(p+'-pane').hidden=p!==btn.dataset.pane);document.querySelectorAll('.pane-tabs button').forEach(n=>n.classList.toggle('active',n===btn));C.log(s,'pane_open',{pane:btn.dataset.pane});}
  });
  $('catchup').onclick=()=>openCatchup();$('refresh-catchup').onclick=()=>openCatchup(true);$('close-catchup').onclick=()=>finishModal('catchup-dialog','return_to_task');
  $('not-needed').onclick=()=>{if(!C.markNotNeeded(s,activeId,$('relevance-reason').value)){toast('请先选择不需要回应的原因。');return}finishModal('reply-dialog','marked_not_needed');toast('已记录你的判断，你仍可恢复提醒或补充回复。');render()};
  $('restore-alert').onclick=()=>{if(C.restoreAlert(s,activeId)){finishModal('reply-dialog','restored');render();toast('已恢复为待处理，原回应期限继续计时。')}};
  document.addEventListener('change',ev=>{if(ev.target.matches('input[type=radio][name^=quiz]'))C.log(s,'main_task_interaction',{item:ev.target.name,value:ev.target.value})});
  $('play').onclick=()=>{if(s.time>=s.scenario.duration)return;s.running=!s.running;C.log(s,s.running?'play':'pause');render()};
  $('next').onclick=()=>{s.running=false;const next=s.scenario.events.find(e=>e.at>s.time);C.log(s,'manual_jump',{to:next?next.at:s.scenario.duration});C.advance(s,next?next.at:s.scenario.duration);render()};
  $('reset').onclick=reset;
  $('scenario').onchange=()=>{if(!reset())$('scenario').value=s.scenario.id};$('policy').onchange=()=>{if(!reset())$('policy').value=s.policy};
  $('confirm').onclick=()=>{if(!C.respond(s,activeId,$('reply-text').value)){toast('请先填写或选择回复内容。');return}finishModal('reply-dialog','confirmed');toast('已确认，回复仅保存在本次演示中。');render()};
  $('defer').onclick=()=>{const seconds=Math.min(15,s.scenario.duration-s.time);if(C.defer(s,activeId)){finishModal('reply-dialog','deferred');toast(`已暂缓 ${seconds} 秒。会议中的回应期限继续计时。`);render()}};
  $('speed').onchange=()=>C.log(s,'speed_change',{speed:Number($('speed').value)});
  $('clarify').onclick=()=>{$('reply-text').value='我需要澄清：';$('reply-text').focus();C.log(s,'clarification_draft',{eventId:activeId});toast('请补充澄清问题，再点击确认回复。')};
  $('quiz-submit').onclick=()=>{const answers=s.scenario.reading.questions.map((q,i)=>document.querySelector(`input[name="quiz${i}"]:checked`));if(answers.some(x=>!x)){toast('请先回答全部 3 题。');return}const values=answers.map(x=>Number(x.value));const score=values.filter((v,i)=>v===s.scenario.reading.questions[i].answer).length;C.log(s,'reading_quiz',{answers:values,score,total:3});$('quiz-result').textContent=`本次阅读答对 ${score} / 3 题。这是演示记录，不是研究结论。`;$('task-state').textContent='已提交阅读答案'};
  $('export').onclick=()=>{const data={schemaVersion:'0.2',exportedAt:new Date().toISOString(),startedAt:s.startedAt,sourceType:'scripted_prototype_session',timingMode:'manually_controlled_demo',currentSpeed:Number($('speed').value),scenario:s.scenario.id,policy:s.policy,summary:C.summary(s),responses:s.responses,events:s.logs};const blob=new Blob([JSON.stringify(data,null,2)],{type:'application/json'}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=`meeting-demo-${s.scenario.id}-${Date.now()}.json`;a.click();exportedLogCount=s.logs.length;setTimeout(()=>URL.revokeObjectURL(url),1000);toast('已导出本次日志。')};
  meetingTimer=setInterval(()=>{if(s.running){C.advance(s,s.time+Number($('speed').value));render()}},1000);
  window.addEventListener('beforeunload',ev=>{if(s.logs.length>exportedLogCount){ev.preventDefault();ev.returnValue='';}});renderReading();render();
  window.meetingDemo={getState:()=>s,advanceTo:t=>{C.advance(s,t);render()},openReply};
})();
