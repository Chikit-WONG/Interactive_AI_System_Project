const assert=require('node:assert/strict');
const {createState,advance,respond,defer,summary,markNotNeeded,restoreAlert,recentContext}=require('./core.js');
const fs=require('node:fs'),vm=require('node:vm');const sandbox={window:{}};
vm.runInNewContext(fs.readFileSync(require('node:path').join(__dirname,'scenarios.js'),'utf8'),sandbox);
for(const scenario of sandbox.window.MEETING_SCENARIOS){
  if(scenario.id==='awareness_only'){
    for(const policy of ['all','selective']){
      const s=createState(scenario,policy);advance(s,180);
      assert.equal(s.alertCount,0);assert.equal(s.responses.length,0);
      assert.equal(summary(s).criticalEventsSeen,0);assert.equal(summary(s).criticalUnanswered.length,0);
      assert.equal(s.digests.flatMap(d=>d.items).length,8);
      assert(recentContext(s).events.every(e=>e.at>=120&&e.at<=180));
    }
    continue;
  }
  for(const policy of ['all','selective']){
    const s=createState(scenario,policy);advance(s,180);
    assert.equal(s.record.length,8);assert.equal(s.alertCount,policy==='all'?4:2);
    const delivered=[...s.alerts.map(x=>x.id),...s.digests.flatMap(x=>x.items.map(i=>i.id))];
    assert.equal(new Set(delivered).size,8);assert.equal(delivered.length,8);
    assert.equal(summary(s).criticalUnanswered.length,2);
    advance(s,180);assert.equal(s.record.length,8);
  }
  const s=createState(scenario);const e=scenario.events.find(e=>e.critical);
  assert.equal(respond(s,e.id,'before visible'),false);advance(s,e.at);
  assert.equal(respond(s,e.id,' '),false);assert.equal(defer(s,e.id,15),true);
  advance(s,e.at+15);assert.equal(s.alerts[0].snoozeUntil,null);
  advance(s,e.deadline);assert.equal(respond(s,e.id,'confirmed'),true);assert.equal(s.responses[0].timely,true);
  assert.equal(s.responses[0].validity,'not_assessed');assert.equal(respond(s,e.id,'duplicate'),false);
  const late=createState(scenario);advance(late,e.deadline+1);respond(late,e.id,'late');assert.equal(late.responses[0].timely,false);
  advance(late,scenario.duration);assert.equal(defer(late,e.id),false);
  const dismissed=createState(scenario);assert.equal(markNotNeeded(dismissed,e.id,'not_my_role'),false);
  advance(dismissed,e.at);assert.equal(markNotNeeded(dismissed,e.id,'invalid'),false);
  assert(markNotNeeded(dismissed,e.id,'not_my_role'));assert.equal(dismissed.responses.length,0);
  assert(summary(dismissed).criticalUnanswered.includes(e.id));assert.equal(summary(dismissed).markedNotNeeded.length,1);
  assert.equal(defer(dismissed,e.id),false);assert.equal(markNotNeeded(dismissed,e.id,'not_my_role'),false);
  const snapshot=recentContext(dismissed);assert(snapshot.events.every(x=>x.at<=e.at));
  advance(dismissed,e.deadline+1);assert(snapshot.events.every(x=>x.at<=e.at));
  assert(restoreAlert(dismissed,e.id));assert.equal(restoreAlert(dismissed,e.id),false);
  assert(respond(dismissed,e.id,'late correction'));assert.equal(dismissed.responses[0].timely,false);
  assert.equal(summary(dismissed).markedNotNeeded.length,0);assert.equal(markNotNeeded(dismissed,e.id,'not_my_role'),false);
  const review=recentContext(dismissed);assert(review.events.every(x=>x.at>=review.from&&x.at<=review.to));
}
console.log('PASS: two contribution scenarios plus awareness-only boundary case; exact-once routing, no future context, snapshot isolation, dismissal is not a reply, restoration preserves deadlines, duplicate prevention and honest validity.');
