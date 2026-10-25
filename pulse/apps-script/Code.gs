/**
 * «Пульс реки» — приём и выдача ответов опроса для страницы /pulse.
 *
 * Скрипт привязан к Google Таблице («Расширения → Apps Script»).
 * Публикуется как веб-приложение: «Выполнять от имени: я», «Доступ: все».
 * Принимает запросы ТОЛЬКО от прокси на Netlify — каждый запрос несёт
 * общий секрет (свойство скрипта PULSE_SECRET).
 *
 * Листы создаёт функция setup() (меню «Пульс → Первичная настройка»).
 * Скрипт ищет столбцы по заголовкам — их нельзя переименовывать,
 * но можно добавлять свои столбцы справа.
 */

// ---------------------------------------------------------------------
// Справочники (должны совпадать с /pulse/index.html)
// ---------------------------------------------------------------------
var SHIFTS = [
  'От teaching к learning',
  'От времени к результату',
  'От «на всякий случай» к «точно в срок»',
  'От диплома к портфелю',
  'Разделение цепочки',
  'ИИ в образовании',
  'Lifelong learning'
];
var EDU = [
  'Академическое высшее',
  'Академическое среднее профессиональное',
  'Академическое школьное',
  'Дополнительное',
  'Корпоративное',
  'Управление образованием',
  'Другой вид образования',
  'Я тот, кто учится'
];
var NOT_SEEN = 'н';           // «не наблюдаю такой сдвиг» в ячейке
var MAX_CUSTOM = 3;
var MAX_CUSTOM_LEN = 60;
var MAX_ORG_LEN = 150;

var SHEET_ANSWERS = 'Ответы';
var SHEET_CUSTOM = 'Свои сдвиги';
var SHEET_SETTINGS = 'Настройки';

var H = {
  id: 'ID',
  time: 'Время',
  edu: 'Типы образования',
  org: 'Организация',
  ip: 'Хеш IP',
  device: 'Хеш устройства',
  cRespId: 'ID ответа',
  cName: 'Исходное название',
  cStage: 'Стадия',
  cCanon: 'Каноническое название',
  cHide: 'Скрыть'
};
function shiftHeader_(i) { return 'С' + (i + 1) + ' · ' + SHIFTS[i]; }

var SETTINGS = {
  open: 'Приём ответов открыт',
  perDevice: 'Лимит ответов с устройства за 24 ч',
  perIp: 'Лимит ответов с IP за 24 ч',
  perHour: 'Лимит всех ответов за 1 ч'
};
var SETTINGS_DEFAULT = {};
SETTINGS_DEFAULT[SETTINGS.open] = true;
SETTINGS_DEFAULT[SETTINGS.perDevice] = 2;
SETTINGS_DEFAULT[SETTINGS.perIp] = 20;
SETTINGS_DEFAULT[SETTINGS.perHour] = 50;

var CACHE_KEY = 'pulse_stats_v1';
var CACHE_SEC = 20;

// ---------------------------------------------------------------------
// Меню и настройка
// ---------------------------------------------------------------------
function onOpen() {
  SpreadsheetApp.getUi().createMenu('Пульс')
    .addItem('Первичная настройка', 'setup')
    .addItem('Показать ключ для Netlify', 'showSecret')
    .addItem('Обновить график сейчас', 'clearCache')
    .addToUi();
}

/** Ручная правка в таблице — график обновится сразу, а не через 20 секунд. */
function onEdit() { clearCache(); }

function clearCache() { CacheService.getScriptCache().remove(CACHE_KEY); }

function setup() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();

  var answersHeaders = [H.id, H.time, H.edu];
  for (var i = 0; i < SHIFTS.length; i++) answersHeaders.push(shiftHeader_(i));
  answersHeaders.push(H.org, H.ip, H.device);
  var a = ensureSheet_(ss, SHEET_ANSWERS, answersHeaders);
  a.setFrozenRows(1);
  a.getRange(1, 1, 1, answersHeaders.length).setFontWeight('bold').setWrap(true);
  // служебные хеши прячем
  a.hideColumns(answersHeaders.indexOf(H.ip) + 1, 2);

  var customHeaders = [H.cRespId, H.cName, H.cStage, H.cCanon, H.cHide];
  var c = ensureSheet_(ss, SHEET_CUSTOM, customHeaders);
  c.setFrozenRows(1);
  c.getRange(1, 1, 1, customHeaders.length).setFontWeight('bold');

  var s = ensureSheet_(ss, SHEET_SETTINGS, ['Параметр', 'Значение', 'Пояснение']);
  s.getRange(1, 1, 1, 3).setFontWeight('bold');
  var notes = {};
  notes[SETTINGS.open] = 'Снимите галочку, чтобы закрыть приём. График продолжит работать.';
  notes[SETTINGS.perDevice] = 'Сколько ответов можно отправить с одного браузера за сутки.';
  notes[SETTINGS.perIp] = 'Запас для общего Wi-Fi: из одной аудитории могут отвечать многие.';
  notes[SETTINGS.perHour] = 'Предохранитель от накрутки: при превышении приём встаёт на паузу.';
  var existing = readSettingsRaw_(s);
  Object.keys(SETTINGS_DEFAULT).forEach(function (key) {
    if (existing.hasOwnProperty(key)) return;
    s.appendRow([key, SETTINGS_DEFAULT[key], notes[key] || '']);
    if (key === SETTINGS.open) s.getRange(s.getLastRow(), 2).insertCheckboxes().setValue(true);
  });
  s.autoResizeColumns(1, 3);

  // удаляем пустой «Лист1», если он есть и пуст
  var def = ss.getSheetByName('Лист1') || ss.getSheetByName('Sheet1');
  if (def && def.getLastRow() === 0 && ss.getSheets().length > 1) ss.deleteSheet(def);

  var props = PropertiesService.getScriptProperties();
  if (!props.getProperty('PULSE_SECRET')) {
    props.setProperty('PULSE_SECRET', Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, ''));
  }
  clearCache();
  showSecret();
}

function showSecret() {
  var secret = PropertiesService.getScriptProperties().getProperty('PULSE_SECRET') || '(сначала запустите «Первичная настройка»)';
  var text = 'Ключ для переменной PULSE_SECRET в Netlify:\n\n' + secret + '\n\nНикому не пересылайте его и не вставляйте в таблицу.';
  try { SpreadsheetApp.getUi().alert('Пульс · ключ', text, SpreadsheetApp.getUi().ButtonSet.OK); }
  catch (e) { Logger.log(text); }
}

function ensureSheet_(ss, name, headers) {
  var sh = ss.getSheetByName(name) || ss.insertSheet(name);
  var lastCol = Math.max(sh.getLastColumn(), 1);
  var current = sh.getRange(1, 1, 1, lastCol).getValues()[0].map(String);
  var missing = headers.filter(function (h) { return current.indexOf(h) === -1; });
  if (sh.getLastRow() === 0 || current.join('') === '') {
    sh.getRange(1, 1, 1, headers.length).setValues([headers]);
  } else if (missing.length) {
    sh.getRange(1, sh.getLastColumn() + 1, 1, missing.length).setValues([missing]);
  }
  return sh;
}

// ---------------------------------------------------------------------
// Точка входа веб-приложения
// ---------------------------------------------------------------------
function doPost(e) {
  var req;
  try { req = JSON.parse(e.postData.contents); } catch (err) { return json_({ ok: false, code: 'bad_request' }); }
  var secret = PropertiesService.getScriptProperties().getProperty('PULSE_SECRET');
  if (!secret || !req || req.secret !== secret) return json_({ ok: false, code: 'forbidden' });

  try {
    if (req.action === 'stats') return json_({ ok: true, stats: getStats_() });
    if (req.action === 'submit') return json_(submit_(req));
    return json_({ ok: false, code: 'bad_request' });
  } catch (err) {
    console.error(err);
    return json_({ ok: false, code: 'server_error' });
  }
}

function doGet() {
  return ContentService.createTextOutput('Пульс реки: сервис работает.');
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

// ---------------------------------------------------------------------
// Приём ответа
// ---------------------------------------------------------------------
function submit_(req) {
  var clean = validate_(req.data);
  if (!clean.ok) return { ok: false, code: 'invalid', field: clean.field };
  var ipHash = String(req.ipHash || '').slice(0, 32);
  var deviceHash = String(req.deviceHash || '').slice(0, 32);
  if (!ipHash || !deviceHash) return { ok: false, code: 'bad_request' };

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) return { ok: false, code: 'busy' };
  try {
    var settings = readSettings_(ss);
    if (!settings.open) return { ok: false, code: 'closed' };

    var a = ss.getSheetByName(SHEET_ANSWERS);
    var c = ss.getSheetByName(SHEET_CUSTOM);
    if (!a || !c) return { ok: false, code: 'not_configured' };
    var ah = headerIndex_(a);

    // лимиты по уже записанным строкам
    var now = new Date();
    var counts = countRecent_(a, ah, ipHash, deviceHash, now.getTime());
    if (counts.hour >= settings.perHour) return { ok: false, code: 'paused' };
    if (counts.device >= settings.perDevice) return { ok: false, code: 'limit_device' };
    if (counts.ip >= settings.perIp) return { ok: false, code: 'limit_ip' };

    var id = Utilities.getUuid().slice(0, 8);
    var row = new Array(a.getLastColumn()).fill('');
    setCell_(row, ah, H.id, id);
    setCell_(row, ah, H.time, now);
    setCell_(row, ah, H.edu, clean.edu.join('; '));
    for (var i = 0; i < SHIFTS.length; i++) setCell_(row, ah, shiftHeader_(i), clean.shifts[i]);
    // апостроф — защита от формул в тексте пользователя
    setCell_(row, ah, H.org, clean.org ? "'" + clean.org : '');
    setCell_(row, ah, H.ip, ipHash);
    setCell_(row, ah, H.device, deviceHash);
    a.appendRow(row);

    if (clean.custom.length) {
      var ch = headerIndex_(c);
      clean.custom.forEach(function (cs) {
        var r = new Array(c.getLastColumn()).fill('');
        setCell_(r, ch, H.cRespId, id);
        setCell_(r, ch, H.cName, "'" + cs.name);
        setCell_(r, ch, H.cStage, cs.stage);
        setCell_(r, ch, H.cCanon, '');
        setCell_(r, ch, H.cHide, cs.flagged);
        c.appendRow(r);
        if (ch[H.cHide] !== undefined) {
          c.getRange(c.getLastRow(), ch[H.cHide] + 1).insertCheckboxes().setValue(cs.flagged);
        }
      });
    }
    SpreadsheetApp.flush();
    clearCache();
    return {
      ok: true,
      flagged: clean.custom.some(function (x) { return x.flagged; }),
      remaining: Math.max(0, settings.perDevice - counts.device - 1),
      stats: getStats_()
    };
  } finally {
    lock.releaseLock();
  }
}

function setCell_(row, idx, header, value) {
  if (idx[header] !== undefined) row[idx[header]] = value;
}

function countRecent_(sheet, idx, ipHash, deviceHash, nowMs) {
  var res = { ip: 0, device: 0, hour: 0 };
  var n = sheet.getLastRow() - 1;
  if (n < 1) return res;
  var data = sheet.getRange(2, 1, n, sheet.getLastColumn()).getValues();
  var day = 24 * 3600 * 1000, hour = 3600 * 1000;
  data.forEach(function (r) {
    var t = r[idx[H.time]];
    var ms = t instanceof Date ? t.getTime() : Date.parse(t);
    if (!ms || nowMs - ms > day) return;
    if (nowMs - ms <= hour) res.hour++;
    if (String(r[idx[H.ip]]) === ipHash) res.ip++;
    if (String(r[idx[H.device]]) === deviceHash) res.device++;
  });
  return res;
}

/** Строгая проверка присланных данных. Возвращает нормализованный ответ. */
function validate_(d) {
  if (!d || typeof d !== 'object') return { ok: false, field: 'data' };

  if (!Array.isArray(d.edu) || !d.edu.length || d.edu.length > EDU.length) return { ok: false, field: 'edu' };
  var edu = [];
  for (var i = 0; i < d.edu.length; i++) {
    var k = d.edu[i];
    if (typeof k !== 'number' || k % 1 !== 0 || k < 0 || k >= EDU.length) return { ok: false, field: 'edu' };
    if (edu.indexOf(EDU[k]) === -1) edu.push(EDU[k]);
  }

  if (!Array.isArray(d.shifts) || d.shifts.length !== SHIFTS.length) return { ok: false, field: 'shifts' };
  var shifts = [];
  for (var j = 0; j < SHIFTS.length; j++) {
    var v = d.shifts[j];
    if (v === 'n') shifts.push(NOT_SEEN);
    else if (typeof v === 'number' && v % 1 === 0 && v >= 1 && v <= 7) shifts.push(v);
    else return { ok: false, field: 'shift' + (j + 1) };
  }

  var custom = [];
  if (d.custom !== undefined) {
    if (!Array.isArray(d.custom) || d.custom.length > MAX_CUSTOM) return { ok: false, field: 'custom' };
    for (var m = 0; m < d.custom.length; m++) {
      var cs = d.custom[m] || {};
      var name = cleanText_(cs.name, MAX_CUSTOM_LEN);
      var st = cs.stage;
      if (!name) return { ok: false, field: 'custom' };
      if (typeof st !== 'number' || st % 1 !== 0 || st < 1 || st > 7) return { ok: false, field: 'custom' };
      custom.push({ name: name, stage: st, flagged: isProfane(name) });
    }
  }

  var org = d.org === undefined || d.org === null ? '' : cleanText_(d.org, MAX_ORG_LEN);
  if (typeof d.org === 'string' && d.org.trim().length > MAX_ORG_LEN) return { ok: false, field: 'org' };
  return { ok: true, edu: edu, shifts: shifts, custom: custom, org: org };
}

function cleanText_(s, max) {
  if (typeof s !== 'string') return '';
  var t = s.replace(/[\u0000-\u001f\u007f\u200b-\u200f\u2028-\u202e\ufeff]/g, ' ')
    .replace(/\s+/g, ' ').trim();
  // пользовательский текст не должен начинаться как формула
  t = t.replace(/^[=+\-@]+/, '').trim();
  if (t.length > max) return '';
  return t;
}

// ---------------------------------------------------------------------
// Фильтр нецензурной лексики (дублируется на странице как подсказка)
// Срабатывание не отклоняет ответ: свой сдвиг сохраняется со «Скрыть» = да.
// ---------------------------------------------------------------------
var LOOKALIKE = { a: 'а', b: 'б', c: 'с', e: 'е', h: 'н', k: 'к', m: 'м', o: 'о', p: 'р', t: 'т', x: 'х', y: 'у',
  i: 'и', 'і': 'и', '1': 'и', '0': 'о', '3': 'з', '6': 'б', '@': 'а', 'ё': 'е' };
var BAD_WORD = [
  /ху[йяюё]/, /хуе[влнтс]/, /^(на|по|от|ни|за|пере)?хуе/, /хуи[лнщ]/,
  /п[иеё]зд/,
  /^(вы|за|на|до|от|по|под|при|раз|роз|у|об|из|пере|про|недо|о|съ|въ)?[её]б(?!ол)/, /долбо[её]б/,
  /бляд/, /^бля(ть)?$/, /^блят/,
  /^(за)?муд[аои](?!р)/,
  /п[иеё]д[оае]р/, /^педик(?!юр)/,
  /г[ао]нд[оа]н/, /залуп/, /шлюх/, /^сук[аиеу]$/, /^суч[кеа]/, /^манд[аеуы]$/, /мандав/,
  /дроч/, /^ж[оё]п/, /говн/, /^(на|за|об)?сра[тлн]/,
  /fuck/, /shit/, /cunt/, /bitch/, /asshole/
];

function normalizeWord_(w) {
  var out = '';
  for (var i = 0; i < w.length; i++) {
    var ch = w.charAt(i);
    out += LOOKALIKE.hasOwnProperty(ch) ? LOOKALIKE[ch] : ch;
  }
  return out.replace(/[^a-zа-я]/g, '');
}

function isProfane(text) {
  if (!text) return false;
  var s = String(text).toLowerCase();
  // «х у й», «х.у.й» → склеиваем последовательности одиночных букв
  s = s.replace(/(?:^|[\s])((?:[^\s][\s.\-_*]+){2,}[^\s])(?=\s|$)/g, function (m, g) {
    return ' ' + g.replace(/[\s.\-_*]+/g, '');
  });
  var words = s.split(/[\s,;:!?()«»"']+/);
  for (var i = 0; i < words.length; i++) {
    var raw = words[i];
    if (!raw) continue;
    var latin = /[a-z]/.test(raw) && !/[а-яё]/.test(raw);
    // чисто латинское слово проверяем как есть (английские корни), смешанное — с заменой двойников
    var w = latin ? raw.replace(/[^a-z]/g, '') : normalizeWord_(raw);
    for (var j = 0; j < BAD_WORD.length; j++) if (BAD_WORD[j].test(w)) return true;
    if (latin) {
      var cyr = normalizeWord_(raw);
      for (var k = 0; k < BAD_WORD.length; k++) if (BAD_WORD[k].test(cyr)) return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------
// Статистика: анонимные строки для графика (без организаций, ID и времени)
// ---------------------------------------------------------------------
function getStats_() {
  var cache = CacheService.getScriptCache();
  var hit = cache.get(CACHE_KEY);
  if (hit) return JSON.parse(hit);

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var a = ss.getSheetByName(SHEET_ANSWERS);
  var c = ss.getSheetByName(SHEET_CUSTOM);
  var settings = readSettings_(ss);
  var answers = a ? sheetObjects_(a) : [];
  var customRows = c ? sheetObjects_(c) : [];
  var stats = buildStats(answers, customRows, settings.open);
  stats.generatedAt = Date.now();
  cache.put(CACHE_KEY, JSON.stringify(stats), CACHE_SEC);
  return stats;
}

/**
 * Чистая функция (тестируется отдельно).
 * answers / customRows — массивы объектов {заголовок: значение}.
 */
function buildStats(answers, customRows, open) {
  var rows = [];
  var ids = {};
  answers.forEach(function (r) {
    var id = String(r[H.id] === undefined ? '' : r[H.id]).trim();
    if (!id) return;                               // только заполненные строки
    var t = parseEdu_(r[H.edu]);
    var s = [];
    var any = false;
    for (var i = 0; i < SHIFTS.length; i++) {
      var v = parseStage_(r[shiftHeader_(i)], true);
      if (v !== null) any = true;
      s.push(v);
    }
    if (!any) return;
    ids[id] = t;
    rows.push({ t: t, s: s });
  });

  var custom = [];
  customRows.forEach(function (r) {
    var rid = String(r[H.cRespId] === undefined ? '' : r[H.cRespId]).trim();
    if (!rid || !ids.hasOwnProperty(rid)) return;  // ответ удалён — его сдвиги не считаем
    var hide = r[H.cHide];
    if (hide === true || /^(true|да|1|x|х)$/i.test(String(hide).trim())) return;
    var stage = parseStage_(r[H.cStage], false);
    if (stage === null) return;
    var canon = String(r[H.cCanon] === undefined ? '' : r[H.cCanon]).trim();
    var name = (canon || String(r[H.cName] === undefined ? '' : r[H.cName])).replace(/\s+/g, ' ').trim();
    if (!name) return;
    custom.push({ t: ids[rid], n: name, s: stage });
  });

  return { open: !!open, shifts: SHIFTS, edu: EDU, rows: rows, custom: custom };
}

function parseEdu_(v) {
  var parts = String(v === undefined || v === null ? '' : v).split(/\s*[;\n]\s*/);
  var out = [];
  parts.forEach(function (p) {
    var k = EDU.indexOf(p.trim());
    if (k !== -1 && out.indexOf(k) === -1) out.push(k);
  });
  return out;
}

function parseStage_(v, allowNotSeen) {
  if (v === null || v === undefined) return null;
  var s = String(v).trim().toLowerCase();
  if (allowNotSeen && (s === NOT_SEEN || s === 'n' || s === 'не наблюдаю')) return 'n';
  var n = Number(s);
  if (s !== '' && n % 1 === 0 && n >= 1 && n <= 7) return n;
  return null;
}

// ---------------------------------------------------------------------
// Утилиты чтения таблицы
// ---------------------------------------------------------------------
function headerIndex_(sheet) {
  var hdr = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  var idx = {};
  hdr.forEach(function (h, i) { h = String(h).trim(); if (h && idx[h] === undefined) idx[h] = i; });
  return idx;
}

function sheetObjects_(sheet) {
  var lastRow = sheet.getLastRow(), lastCol = sheet.getLastColumn();
  if (lastRow < 2 || lastCol < 1) return [];
  var values = sheet.getRange(1, 1, lastRow, lastCol).getValues();
  var hdr = values[0].map(function (h) { return String(h).trim(); });
  var out = [];
  for (var r = 1; r < values.length; r++) {
    var o = {};
    for (var c = 0; c < hdr.length; c++) if (hdr[c] && o[hdr[c]] === undefined) o[hdr[c]] = values[r][c];
    out.push(o);
  }
  return out;
}

function readSettingsRaw_(sheet) {
  var out = {};
  if (!sheet || sheet.getLastRow() < 2) return out;
  sheet.getRange(2, 1, sheet.getLastRow() - 1, 2).getValues().forEach(function (r) {
    var k = String(r[0]).trim();
    if (k) out[k] = r[1];
  });
  return out;
}

function readSettings_(ss) {
  var raw = readSettingsRaw_(ss.getSheetByName(SHEET_SETTINGS));
  function num(key) {
    var n = Number(raw[key]);
    return isFinite(n) && n > 0 ? Math.floor(n) : SETTINGS_DEFAULT[key];
  }
  var openRaw = raw.hasOwnProperty(SETTINGS.open) ? raw[SETTINGS.open] : true;
  var open = openRaw === true || /^(true|да|1)$/i.test(String(openRaw).trim());
  return { open: open, perDevice: num(SETTINGS.perDevice), perIp: num(SETTINGS.perIp), perHour: num(SETTINGS.perHour) };
}
