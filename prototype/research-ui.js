(function(){
 'use strict';const d=window.MEETING_RESEARCH_DATA;if(!d)return;
 const $=id=>document.getElementById(id),esc=x=>String(x??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const direct=new Set(['PU01','PU03','PU06','PU08','PU09','PU10','PU11','PU12']);
 const tier=c=>direct.has(c.caseId)?'direct':['PU04','PU07'].includes(c.caseId)?'thread':'adjacent';
 const tierLabel={direct:'直接远程情境',thread:'远程讨论串语境',adjacent:'邻近 / 方式未确认'};
 $('model-total').textContent=d.counts.completed_logical_runs;$('model-valid').textContent=d.counts.valid_simulations;
 $('model-attempts').textContent=d.counts.total_attempts;
 $('case-filter').onchange=renderCases;
 function renderCases(){const selection=$('case-filter').value;const cases=d.publicCases.filter(c=>selection==='all'||tier(c)===selection);$('case-results').innerHTML=cases.map(c=>`<article class="evidence-case"><p class="eyebrow">${esc(c.caseId)} · ${esc(c.sourceId)} · ${tierLabel[tier(c)]}</p><p>${esc(c.paraphraseZh)}</p><p class="fine">局限：${esc(c.sourceLimitations)}</p><a href="${esc(c.sourceUrl)}" target="_blank" rel="noreferrer">核查公开原文</a></article>`).join('');$('case-count').textContent=`显示 ${cases.length} 段公开叙述`}
 renderCases();
 const models=d.analysis.model_repetition||[];
 $('model-summary').innerHTML=models.map(m=>`<tr><td>${esc(m.model_id)}</td><td>${m.valid_S1_repetitions} / 3</td><td>${m.closed_field_pairwise_comparisons?`${m.closed_field_pairwise_matches} / ${m.closed_field_pairwise_comparisons}`:'无可比较记录'}</td></tr>`).join('');
 $('run-select').innerHTML=d.responses.map((r,i)=>`<option value="${i}">${esc(r.requested_model)} · ${r.scenario} · 第${r.replicate}次</option>`).join('');
 $('question-select').innerHTML=Object.keys(d.questions).map(id=>`<option value="${id}">${esc(id)} · ${esc(d.questions[id].split('\n')[0].replace(/^#+\s*/,''))}</option>`).join('');
 $('question-select').value='NEW_Q18';$('run-select').onchange=renderAnswer;$('question-select').onchange=renderAnswer;
 function renderAnswer(){const r=d.responses[Number($('run-select').value)];if(!r){$('answer-content').textContent='没有通过结构检查的回答；原始记录仍保留。';return}const id=$('question-select').value,q=r.response.questions[id];$('run-meta').textContent=`模型报告名称：${r.reported_model}；独立会话：${r.session_id}；输入摘要：${r.prompt_sha256.slice(0,16)}…`;$('question-content').textContent=d.questions[id];$('answer-content').textContent=JSON.stringify(q,null,2);$('assumption-content').textContent=JSON.stringify(r.response.assumption_registry,null,2);$('raw-answer').href=`../research/model_simulation/raw/${r.run_id}/attempt_${r.accepted_attempt}/answer.txt`}
 renderAnswer();
 $('excluded-runs').innerHTML=d.runs.filter(r=>!r.accepted_attempt).map(r=>`<li>${esc(r.run_id)}：${r.attempts.map(a=>`第${a.attempt}次 <a href="../research/model_simulation/${esc(a.raw_directory)}/audit.json">审计</a> ${a.answer_received?`<a href="../research/model_simulation/${esc(a.raw_directory)}/${a.final_result_text_received?'answer.txt':'partial_assistant_text.txt'}">填写原文</a>`:''} ${esc((a.errors||[]).join('；'))}`).join(' / ')}</li>`).join('')||'<li>无逻辑运行被排除。</li>';
})();
