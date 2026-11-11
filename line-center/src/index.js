/*
 * 惠惠聯合診所 LINE 推播中心（Cloudflare Worker）
 * ------------------------------------------------------------
 * - POST /webhook        LINE webhook：員工傳 6 位數綁定碼 → 綁定
 * - POST /api/*          管理者 API（需 Firebase ID token，email 在 ADMIN_EMAILS）
 *
 * 秘密值（由 GitHub Actions 寫入，不在程式碼中）：
 *   LINE_CHANNEL_SECRET, LINE_CHANNEL_ACCESS_TOKEN
 * KV 鍵：
 *   code:{碼}          → {system,id,name,created}
 *   pend:{system}:{id} → 碼
 *   bind:{system}:{id} → {userId,name,displayName,boundAt}
 *   user:{userId}      → [{system,id}]
 *   fail:{userId}      → 錯誤次數（1 小時）
 */

const LINE_API = "https://api.line.me/v2/bot";
const MAX_FAILS = 10;

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    try {
      if (url.pathname === "/webhook" && req.method === "POST") return await webhook(req, env, ctx);
      if (url.pathname.startsWith("/api/")) return await api(req, env, url);
      if (url.pathname === "/") return new Response("hh-line-center ok", { status: 200 });
      return new Response("not found", { status: 404 });
    } catch (e) {
      console.error(e);
      return json({ error: "server_error" }, 500, cors(req, env));
    }
  },
};

/* ---------------- 共用 ---------------- */
const json = (obj, status = 200, headers = {}) =>
  new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json; charset=utf-8", ...headers } });
const list = (s) => String(s || "").split(",").map((x) => x.trim()).filter(Boolean);
function cors(req, env) {
  const o = req.headers.get("origin") || "";
  if (!list(env.ALLOWED_ORIGINS).includes(o)) return {};
  return { "access-control-allow-origin": o, "access-control-allow-headers": "authorization, content-type", "access-control-allow-methods": "POST, OPTIONS", vary: "origin" };
}
const getJ = async (env, k) => { const v = await env.KV.get(k); return v ? JSON.parse(v) : null; };
const putJ = (env, k, v, opt) => env.KV.put(k, JSON.stringify(v), opt);
const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const b64urlToBytes = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));
const toHalf = (s) => String(s || "").replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0)).replace(/\s+/g, "");
const validKey = (s) => typeof s === "string" && /^[a-z0-9_-]{1,40}$/i.test(s);

async function lineFetch(env, path, body, extraHeaders = {}) {
  const r = await fetch(LINE_API + path, {
    method: "POST",
    headers: { authorization: `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}`, "content-type": "application/json", ...extraHeaders },
    body: JSON.stringify(body),
  });
  let detail = null;
  if (!r.ok) { try { detail = await r.json(); } catch (e) { detail = await r.text().catch(() => null); } }
  return { ok: r.ok, status: r.status, detail };
}
const reply = (env, token, text) => lineFetch(env, "/message/reply", { replyToken: token, messages: [{ type: "text", text }] });

/* ---------------- LINE webhook ---------------- */
async function verifyLineSignature(env, body, sig) {
  if (!sig || !env.LINE_CHANNEL_SECRET) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(env.LINE_CHANNEL_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = b64(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)));
  return mac.length === sig.length && crypto.subtle.timingSafeEqual
    ? crypto.subtle.timingSafeEqual(new TextEncoder().encode(mac), new TextEncoder().encode(sig))
    : mac === sig;
}

async function webhook(req, env, ctx) {
  const body = await req.text();
  if (!(await verifyLineSignature(env, body, req.headers.get("x-line-signature")))) return new Response("bad signature", { status: 401 });
  const { events = [] } = JSON.parse(body || "{}");
  for (const ev of events) {
    if (ev.type !== "message" || ev.message?.type !== "text" || !ev.source?.userId || !ev.replyToken) continue;
    const userId = ev.source.userId, text = toHalf(ev.message.text);
    if (/^\d{6}$/.test(text)) {
      ctx.waitUntil(handleCode(env, userId, text, ev.replyToken));
    } else {
      const mine = (await getJ(env, "user:" + userId)) || [];
      ctx.waitUntil(reply(env, ev.replyToken, mine.length
        ? "這個帳號只用來傳送薪資單，不會回覆訊息。如有問題請直接洽院方。"
        : "請傳送院方給您的「6 位數綁定碼」完成綁定。"));
    }
  }
  return new Response("ok");
}

async function handleCode(env, userId, code, replyToken) {
  const failKey = "fail:" + userId;
  const fails = +(await env.KV.get(failKey)) || 0;
  if (fails >= MAX_FAILS) return reply(env, replyToken, "嘗試次數太多，請一小時後再試，或洽院方重新取得綁定碼。");
  const c = await getJ(env, "code:" + code);
  if (!c) {
    await env.KV.put(failKey, String(fails + 1), { expirationTtl: 3600 });
    return reply(env, replyToken, "綁定碼不正確，請再確認一次。");
  }
  let displayName = "";
  try {
    const p = await fetch(`${LINE_API}/profile/${userId}`, { headers: { authorization: `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}` } });
    if (p.ok) displayName = (await p.json()).displayName || "";
  } catch (e) {}
  // 若這個人原本綁別的 LINE，先移除舊的對照
  const old = await getJ(env, `bind:${c.system}:${c.id}`);
  if (old && old.userId !== userId) await removeUserLink(env, old.userId, c.system, c.id);
  await putJ(env, `bind:${c.system}:${c.id}`, { userId, name: c.name, displayName, boundAt: new Date().toISOString() });
  const mine = ((await getJ(env, "user:" + userId)) || []).filter((x) => !(x.system === c.system && x.id === c.id));
  mine.push({ system: c.system, id: c.id });
  await putJ(env, "user:" + userId, mine);
  await env.KV.delete("code:" + code);
  await env.KV.delete(`pend:${c.system}:${c.id}`);
  await env.KV.delete(failKey);
  return reply(env, replyToken, `綁定完成 ✓\n${c.name} 您好，之後每月的薪資單會傳到這裡，只有您本人看得到。`);
}

async function removeUserLink(env, userId, system, id) {
  const mine = ((await getJ(env, "user:" + userId)) || []).filter((x) => !(x.system === system && x.id === id));
  if (mine.length) await putJ(env, "user:" + userId, mine); else await env.KV.delete("user:" + userId);
}

/* ---------------- 管理者驗證（Firebase ID token） ---------------- */
let jwkCache = { at: 0, keys: [] };
async function googleKeys() {
  if (Date.now() - jwkCache.at < 3600e3 && jwkCache.keys.length) return jwkCache.keys;
  const r = await fetch("https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com");
  jwkCache = { at: Date.now(), keys: (await r.json()).keys || [] };
  return jwkCache.keys;
}
export async function verifyFirebaseToken(token, env, keysFn = googleKeys) {
  const parts = String(token || "").split(".");
  if (parts.length !== 3) return null;
  const header = JSON.parse(new TextDecoder().decode(b64urlToBytes(parts[0])));
  const claims = JSON.parse(new TextDecoder().decode(b64urlToBytes(parts[1])));
  if (header.alg !== "RS256") return null;
  const jwk = (await keysFn()).find((k) => k.kid === header.kid);
  if (!jwk) return null;
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64urlToBytes(parts[2]), new TextEncoder().encode(parts[0] + "." + parts[1]));
  if (!ok) return null;
  const now = Math.floor(Date.now() / 1000);
  if (!list(env.ALLOWED_PROJECTS).includes(claims.aud)) return null;
  if (claims.iss !== "https://securetoken.google.com/" + claims.aud) return null;
  if (!(claims.exp > now) || !(claims.iat <= now + 60)) return null;
  const email = String(claims.email || "").toLowerCase();
  const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(email)))].map((x) => x.toString(16).padStart(2, "0")).join("");
  if (!list(env.ADMIN_EMAILS).map((e) => e.toLowerCase()).includes(email) && !list(env.ADMIN_EMAIL_HASHES).includes(hash)) return null;
  return claims;
}

/* ---------------- 管理者 API ---------------- */
async function newCode(env) {
  for (let i = 0; i < 20; i++) {
    const n = crypto.getRandomValues(new Uint32Array(1))[0] % 1000000;
    const c = String(n).padStart(6, "0");
    if (!(await env.KV.get("code:" + c))) return c;
  }
  throw new Error("code_exhausted");
}
async function issueCode(env, system, id, name) {
  const old = await env.KV.get(`pend:${system}:${id}`);
  if (old) await env.KV.delete("code:" + old);
  const c = await newCode(env);
  await putJ(env, "code:" + c, { system, id, name, created: new Date().toISOString() });
  await env.KV.put(`pend:${system}:${id}`, c);
  return c;
}

async function api(req, env, url) {
  const h = cors(req, env);
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: h });
  if (req.method !== "POST") return json({ error: "method" }, 405, h);
  const claims = await verifyFirebaseToken((req.headers.get("authorization") || "").replace(/^Bearer\s+/i, ""), env);
  if (!claims) return json({ error: "unauthorized" }, 401, h);
  const b = await req.json().catch(() => ({}));
  const sys = b.system;
  const needSys = () => { if (!validKey(sys)) throw Object.assign(new Error("bad system"), { status: 400 }); };

  try {
    switch (url.pathname) {
      case "/api/me":
        return json({ email: claims.email, project: claims.aud }, 200, h);

      case "/api/status": {
        needSys();
        const out = [];
        for (const p of b.people || []) {
          if (!validKey(p.id)) continue;
          const bind = await getJ(env, `bind:${sys}:${p.id}`);
          let code = bind ? null : await env.KV.get(`pend:${sys}:${p.id}`);
          if (!bind && !code && b.ensureCodes) code = await issueCode(env, sys, p.id, String(p.name || p.id).slice(0, 20));
          out.push({ id: p.id, bound: !!bind, displayName: bind?.displayName || "", boundAt: bind?.boundAt || null, code });
        }
        return json({ people: out }, 200, h);
      }

      case "/api/regen": {
        needSys(); if (!validKey(b.id)) return json({ error: "bad id" }, 400, h);
        return json({ code: await issueCode(env, sys, b.id, String(b.name || b.id).slice(0, 20)) }, 200, h);
      }

      case "/api/unbind": {
        needSys(); if (!validKey(b.id)) return json({ error: "bad id" }, 400, h);
        const bind = await getJ(env, `bind:${sys}:${b.id}`);
        if (bind) { await removeUserLink(env, bind.userId, sys, b.id); await env.KV.delete(`bind:${sys}:${b.id}`); }
        return json({ ok: true }, 200, h);
      }

      case "/api/validate": {
        const r = await lineFetch(env, "/message/validate/push", { messages: b.messages || [] });
        return json({ ok: r.ok, status: r.status, detail: r.detail }, 200, h);
      }

      case "/api/push": {
        needSys();
        const results = [];
        for (const it of b.items || []) {
          if (!validKey(it.id)) { results.push({ id: it.id, ok: false, error: "bad id" }); continue; }
          const bind = await getJ(env, `bind:${sys}:${it.id}`);
          if (!bind) { results.push({ id: it.id, ok: false, error: "not_bound" }); continue; }
          const r = await lineFetch(env, "/message/push", { to: bind.userId, messages: it.messages }, { "X-Line-Retry-Key": it.retryKey || crypto.randomUUID() });
          results.push({ id: it.id, ok: r.ok || r.status === 409, status: r.status, detail: r.ok ? null : r.detail });
        }
        // 推播結果通知給管理者（system "_admin" 底下已綁定的人）
        let notified = 0;
        if (typeof b.notify === "string" && b.notify.trim()) {
          let cursor;
          do {
            const page = await env.KV.list({ prefix: "bind:_admin:", cursor });
            for (const k of page.keys) {
              const w = await getJ(env, k.name);
              if (!w) continue;
              const r = await lineFetch(env, "/message/push", { to: w.userId, messages: [{ type: "text", text: b.notify.slice(0, 4900) }] });
              if (r.ok) notified++;
            }
            cursor = page.list_complete ? null : page.cursor;
          } while (cursor);
        }
        return json({ results, notified }, 200, h);
      }

      case "/api/quota": {
        const [q, u] = await Promise.all([
          fetch(`${LINE_API}/message/quota`, { headers: { authorization: `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}` } }).then((r) => r.json()).catch(() => null),
          fetch(`${LINE_API}/message/quota/consumption`, { headers: { authorization: `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}` } }).then((r) => r.json()).catch(() => null),
        ]);
        return json({ quota: q, used: u }, 200, h);
      }
    }
    return json({ error: "not found" }, 404, h);
  } catch (e) {
    return json({ error: e.message || "error" }, e.status || 500, h);
  }
}
