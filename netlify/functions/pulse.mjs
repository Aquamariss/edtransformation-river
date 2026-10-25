// «Пульс реки» — прокси между страницей /pulse и Google Apps Script.
//
// Переменные окружения Netlify:
//   PULSE_SCRIPT_URL — адрес веб-приложения Apps Script (…/exec)
//   PULSE_SECRET     — ключ из меню таблицы «Пульс → Показать ключ для Netlify»
//
// GET  /pulse/api?part=token  → одноразовая метка времени формы (не кешируется)
// GET  /pulse/api?part=stats  → анонимные данные для графика (кеш 15 с)
// POST /pulse/api             → ответ на опрос

import { createHmac, timingSafeEqual } from "node:crypto";

const MIN_FILL_MS = 8_000;            // быстрее человек форму не заполнит
const MAX_TOKEN_AGE_MS = 3 * 3600_000;
const MAX_BODY = 8_000;               // байт
const STATS_TTL_MS = 15_000;
const UPSTREAM_TIMEOUT_MS = 9_500;

let statsCache = { at: 0, data: null };

const env = (k) => (globalThis.Netlify?.env?.get?.(k)) ?? process.env[k];

function hmac(secret, label, value) {
  return createHmac("sha256", secret).update(`${label}:${value}`).digest("base64url");
}

function json(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      ...extra,
    },
  });
}

function makeToken(secret, now = Date.now()) {
  const ts = now.toString(36);
  return `${ts}.${hmac(secret, "t", ts).slice(0, 32)}`;
}

function checkToken(secret, token, now = Date.now()) {
  if (typeof token !== "string" || token.length > 64) return "bad";
  const [ts, sig] = token.split(".");
  if (!ts || !sig) return "bad";
  const expected = hmac(secret, "t", ts).slice(0, 32);
  const a = Buffer.from(sig), b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return "bad";
  const age = now - parseInt(ts, 36);
  if (!Number.isFinite(age) || age < 0) return "bad";
  if (age < MIN_FILL_MS) return "early";
  if (age > MAX_TOKEN_AGE_MS) return "expired";
  return "ok";
}

async function callScript(payload) {
  const url = env("PULSE_SCRIPT_URL");
  const secret = env("PULSE_SECRET");
  if (!url || !secret) return { ok: false, code: "not_configured" };
  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...payload, secret }),
      redirect: "follow",
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
  } catch (e) {
    console.error("upstream fetch failed", e?.name || e);
    return { ok: false, code: "upstream" };
  }
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    // HTML вместо JSON — чаще всего веб-приложение опубликовано не для «Все»
    console.error("upstream non-JSON", res.status, text.slice(0, 200));
    return { ok: false, code: "upstream" };
  }
}

async function getStats({ fresh = false } = {}) {
  if (!fresh && statsCache.data && Date.now() - statsCache.at < STATS_TTL_MS) return statsCache.data;
  const r = await callScript({ action: "stats" });
  if (r.ok && r.stats) statsCache = { at: Date.now(), data: r.stats };
  return r.ok ? r.stats : null;
}

function sameOrigin(req) {
  const origin = req.headers.get("origin");
  if (!origin) return false;
  try {
    return new URL(origin).host === new URL(req.url).host;
  } catch {
    return false;
  }
}

const STATUS = {
  invalid: 400, bad_request: 400, forbidden: 502, not_configured: 503, upstream: 502, server_error: 502,
  limit_device: 429, limit_ip: 429, paused: 429, busy: 503, closed: 403,
};

export default async (req, context) => {
  const secret = env("PULSE_SECRET");
  if (!secret) return json({ ok: false, code: "not_configured" }, 503);
  const url = new URL(req.url);

  if (req.method === "GET") {
    const part = url.searchParams.get("part");
    if (part === "token") return json({ ok: true, token: makeToken(secret) });
    if (part === "stats") {
      const stats = await getStats();
      if (!stats) return json({ ok: false, code: "upstream" }, 502);
      return json({ ok: true, stats }, 200, {
        "cache-control": "public, max-age=0, must-revalidate",
        "netlify-cdn-cache-control": "public, durable, s-maxage=15, stale-while-revalidate=45",
      });
    }
    return json({ ok: false, code: "bad_request" }, 400);
  }

  if (req.method !== "POST") return json({ ok: false, code: "bad_request" }, 405, { allow: "GET, POST" });
  if (!sameOrigin(req)) return json({ ok: false, code: "forbidden" }, 403);

  const raw = await req.text();
  if (raw.length > MAX_BODY) return json({ ok: false, code: "invalid" }, 413);
  let body;
  try { body = JSON.parse(raw); } catch { return json({ ok: false, code: "bad_request" }, 400); }
  if (!body || typeof body !== "object") return json({ ok: false, code: "bad_request" }, 400);

  // honeypot: делаем вид, что всё хорошо, но ничего не пишем
  if (typeof body.website === "string" && body.website.trim() !== "") {
    return json({ ok: true, remaining: 0, stats: await getStats() });
  }

  const t = checkToken(secret, body.token);
  if (t === "early") return json({ ok: false, code: "too_fast" }, 429);
  if (t !== "ok") return json({ ok: false, code: "token" }, 400);

  const device = typeof body.device === "string" && /^[A-Za-z0-9-]{8,64}$/.test(body.device) ? body.device : null;
  if (!device) return json({ ok: false, code: "bad_request" }, 400);

  const ip = context?.ip || req.headers.get("x-nf-client-connection-ip") || req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";

  const r = await callScript({
    action: "submit",
    ipHash: hmac(secret, "ip", ip).slice(0, 24),
    deviceHash: hmac(secret, "dev", device).slice(0, 24),
    data: body.data,
  });
  if (r.ok && r.stats) statsCache = { at: Date.now(), data: r.stats };
  if (!r.ok) return json({ ok: false, code: r.code || "upstream", field: r.field }, STATUS[r.code] || 502);
  return json({ ok: true, remaining: r.remaining, flagged: !!r.flagged, stats: r.stats });
};

export const config = { path: "/pulse/api" };

// для тестов
export const _internal = { makeToken, checkToken, resetCache: () => (statsCache = { at: 0, data: null }) };
