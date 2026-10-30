// «Пульс реки» — интерпретация результатов опроса с помощью Claude.
//
// Переменные окружения Netlify:
//   PULSE_SCRIPT_URL, PULSE_SECRET — те же, что у pulse.mjs
//   ANTHROPIC_API_KEY             — ключ Anthropic API
//   PULSE_MODEL                   — необязательно, модель (по умолчанию claude-sonnet-5-5)
//   PULSE_DAILY_LIMIT             — необязательно, сколько раз за 24 часа можно вызвать модель (по умолчанию 50)
//
// GET  /pulse/interp → последняя готовая интерпретация {n, html, at} или null
// POST /pulse/interp → если число ответов изменилось, пишет новую интерпретацию.
//                      Одна генерация на всех: результат кешируется в Netlify Blobs
//                      по числу ответов, параллельные запросы получают code: "busy".

import { getStore } from "@netlify/blobs";

const MODEL_DEFAULT = "claude-sonnet-5-5";
const LOCK_MS = 45_000;               // пока идёт генерация, вторую не запускаем
const COOLDOWN_MS = 20_000;           // не чаще одной генерации в 20 с
const DAY_MS = 24 * 3600_000;
const DAILY_LIMIT_DEFAULT = 50;       // вызовов модели за скользящие 24 часа
const UPSTREAM_TIMEOUT_MS = 9_500;
const LLM_TIMEOUT_MS = 24_000;        // синхронная функция живёт до ~30 с

const env = (k) => (globalThis.Netlify?.env?.get?.(k)) ?? process.env[k];

const SHIFTS = ["От teaching к learning", "От времени к результату", "От «на всякий случай» к «точно в срок»",
  "От диплома к портфелю", "Разделение цепочки", "ИИ в образовании", "Lifelong learning"];
const EDU = ["Академическое высшее (вузы)", "Академическое среднее профессиональное (СПО)", "Академическое школьное",
  "Дополнительное (ДПО)", "Корпоративное", "Управление образованием", "Другой вид образования", "Я тот, кто учится"];
const STAGES = ["Запрос на изменения", "Отрицание", "Починить существующее", "Новые модели на периферии",
  "Распространение", "Стандартизация", "Масштабирование"];

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" },
  });
}

async function getStats() {
  const url = env("PULSE_SCRIPT_URL"), secret = env("PULSE_SECRET");
  if (!url || !secret) return null;
  try {
    const res = await fetch(url, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "stats", secret }), redirect: "follow",
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    const j = JSON.parse(await res.text());
    return j.ok ? j.stats : null;
  } catch (e) {
    console.error("stats failed", e?.name || e);
    return null;
  }
}

/* ---------- сводка для модели: только агрегаты, без организаций ---------- */
function matrix(rows) {
  const m = SHIFTS.map(() => ({ st: [0, 0, 0, 0, 0, 0, 0], nn: 0 }));
  rows.forEach(r => (r.s || []).forEach((v, i) => {
    if (!m[i]) return;
    if (v === "n") m[i].nn++;
    else if (typeof v === "number" && v >= 1 && v <= 7) m[i].st[v - 1]++;
  }));
  return m.map((x, i) => {
    const tot = x.st.reduce((a, b) => a + b, 0);
    const mean = tot ? x.st.reduce((a, c, k) => a + c * (k + 1), 0) / tot : null;
    return `  ${SHIFTS[i]}: стадии1–7 = [${x.st.join(", ")}], не наблюдаю = ${x.nn}, средняя = ${mean === null ? "—" : mean.toFixed(2)}`;
  }).join("\n");
}

function digest(stats) {
  const rows = stats.rows || [];
  const parts = [`Всего ответов: ${rows.length}.`, "", "ВСЕ ОТВЕТЫ:", matrix(rows)];
  EDU.forEach((e, i) => {
    const sub = rows.filter(r => Array.isArray(r.t) && r.t.includes(i));
    if (sub.length) parts.push("", `СЕКТОР «${e}» — ${sub.length} отв.:`, matrix(sub));
  });
  const den = rows.filter(r => (r.s || []).some(v => v === 2));
  parts.push("", `Участников, отметивших «Отрицание» хотя бы по одному сдвигу: ${den.length}; их типы образования: ${
    den.map(r => "[" + (r.t || []).map(i => EDU[i]).join(" + ") + "]").join("; ") || "—"}.`);
  const multi = rows.filter(r => Array.isArray(r.t) && r.t.length > 1).length;
  parts.push(`Ответов, где отмечено несколько типов образования: ${multi}.`);
  const g = new Map();
  (stats.custom || []).forEach(c => {
    const k = String(c.n || "").trim().slice(0, 60); if (!k || !(c.s >= 1 && c.s <= 7)) return;
    if (!g.has(k)) g.set(k, []); g.get(k).push(c.s);
  });
  parts.push("", "Свои сдвиги участников (название: стадии):",
    [...g.entries()].map(([k, s]) => `  «${k}»: ${s.join(", ")}`).join("\n") || "  нет");
  return parts.join("\n");
}

const EXAMPLE = `<section><h3>Общая картина</h3>
<p>Большинство ответов приходится на середину шкалы: «починить существующее», «новые модели на периферии» и «распространение». До масштабирования доходят единицы. Похоже, трансформация уже идёт, но пока в основном по краям системы, а не в её ядре.</p></section>
<section><h3>Дальше всех продвинулись</h3><ul>
<li><b>От teaching к learning</b> и <b>Lifelong learning</b>: у них самая высокая средняя стадия, и по обоим есть ответы «масштабирование».</li>
<li><b>Разделение цепочки</b>: здесь чаще всего отмечали «распространение». Делегировать отдельные звенья уже умеют, но до масштаба этот сдвиг не дошёл ни у кого.</li>
<li>Меньше всего продвинулись <b>ИИ в образовании</b> и <b>от диплома к портфелю</b>.</li></ul></section>
<section><h3>Отрицание</h3>
<p>Отрицание встречается редко, и только в дополнительном образовании. Больше всего его в сдвигах «точно в срок», «от диплома к портфелю» и «ИИ в образовании». Все три касаются продуктовой модели: коротких форматов, ценности сертификата и роли самого курса.</p></section>
<section><h3>Интересные наблюдения</h3><ul>
<li>Стадию «запрос на изменения» не отметил почти никто: участники не видят себя в начале пути.</li>
<li>Самые разные оценки получил ИИ: от «запроса» и «отрицания» до «стандартизации».</li>
<li>По сдвигу «точно в срок» мнения разошлись сильнее всего: ответы стоят на всех стадиях, от отрицания до масштабирования.</li>
<li>Один участник добавил свой сдвиг, <b>«Запрос от взрослых»</b>, и сразу поставил его на стадию масштабирования.</li></ul></section>
<section><h3>Вузы, ДПО и корпоративное обучение</h3><ul>
<li><b>Вузы</b> (5 ответов): отрицания нет совсем. Ответы делятся на две группы: «починить существующее» и «стандартизация». Педагогические сдвиги (teaching→learning, время→результат, точно в срок) чаще всего отмечены на стадии «починить».</li>
<li><b>ДПО</b> (8 ответов): самый широкий разброс. Здесь и всё отрицание, и большая часть ответов «масштабирование».</li>
<li><b>Корпоративное</b> (2 ответа): ответы ровные, на стадиях от «новых моделей» до «стандартизации», без крайностей.</li>
<li><b>Сходятся</b> в трёх сдвигах: teaching→learning по средней стадии почти одинаков у всех; «от диплома к портфелю» все видят на стадии новых моделей, «разделение цепочки» — на стадии распространения.</li>
<li><b>Расходятся</b> в двух: в lifelong learning вузы на стадии новых моделей, остальные на стадии распространения; по ИИ вузы и корпоративный сектор видят его ближе к стандартизации, а в ДПО оценки разбросаны по всей шкале.</li></ul></section>
<p class="interp-foot">Ответов немного, участники могли отметить несколько типов образования, а ДПО составляет большую часть выборки. Это пульс нашего зала, а не срез отрасли.</p>`;

const SYSTEM = `Ты помогаешь Марине Семехиной (доклад «Трансформация образования: где мы находимся», 10 лет Кафедры Гудлайн) показать участникам опроса короткую интерпретацию результатов.

Модель опроса: семь сдвигов образования и семь стадий адаптации к каждому (1 — запрос на изменения, 2 — отрицание, 3 — починить существующее, 4 — новые модели на периферии, 5 — распространение, 6 — стандартизация, 7 — масштабирование). Участник может отметить несколько типов образования, поэтому секторы пересекаются.

Правила:
- Пиши по-русски, просто и точно, для участников конференции. Без канцелярита и без восторгов.
- Каждое утверждение должно следовать из данных. Не выдумывай причин, которых нельзя увидеть в цифрах; осторожная гипотеза допустима одной фразой и только с «похоже» или «вероятно».
- Секторы с 1–2 ответами не обобщай: назови их отдельными историями.
- Не называй организации и не пытайся вычислить конкретных людей.
- Ту же структуру и примерно тот же объём, что в образце (±20%): пять разделов с теми же заголовками и строка-оговорка в конце.
- Формат — только HTML-фрагмент из тегов section, h3, p, ul, li, b и одного <p class="interp-foot"> в конце. Без markdown, без пояснений до или после.`;

/* ---------- очистка ответа модели: только разрешённые теги, без атрибутов ---------- */
const ALLOWED = new Set(["section", "h3", "p", "ul", "li", "b"]);
const escText = (s) => s.replace(/&(?![a-z]+;|#\d+;)/gi, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
function sanitize(html) {
  let out = "", last = 0;
  const re = /<(\/?)([a-z0-9]+)([^<>]*)>/gi;
  let m;
  while ((m = re.exec(html))) {
    out += escText(html.slice(last, m.index));
    last = re.lastIndex;
    const tag = m[2].toLowerCase();
    if (!ALLOWED.has(tag)) continue;
    if (m[1]) out += `</${tag}>`;
    else out += tag === "p" && /class\s*=\s*["']?interp-foot/.test(m[3]) ? `<p class="interp-foot">` : `<${tag}>`;
  }
  out += escText(html.slice(last));
  return out.trim();
}

async function generate(stats) {
  const key = env("ANTHROPIC_API_KEY");
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model: env("PULSE_MODEL") || MODEL_DEFAULT,
      max_tokens: 2000,
      system: SYSTEM,
      messages: [{
        role: "user",
        content: `Образец интерпретации (написан вручную на 12 ответах — ориентир по тону, структуре и объёму, а не по фактам):\n\n${EXAMPLE}\n\nТекущие данные опроса:\n\n${digest(stats)}\n\nНапиши интерпретацию для текущих данных.`,
      }],
    }),
    signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
  });
  const j = await res.json().catch(() => null);
  if (!res.ok || !j) {
    console.error("anthropic error", res.status, j?.error?.type, j?.error?.message);
    return { error: `${res.status} ${j?.error?.type || ""}`.trim() };
  }
  const text = (j.content || []).filter(c => c.type === "text").map(c => c.text).join("").replace(/^```(?:html)?\s*|\s*```$/g, "");
  const html = sanitize(text);
  return html.length > 200 ? { html } : { error: "empty" };
}

function sameOrigin(req) {
  const origin = req.headers.get("origin");
  if (!origin) return false;
  try { return new URL(origin).host === new URL(req.url).host; } catch { return false; }
}

export default async (req) => {
  const store = getStore("pulse-interp");
  const cached = await store.get("current", { type: "json" }).catch(() => null);

  if (req.method === "GET") return json({ ok: true, interp: cached });
  if (req.method !== "POST") return json({ ok: false, code: "bad_request" }, 405);
  if (!sameOrigin(req)) return json({ ok: false, code: "forbidden" }, 403);
  if (!env("ANTHROPIC_API_KEY")) return json({ ok: false, code: "not_configured", interp: cached }, 503);

  const stats = await getStats();
  if (!stats) return json({ ok: false, code: "upstream", interp: cached }, 502);
  const n = (stats.rows || []).length;
  if (cached && cached.n === n) return json({ ok: true, interp: cached, fresh: false });
  if (n === 0) return json({ ok: false, code: "empty" }, 409);

  // суточный лимит: считаем каждый вызов модели (и удачный, и нет) за последние 24 часа
  const limit = Math.max(0, parseInt(env("PULSE_DAILY_LIMIT"), 10) || DAILY_LIMIT_DEFAULT);
  const calls = ((await store.get("calls", { type: "json" }).catch(() => null)) || []).filter(t => Date.now() - t < DAY_MS);
  if (calls.length >= limit) return json({ ok: false, code: "limit", interp: cached }, 429);

  const lock = await store.get("lock", { type: "json" }).catch(() => null);
  const now = Date.now();
  if (lock && now - lock.at < (lock.done ? COOLDOWN_MS : LOCK_MS)) return json({ ok: false, code: "busy", interp: cached }, 429);
  await store.setJSON("lock", { at: now, done: false });
  calls.push(now);
  await store.setJSON("calls", calls);

  let r;
  try { r = await generate(stats); }
  catch (e) { console.error("generate failed", e?.name || e); r = { error: e?.name || "exception" }; }
  await store.setJSON("lock", { at: Date.now(), done: true });
  if (!r.html) return json({ ok: false, code: "llm", detail: r.error, interp: cached }, 502);
  const html = r.html;

  const interp = { n, html, at: Date.now() };
  await store.setJSON("current", interp);
  return json({ ok: true, interp, fresh: true });
};

export const config = { path: "/pulse/interp" };

export const _internal = { sanitize, digest };
