"use strict";
(() => {
  const dictionary = window.MeetingCueEnglish || {};
  const storageKey = "meeting-cue-language";
  let language = "en";
  try { if (localStorage.getItem(storageKey) === "zh") language = "zh"; } catch {}
  const reverse = new Map();
  const bindings = [];
  function format(key, values = []) {
    const pattern = language === "en" ? dictionary[key] ?? key : key;
    return pattern.replace(/\{\{(\d+)\}\}/g, (_, index) => String(values[Number(index)] ?? ""));
  }
  function t(input, ...values) {
    const key = Array.isArray(input) ? input.reduce((text, part, i) => text + part + (i < input.length - 1 ? `{{${i}}}` : ""), "") : input;
    const output = format(key, values);
    reverse.set(output, { key, values });
    return output;
  }
  function retranslate(value) {
    const saved = reverse.get(value);
    if (saved) return t(saved.key, ...saved.values.map(v => typeof v === "string" && v !== value ? retranslate(v) : v));
    if (Object.hasOwn(dictionary, value)) return t(value);
    // Some recorder status lines join multiple UI phrases. Translate only these
    // explicitly requested status values; never scan user or model content.
    const pieces = [...reverse.entries()].filter(([text, saved]) => text && saved.values.length === 0 && text !== value)
      .sort((a, b) => b[0].length - a[0].length);
    if (pieces.length) {
      const escape = text => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const lookup = new Map(pieces);
      return String(value).replace(new RegExp(pieces.map(([text]) => escape(text)).join("|"), "g"), text => format(lookup.get(text).key));
    }
    return value;
  }
  function applyStatic() {
    document.documentElement.lang = language === "en" ? "en" : "zh-CN";
    for (const binding of bindings) {
      if (!binding.node.isConnected) continue;
      const current = binding.attribute ? binding.node.getAttribute(binding.attribute) : binding.node.data;
      // Runtime content and user text are never overwritten by static translation.
      if (current !== binding.last) continue;
      binding.last = binding.prefix + t(binding.key) + binding.suffix;
      if (binding.attribute) binding.node.setAttribute(binding.attribute, binding.last);
      else binding.node.data = binding.last;
    }
    const button = document.getElementById("language-toggle");
    if (button) {
      button.textContent = language === "en" ? "中文" : "English";
      button.setAttribute("aria-label", language === "en" ? "Switch to Chinese" : "切换为英文");
      button.title = language === "en" ? "Switch to Chinese" : "切换为英文";
    }
  }
  function setLanguage(next, persist = true) {
    if (!["en", "zh"].includes(next) || next === language) return;
    language = next;
    if (persist) { try { localStorage.setItem(storageKey, language); } catch {} }
    applyStatic();
    window.dispatchEvent(new CustomEvent("meeting-language-changed", { detail: { language } }));
  }
  window.MeetingI18n = { t, retranslate, setLanguage, get language() { return language; }, get speechLanguage() { return language === "en" ? "en-US" : "zh-CN"; } };
  // Capture only the original markup. No observer translates transcript, draft or model content.
  const walker = document.createTreeWalker(document.documentElement, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const node = walker.currentNode;
    if (node.parentElement?.closest("script, style, textarea")) continue;
    const key = node.data.trim();
    if (Object.hasOwn(dictionary, key)) {
      const prefix = node.data.match(/^\s*/)[0], suffix = node.data.match(/\s*$/)[0];
      bindings.push({ node, key, prefix, suffix, last: node.data });
    }
  }
  for (const node of document.querySelectorAll("[aria-label], [placeholder], [title]")) {
    for (const attribute of ["aria-label", "placeholder", "title"]) {
      const key = node.getAttribute(attribute);
      if (key && Object.hasOwn(dictionary, key)) bindings.push({ node, key, attribute, prefix: "", suffix: "", last: key });
    }
  }
  applyStatic();
  document.getElementById("language-toggle")?.addEventListener("click", () => setLanguage(language === "en" ? "zh" : "en"));
  window.addEventListener("storage", event => { if (event.key === storageKey) setLanguage(event.newValue === "zh" ? "zh" : "en", false); });
})();
