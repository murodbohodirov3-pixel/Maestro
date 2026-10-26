// The app is written in Russian; for someone who picked Uzbek (owner's
// decision of 2026-10-16) this layer translates what is on screen, text and
// the placeholder, aria-label and title attributes, as React puts it there.
// Nothing in the screens' code changes: React keeps writing Russian, and a
// MutationObserver turns each new piece into Uzbek right after. Text the
// dictionary does not know stays as it is: names, services, numbers.
import { PHRASES, TEMPLATES, WORDS } from './uz.js';

export const LANGUAGES = ['ru', 'uz'];
const CYRILLIC = /[А-Яа-яЁё]/;
// A Russian word that starts with a small letter: not a name.
const RUSSIAN_WORD = /(^|[^А-Яа-яЁёA-Za-z])[а-яё]/;

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Each template becomes a pattern; the most specific (most fixed text) first.
const COMPILED = Object.entries(TEMPLATES)
  .map(([ru, uz]) => {
    const parts = ru.split(/\{(\d+)\}/);
    let pattern = '^';
    const order = [];
    parts.forEach((part, index) => {
      if (index % 2) {
        pattern += '(.+?)';
        order.push(Number(part));
      } else {
        pattern += escapeRegExp(part);
      }
    });
    return { re: new RegExp(`${pattern}$`, 's'), order, uz, fixed: parts.filter((_, index) => !(index % 2)).join('').length };
  })
  .sort((left, right) => right.fixed - left.fixed);

const capitalize = (text) => text.charAt(0).toUpperCase() + text.slice(1);

// A word also stands at the start of a sentence: «Октябрь · пятница, 16».
const WORD_PATTERNS = WORDS.flatMap(([ru, uz]) => [[ru, uz], ...(ru !== capitalize(ru) ? [[capitalize(ru), capitalize(uz)]] : [])])
  .map(([ru, uz]) => [
    new RegExp(`(^|[^А-Яа-яЁёA-Za-z])${escapeRegExp(ru)}(?=$|[^А-Яа-яЁёA-Za-z])`, 'g'),
    uz,
  ]);

function byWords(text) {
  let out = text;
  for (const [pattern, uz] of WORD_PATTERNS) out = out.replace(pattern, (_, before) => `${before}${uz}`);
  // Small-letter Russian left means a sentence the dictionary does not know:
  // better whole Russian than half of each.
  if (RUSSIAN_WORD.test(out)) return null;
  return out.replace(/ {2,}/g, ' ').trim();
}

// Names the base keeps in both languages, such as services (name_ru and
// name_uz), registered as the data arrives.
const NAMES = new Map();
// Texts that are data and stay as written, such as products named in Russian
// («Масло для бороды Proraso»): a sentence around them is still translated.
const DATA = new Set();

export function registerData(texts) {
  for (const text of texts) {
    if (text && CYRILLIC.test(text)) DATA.add(String(text).trim());
  }
}

export function registerNames(pairs) {
  for (const [ru, uz] of pairs) {
    if (ru && uz && String(ru).trim() !== String(uz).trim()) NAMES.set(String(ru).trim(), String(uz).trim());
  }
}

function translateCore(text, depth = 0) {
  if (NAMES.has(text)) return NAMES.get(text);
  if (DATA.has(text)) return text;
  if (Object.prototype.hasOwnProperty.call(PHRASES, text)) return PHRASES[text];
  // A booking's services are their names joined with « + ».
  if (text.includes(' + ')) {
    const parts = text.split(' + ').map((part) => NAMES.get(part.trim()));
    if (parts.every(Boolean)) return parts.join(' + ');
  }
  if (depth < 4) {
    for (const template of COMPILED) {
      const match = text.match(template.re);
      if (!match) continue;
      const values = [];
      template.order.forEach((slot, index) => { values[slot] = match[index + 1]; });
      const kept = [];
      const result = template.uz.replace(/\{(\d+)\}/g, (_, slot) => {
        const value = values[Number(slot)] ?? '';
        if (DATA.has(value.trim())) {
          kept.push(value);
          return value;
        }
        return CYRILLIC.test(value) ? (translateCore(value.trim(), depth + 1) ?? value) : value;
      });
      // A part it could not translate is data (an expense «Вода для клиентов»
      // is not «{0} клиентов»): try the next way instead of half of each.
      // Registered data is not counted as Russian left behind.
      const rest = kept.reduce((left, value) => left.replace(value, ''), result);
      if (!RUSSIAN_WORD.test(rest)) return result;
    }
    const joined = bySegments(text, depth);
    if (joined != null) return joined;
  }
  return byWords(text);
}

// A text joined from known pieces: «12.10.2026: пришёл вовремя»,
// «Наличные · новый». Every piece must translate or be free of Russian words.
function bySegments(text, depth) {
  const pieces = text.split(/( · |: |, )/);
  if (pieces.length < 3) return null;
  const out = pieces.map((piece, index) => {
    if (index % 2 || !CYRILLIC.test(piece)) return piece;
    const done = translateCore(piece.trim(), depth + 1);
    if (done != null) return done;
    // Not known, but only names: keep them.
    return RUSSIAN_WORD.test(piece) ? null : piece;
  });
  return out.every((piece) => piece != null) ? out.join('') : null;
}

// One text in the chosen language. Spacing around it is kept, since React
// splits a sentence into several text nodes («3», « · », «мин»).
export function translate(text, lang) {
  if (lang !== 'uz' || !text || !CYRILLIC.test(text)) return text;
  const lead = text.match(/^\s*/)[0];
  const trail = text.match(/\s*$/)[0];
  const core = text.trim().replace(/\s+/g, ' ');
  if (!core) return text;
  const done = translateCore(core);
  return done == null ? text : `${lead}${done}${trail}`;
}

// ---------------------------------------------------------------- the screen
let current = 'ru';
let observer = null;
const ATTRIBUTES = ['placeholder', 'aria-label', 'title'];
// What each node said in Russian, so switching back restores it.
const textOriginals = new WeakMap();
const attributeOriginals = new WeakMap();

export function currentLanguage() {
  return current;
}

// For texts that never reach the page, such as a confirmation dialog.
export function tr(text) {
  return translate(text, current);
}

function skip(element) {
  return element.closest?.('[data-no-translate], script, style, textarea') != null;
}

function translateText(node) {
  const value = node.nodeValue;
  const known = textOriginals.get(node);
  // Still our own Uzbek: React has not rewritten it since.
  if (known && known.uz === value) return;
  const next = translate(value, current);
  if (next !== value) {
    textOriginals.set(node, { ru: value, uz: next });
    node.nodeValue = next;
  }
}

function translateAttributes(element) {
  for (const name of ATTRIBUTES) {
    const value = element.getAttribute(name);
    if (!value) continue;
    const known = attributeOriginals.get(element)?.[name];
    if (known && known.uz === value) continue;
    const next = translate(value, current);
    if (next !== value) {
      attributeOriginals.set(element, { ...(attributeOriginals.get(element) || {}), [name]: { ru: value, uz: next } });
      element.setAttribute(name, next);
    }
  }
}

function translateTree(node) {
  if (node.nodeType === Node.TEXT_NODE) {
    if (node.parentElement && !skip(node.parentElement)) translateText(node);
    return;
  }
  if (node.nodeType !== Node.ELEMENT_NODE || skip(node)) return;
  translateAttributes(node);
  node.childNodes.forEach(translateTree);
}

function restoreTree(node) {
  if (node.nodeType === Node.TEXT_NODE) {
    const known = textOriginals.get(node);
    if (known && node.nodeValue === known.uz) node.nodeValue = known.ru;
    return;
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return;
  const known = attributeOriginals.get(node);
  if (known) {
    for (const [name, pair] of Object.entries(known)) {
      if (node.getAttribute(name) === pair.uz) node.setAttribute(name, pair.ru);
    }
  }
  node.childNodes.forEach(restoreTree);
}

export function applyLanguage(lang, root = document.body) {
  const next = LANGUAGES.includes(lang) ? lang : 'ru';
  if (typeof document !== 'undefined') document.documentElement.lang = next;
  if (next === current && (next === 'ru' || observer)) return;
  current = next;
  if (!root) return;
  if (next === 'ru') {
    observer?.disconnect();
    observer = null;
    restoreTree(root);
    return;
  }
  translateTree(root);
  observer = new MutationObserver((records) => {
    for (const record of records) {
      if (record.type === 'characterData') translateTree(record.target);
      else if (record.type === 'attributes') translateAttributes(record.target);
      else record.addedNodes.forEach(translateTree);
    }
  });
  observer.observe(root, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter: ATTRIBUTES,
  });
}
