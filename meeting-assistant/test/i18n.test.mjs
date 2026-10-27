import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const dictionary = fs.readFileSync(new URL('../public/i18n-dictionary.js', import.meta.url), 'utf8');
const script = fs.readFileSync(new URL('../public/i18n.js', import.meta.url), 'utf8');

function load(preference, blockedStorage = false) {
  const listeners = new Map(), events = [];
  const text = value => ({ data: value, isConnected: true, parentElement: { closest: () => null } });
  const heading = text('需要你时，再回到讨论。');
  const changingStatus = text('等待内容');
  const userText = text('需要你时，再回到讨论。');
  // The user's textarea is excluded even when its text matches a UI key.
  userText.parentElement.closest = () => ({});
  const input = { isConnected: true, value: '小林 / Alex', attrs: { placeholder: '例如：小林', 'aria-label': '你的称呼' }, getAttribute(k) { return this.attrs[k] ?? null; }, setAttribute(k,v) { this.attrs[k]=v; } };
  const toggle = { attrs: {}, addEventListener(k, fn) { this.click = fn; }, setAttribute(k,v) { this.attrs[k]=v; } };
  const nodes = [heading, changingStatus, userText];
  const document = { documentElement: {}, createTreeWalker() { let i=-1; return { nextNode() { return ++i<nodes.length; }, get currentNode() { return nodes[i]; } }; }, querySelectorAll: () => [input], getElementById: () => toggle };
  let stored = preference;
  const localStorage = { getItem() { if (blockedStorage) throw Error('blocked'); return stored; }, setItem(k,v) { if (blockedStorage) throw Error('blocked'); stored=v; } };
  const window = { addEventListener(k,fn) { listeners.set(k,fn); }, dispatchEvent(e) { events.push(e); listeners.get(e.type)?.(e); } };
  const context = vm.createContext({ window, document, localStorage, NodeFilter: { SHOW_TEXT:4 }, CustomEvent: class { constructor(type, init) { this.type=type; this.detail=init.detail; } } });
  vm.runInContext(dictionary,context); vm.runInContext(script,context);
  return { i18n: window.MeetingI18n, heading, changingStatus, userText, input, toggle, document, events, listeners, get stored() { return stored; } };
}

test('fresh visit defaults to English, including accessibility and input hints', () => {
  const ui=load();
  assert.equal(ui.i18n.language,'en'); assert.equal(ui.i18n.speechLanguage,'en-US');
  assert.equal(ui.document.documentElement.lang,'en');
  assert.equal(ui.heading.data,'Rejoin when your input matters.');
  assert.equal(ui.input.attrs.placeholder,'For example: Alex');
  assert.equal(ui.input.attrs['aria-label'],'Your name');
  assert.equal(ui.toggle.textContent,'中文');
});

test('toggle translates UI, persists preference and does not mutate entered text or runtime content', () => {
  const ui=load();
  ui.changingStatus.data='User transcript: 我明天10:40到';
  ui.toggle.click();
  assert.equal(ui.i18n.language,'zh'); assert.equal(ui.i18n.speechLanguage,'zh-CN');
  assert.equal(ui.heading.data,'需要你时，再回到讨论。'); assert.equal(ui.stored,'zh');
  assert.equal(ui.input.value,'小林 / Alex');
  assert.equal(ui.userText.data,'需要你时，再回到讨论。');
  assert.equal(ui.changingStatus.data,'User transcript: 我明天10:40到');
  assert.equal(ui.events.at(-1).type,'meeting-language-changed');
  ui.toggle.click();
  assert.equal(ui.i18n.language,'en'); assert.equal(ui.stored,'en');
  assert.equal(ui.input.value,'小林 / Alex');
  assert.equal(ui.changingStatus.data,'User transcript: 我明天10:40到');
});

test('stored preference and cross-tab changes synchronize without a reload', () => {
  const ui=load('zh');
  assert.equal(ui.i18n.language,'zh'); assert.equal(ui.toggle.textContent,'English');
  ui.listeners.get('storage')({ key:'meeting-cue-language',newValue:'en' });
  assert.equal(ui.heading.data,'Rejoin when your input matters.');
  assert.equal(ui.events.length,1);
});

test('localized runtime templates and composed recorder status can switch language', () => {
  const ui=load();
  const status=ui.i18n.t(['已接收 ', ' 条发言。演示时开启上方“自动分析新发言”，也可以立即分析一次。'],3);
  assert.match(status,/3 utterance/);
  const audio=ui.i18n.t('已取得共享音轨')+' · '+ui.i18n.t('未录麦克风');
  ui.i18n.setLanguage('zh');
  assert.match(ui.i18n.retranslate(status),/已接收 3 条/);
  assert.equal(ui.i18n.retranslate(audio),'已取得共享音轨 · 未录麦克风');
  ui.i18n.setLanguage('en');
  assert.equal(ui.i18n.t('需回应'),'Respond now');
});

test('blocked browser storage still allows safe English-first switching', () => {
  const ui=load(undefined,true);
  assert.equal(ui.i18n.language,'en');
  assert.doesNotThrow(()=>ui.toggle.click());
  assert.equal(ui.i18n.language,'zh');
});
