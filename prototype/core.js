(function (root) {
  'use strict';
  const clone = x => JSON.parse(JSON.stringify(x));
  function createState(scenario, policy = 'selective') {
    return { scenario: clone(scenario), policy, time: 0, startedAt: new Date().toISOString(), running: false, processed: [], record: [], queue: [], alerts: [], digests: [], responses: [], logs: [], digestAt: 30, alertCount: 0 };
  }
  function log(s, type, detail = {}) { s.logs.push({ meetingTime: s.time, wallTime: new Date().toISOString(), type, ...detail }); }
  function advance(s, next) {
    const target = Math.min(s.scenario.duration, Math.max(s.time, next));
    for (let t = s.time + 1; t <= target; t++) {
      s.time = t;
      for (const e of s.scenario.events.filter(e => e.at === t && !s.processed.includes(e.id))) {
        s.processed.push(e.id); s.record.push(clone(e));
        log(s, 'event', { eventId: e.id });
        const immediate = s.policy === 'all' ? !!e.question : !!e.critical;
        if (immediate) {
          s.alerts.push({ ...clone(e), shownAt: t, status: 'pending', snoozeUntil: null });
          s.alertCount++; log(s, 'alert', { eventId: e.id, reason: s.policy === 'all' ? 'user_directed_question' : 'scripted_critical' });
        } else s.queue.push(clone(e));
      }
      if (t >= s.digestAt) {
        if (s.queue.length) {
          s.digests.unshift({ at: t, items: clone(s.queue) });
          log(s, 'digest', { eventIds: s.queue.map(e => e.id) }); s.queue = [];
        }
        s.digestAt += 30;
      }
      for (const a of s.alerts) {
        if (a.snoozeUntil && t >= a.snoozeUntil) {
          a.snoozeUntil = null; log(s, 'resurface', { eventId: a.id });
        }
      }
    }
    if (s.time === s.scenario.duration) s.running = false;
    return s;
  }
  function respond(s, eventId, text) {
    const e = s.record.find(e => e.id === eventId);
    if (!e || !text.trim()) return false;
    if (s.responses.some(r => r.eventId === eventId)) return false;
    const r = { eventId, text: text.trim(), confirmedAt: s.time, deadline: e.deadline ?? null, timely: e.deadline ? s.time <= e.deadline : null, validity: 'not_assessed' };
    s.responses.push(r);
    const a = s.alerts.find(a => a.id === eventId); if (a) { a.status = 'confirmed'; a.snoozeUntil = null; a.notNeededReason = null; }
    log(s, 'confirmed_reply', r); return true;
  }
  function defer(s, eventId, seconds = 15) {
    if (s.time >= s.scenario.duration) return false;
    const a = s.alerts.find(a => a.id === eventId && a.status === 'pending');
    if (!a) return false;
    a.snoozeUntil = Math.min(s.time + seconds, s.scenario.duration);
    log(s, 'defer', { eventId, until: a.snoozeUntil }); return true;
  }
  function markNotNeeded(s, eventId, reason) {
    const allowed=['not_my_role','already_handled','no_action_needed'];
    const a=s.alerts.find(a=>a.id===eventId&&a.status==='pending');
    if(!a||!allowed.includes(reason)||s.responses.some(r=>r.eventId===eventId))return false;
    a.status='not_needed';a.notNeededReason=reason;a.snoozeUntil=null;
    log(s,'marked_not_needed',{eventId,reason,interpretation:'user_judgment_not_verified_false_positive'});return true;
  }
  function restoreAlert(s,eventId){
    const a=s.alerts.find(a=>a.id===eventId&&a.status==='not_needed');
    if(!a)return false;a.status='pending';a.notNeededReason=null;
    log(s,'restored_alert',{eventId});return true;
  }
  function recentContext(s,seconds=60){
    const from=Math.max(0,s.time-seconds);
    return {from,to:s.time,events:clone(s.record.filter(e=>e.at>=from&&e.at<=s.time))};
  }
  function summary(s) {
    const critical = s.record.filter(e => e.critical);
    return { elapsedMeetingSeconds: s.time, immediateAlerts: s.alertCount, criticalEventsSeen: critical.length,
      confirmedReplies: s.responses.length, criticalTimelyConfirmed: critical.filter(e => s.responses.some(r => r.eventId === e.id && r.timely)).length,
      criticalUnanswered: critical.filter(e => !s.responses.some(r => r.eventId === e.id)).map(e => e.id),
      markedNotNeeded:s.alerts.filter(a=>a.status==='not_needed').map(a=>({eventId:a.id,reason:a.notNeededReason})),
      responseValidity: 'not_assessed', note: 'Scripted demonstration logs, not a user-study result. Confirmation does not establish correctness. Marking not needed is an unverified user judgment and does not count as a reply.' };
  }
  const api = { createState, advance, respond, defer, markNotNeeded, restoreAlert, recentContext, summary, log };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.MeetingCore = api;
})(typeof window !== 'undefined' ? window : globalThis);
