/*
 * 惠惠聯合診所 LINE 推播中心（Cloudflare Worker）
 * ------------------------------------------------------------
 * - POST /webhook        LINE webhook：員工傳 6 位數綁定碼 → 綁定
 * - POST /api/*          管理者 API（需 Firebase ID token，email 在 ADMIN_EMAILS）
 * - POST /api/liff-login 員工從 LINE（LIFF）打開填單頁 → 換 Firebase custom token（不需密碼）
 * - 排程（每天 16:00 台灣時間）：
 *     兩邊統一：每月 1 號推「上個月」的填單，截止日（5 號；內科可在 meta/settings.closeDay 改）前一天提醒還沒填的人
 *
 * 秘密值（由 GitHub Actions 寫入，不在程式碼中）：
 *   LINE_CHANNEL_SECRET, LINE_CHANNEL_ACCESS_TOKEN
 *   FIREBASE_SA_YUN_SALARY   yun-salary 的 Firebase 服務帳號 JSON（簽 custom token 用）
 *   FIREBASE_SA_HUITENG      huiteng-payroll-ddef6 的 Firebase 服務帳號 JSON
 * 公開設定（wrangler.toml [vars]）：LINE_LOGIN_CHANNEL_ID_HUIYUN／_HUITENG（兩個 LINE Login channel）, LIFF_ID_HUIYUN, LIFF_ID_HUITENG
 * 還沒設定 LIFF ID 時，推播按鈕直接開填單網址（員工用密碼登入）
 * KV 鍵：
 *   code:{碼}          → {system,id,name,created}
 *   pend:{system}:{id} → 碼
 *   bind:{system}:{id} → {userId,name,displayName,boundAt}
 *   user:{userId}      → [{system,id}]
 *   fail:{userId}      → 錯誤次數（1 小時）
 *   fbrun:{system}:{YYYYMM}:{open|remind} → 排程已執行的紀錄（避免重複推播）
 */

const LINE_API = "https://api.line.me/v2/bot";
const MAX_FAILS = 10;

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    try {
      if (url.pathname === "/webhook" && req.method === "POST") return await webhook(req, env, ctx);
      if (url.pathname === "/api/liff-login") return await liffLogin(req, env);
      if (url.pathname.startsWith("/api/")) return await api(req, env, url);
      if (url.pathname === "/") return new Response("hh-line-center ok", { status: 200 });
      return new Response("not found", { status: 404 });
    } catch (e) {
      console.error(e);
      return json({ error: "server_error" }, 500, cors(req, env));
    }
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(feedbackCron(env, new Date(event.scheduledTime)));
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
        const notified = typeof b.notify === "string" && b.notify.trim() ? await notifyAdmins(env, b.notify) : 0;
        return json({ results, notified }, 200, h);
      }

      case "/api/feedback-push": {
        // 手動推播／補推回饋單（排程用的是同一個流程）；dryRun 只列名單不送出
        if (!FEEDBACK[sys]) return json({ error: "bad system" }, 400, h);
        if (!/^\d{6}$/.test(b.month || "")) return json({ error: "bad month" }, 400, h);
        const kind = b.kind === "remind" ? "remind" : "open";
        return json(await feedbackPush(env, sys, b.month, kind, { dryRun: !!b.dryRun, notify: !b.dryRun && b.notify !== false }), 200, h);
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

async function notifyAdmins(env, text) {
  let notified = 0, cursor;
  do {
    const page = await env.KV.list({ prefix: "bind:_admin:", cursor });
    for (const k of page.keys) {
      const w = await getJ(env, k.name);
      if (!w) continue;
      const r = await lineFetch(env, "/message/push", { to: w.userId, messages: [{ type: "text", text: String(text).slice(0, 4900) }] });
      if (r.ok) notified++;
    }
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor);
  return notified;
}

/* ================================================================
 * 每月回饋單（LINE 推播 ＋ LIFF 免密碼登入）
 * ================================================================ */
// 兩邊共用的時程：每月 1 號推上個月；截止日（預設 5 號）前一天提醒
const closeDayOf = (settings = {}) => Math.min(28, Math.max(2, +settings.closeDay || 5));
const dueOf = (m, settings) => `${m === 12 ? 1 : m + 1}/${closeDayOf(settings)}`;
function monthlyJobs(today, settings) {
  const j = [], d = today.getUTCDate(), month = prevYm(ymOf(today));
  if (d === 1) j.push({ kind: "open", month });
  if (d === closeDayOf(settings) - 1) j.push({ kind: "remind", month });
  return j;
}

const FEEDBACK = {
  huiyun: {
    project: "yun-salary", clinic: "惠韻牙醫診所", liffVar: "LIFF_ID_HUIYUN", channelVar: "LINE_LOGIN_CHANNEL_ID_HUIYUN", saVar: "FIREBASE_SA_YUN_SALARY",
    formUrl: "https://urbanhsu.github.io/yun_salary/form.html",
    rosterPath: "meta/roster", statusPath: (m) => `formStatus/${m}`,
    theme: { head: "#F7B4A7", sub: "#7A3B30", title: "#4A2520", btn: "#E0705F" },
    // 1 號推上個月回饋單；截止日（5 號）前一天提醒
    jobs: (today, tomorrow, settings) => monthlyJobs(today, settings),
    text({ m, kind, name, settings }) {
      const due = dueOf(m, settings);
      return {
        title: `${m} 月回饋單`,
        alt: kind === "remind" ? `提醒：${m} 月回饋單還沒填` : `${m} 月回饋單開放填寫`,
        body: kind === "remind"
          ? `${name ? name + "，" : ""}${m} 月回饋單還沒填喔！截止日是 ${due}，請抽空完成，謝謝 🙏`
          : `${name ? name + "，" : ""}${m} 月辛苦了！請在 ${due} 前花幾分鐘填寫 ${m} 月回饋單。`,
      };
    },
  },
  huiteng: {
    project: "huiteng-payroll-ddef6", clinic: "惠騰內科診所", liffVar: "LIFF_ID_HUITENG", channelVar: "LINE_LOGIN_CHANNEL_ID_HUITENG", saVar: "FIREBASE_SA_HUITENG",
    formUrl: "https://urbanhsu.github.io/huiteng-payroll/",
    rosterPath: "meta/roster", statusPath: (m) => `status/${m}`, settingsPath: "meta/settings",
    theme: { head: "#CFE8D5", sub: "#2F5E40", title: "#1F3D2A", btn: "#4E9A6A" },
    // 1 號推上個月報表；截止日前一天提醒
    jobs: (today, tomorrow, settings) => monthlyJobs(today, settings),
    text({ m, kind, name, settings }) {
      const due = dueOf(m, settings);
      return {
        title: `${m} 月份報表`,
        alt: kind === "remind" ? `提醒：${m} 月份報表還沒填` : `${m} 月份報表開放填寫`,
        body: kind === "remind"
          ? `${name ? name + "，" : ""}${m} 月份報表還沒填喔！截止日是 ${due}，請抽空完成，謝謝 🙏`
          : `${name ? name + "，" : ""}${m} 月辛苦了！請在 ${due} 前完成 ${m} 月份報表。`,
      };
    },
  },
};

/* --- 時間（台灣時間 UTC+8） --- */
const tpe = (d) => new Date(d.getTime() + 8 * 3600e3); // 之後只用 getUTC* 讀
const ymOf = (t) => `${t.getUTCFullYear()}${String(t.getUTCMonth() + 1).padStart(2, "0")}`;
const prevYm = (ym) => { const y = +ym.slice(0, 4), m = +ym.slice(4); return m === 1 ? `${y - 1}12` : `${y}${String(m - 1).padStart(2, "0")}`; };

export async function feedbackCron(env, now = new Date()) {
  const today = tpe(now), tomorrow = tpe(new Date(now.getTime() + 86400e3));
  const out = [];
  for (const [sys, cfg] of Object.entries(FEEDBACK)) {
    let settings = {};
    if (cfg.settingsPath) { try { settings = await fsGet(cfg.project, cfg.settingsPath); } catch (e) { console.error(e); } }
    for (const job of cfg.jobs(today, tomorrow, settings)) {
    const runKey = `fbrun:${sys}:${job.month}:${job.kind}`;
    if (await env.KV.get(runKey)) { out.push({ sys, ...job, skipped: "already_ran" }); continue; }
    const r = await feedbackPush(env, sys, job.month, job.kind, { notify: true });
    if (!r.error) await env.KV.put(runKey, new Date().toISOString(), { expirationTtl: 86400 * 40 });
    out.push({ sys, ...job, ...r });
    }
  }
  if (out.length) console.log(JSON.stringify(out));
  return out;
}

/* --- Firestore 公開文件（meta/roster、formStatus/YYYYMM）免金鑰讀取 --- */
function fsVal(v) {
  if (!v || typeof v !== "object") return null;
  if ("stringValue" in v) return v.stringValue;
  if ("booleanValue" in v) return v.booleanValue;
  if ("integerValue" in v) return +v.integerValue;
  if ("doubleValue" in v) return v.doubleValue;
  if ("nullValue" in v) return null;
  if ("arrayValue" in v) return (v.arrayValue.values || []).map(fsVal);
  if ("mapValue" in v) return fsFields(v.mapValue.fields);
  return null;
}
const fsFields = (f = {}) => Object.fromEntries(Object.entries(f).map(([k, v]) => [k, fsVal(v)]));
async function fsGet(project, path) {
  const r = await fetch(`https://firestore.googleapis.com/v1/projects/${project}/databases/(default)/documents/${path}`);
  if (r.status === 404) return {};
  if (!r.ok) throw new Error(`firestore ${path} ${r.status}`);
  return fsFields((await r.json()).fields);
}

/* --- 推播 --- */
async function retryKeyFor(s) { // 同一人同一份同一種推播 → 固定的 UUID，LINE 會擋掉重複
  const h = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)))].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export function feedbackFlex({ sys, month, kind, url, name, settings = {} }) {
  const cfg = FEEDBACK[sys], c = cfg.theme;
  const { title, alt, body: text } = cfg.text({ m: +month.slice(4), kind, name, settings });
  return {
    type: "flex",
    altText: alt,
    contents: {
      type: "bubble", size: "kilo",
      header: { type: "box", layout: "vertical", backgroundColor: c.head, paddingAll: "16px", contents: [
        { type: "text", text: kind === "remind" ? "小提醒" : cfg.clinic, size: "xs", color: c.sub },
        { type: "text", text: title, size: "xl", weight: "bold", color: c.title, margin: "xs" },
      ] },
      body: { type: "box", layout: "vertical", paddingAll: "16px", contents: [
        { type: "text", text, wrap: true, size: "sm", color: "#555555" },
      ] },
      footer: { type: "box", layout: "vertical", paddingAll: "12px", contents: [
        { type: "button", style: "primary", color: c.btn, height: "sm", action: { type: "uri", label: "開始填寫", uri: url } },
      ] },
    },
  };
}

export async function feedbackPush(env, sys, month, kind, { dryRun = false, notify = true } = {}) {
  const cfg = FEEDBACK[sys];
  const liff = env[cfg.liffVar];
  // 有 LIFF 就用 LINE 免密碼登入；還沒設定時直接開填單網址（密碼登入）
  const url = liff ? `https://liff.line.me/${liff}?m=${month}` : `${cfg.formUrl}?m=${month}`;
  let roster, submitted = {}, settings = {};
  try {
    roster = (await fsGet(cfg.project, cfg.rosterPath)).people || [];
    if (kind === "remind") submitted = (await fsGet(cfg.project, cfg.statusPath(month))).submitted || {};
    if (cfg.settingsPath) settings = await fsGet(cfg.project, cfg.settingsPath);
  } catch (e) {
    console.error(e);
    return { error: "firestore_unreachable" };
  }
  if (!roster.length) return { error: "empty_roster" };
  const sent = [], failed = [], notBound = [], done = [];
  for (const p of roster) {
    if (!p || !validKey(p.id)) continue;
    if (kind === "remind" && submitted[p.id]) { done.push(p.name); continue; }
    const bind = await getJ(env, `bind:${sys}:${p.id}`);
    if (!bind) { notBound.push(p.name); continue; }
    if (dryRun) { sent.push(p.name); continue; }
    const r = await lineFetch(env, "/message/push",
      { to: bind.userId, messages: [feedbackFlex({ sys, month, kind, url, name: p.name, settings })] },
      { "X-Line-Retry-Key": await retryKeyFor(`fb:${sys}:${month}:${kind}:${p.id}`) });
    (r.ok || r.status === 409 ? sent : failed).push(p.name);
  }
  const t = cfg.text({ m: +month.slice(4), kind, name: "", settings }).title;
  let msg;
  if (kind === "open") {
    msg = `${cfg.clinic} ${t}已推播（${sent.length}/${roster.length}）`;
  } else {
    msg = sent.length || failed.length
      ? `${cfg.clinic} ${t}提醒：已提醒 ${sent.join("、") || "—"}`
      : `${cfg.clinic} ${t}大家都填好了 ✓`;
  }
  if (failed.length) msg += `\n送出失敗：${failed.join("、")}`;
  if (notBound.length) msg += `\n沒綁 LINE：${notBound.join("、")}`;
  const notified = notify && !dryRun ? await notifyAdmins(env, msg) : 0;
  return { month, kind, url, sent, failed, notBound, done, notified, message: msg };
}

/* --- LIFF 登入：LINE ID token → Firebase custom token --- */
const b64urlBytes = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const b64urlJSON = (o) => b64urlBytes(new TextEncoder().encode(JSON.stringify(o)));

export async function firebaseCustomToken(saJson, uid, claims, now = Math.floor(Date.now() / 1000)) {
  const sa = typeof saJson === "string" ? JSON.parse(saJson) : saJson;
  const der = Uint8Array.from(atob(String(sa.private_key).replace(/-----[^-]+-----/g, "").replace(/\s+/g, "")), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey("pkcs8", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const head = b64urlJSON({ alg: "RS256", typ: "JWT" });
  const body = b64urlJSON({
    iss: sa.client_email, sub: sa.client_email,
    aud: "https://identitytoolkit.googleapis.com/google.identity.identitytoolkit.v1.IdentityToolkit",
    iat: now, exp: now + 3600, uid, claims,
  });
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(head + "." + body));
  return `${head}.${body}.${b64urlBytes(sig)}`;
}

async function liffLogin(req, env) {
  const h = cors(req, env);
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: h });
  if (req.method !== "POST") return json({ error: "method" }, 405, h);
  const b = await req.json().catch(() => ({}));
  const cfg = FEEDBACK[b.system];
  if (!cfg) return json({ error: "bad_system" }, 400, h);
  const sa = env[cfg.saVar], channel = String(env[cfg.channelVar] || "");
  if (!channel || !sa) return json({ error: "not_configured" }, 503, h);
  if (typeof b.idToken !== "string" || !b.idToken) return json({ error: "invalid_token" }, 401, h);

  const v = await fetch("https://api.line.me/oauth2/v2.1/verify", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ id_token: b.idToken, client_id: channel }),
  });
  const vj = v.ok ? await v.json().catch(() => null) : null;
  if (!vj || !vj.sub || String(vj.aud) !== channel) return json({ error: "invalid_token" }, 401, h);

  const link = ((await getJ(env, "user:" + vj.sub)) || []).find((x) => x.system === b.system);
  const bind = link && (await getJ(env, `bind:${b.system}:${link.id}`));
  if (!bind || bind.userId !== vj.sub) return json({ error: "not_bound" }, 403, h);

  const id = String(link.id).toLowerCase();
  let name = bind.name || id;
  try { // 已離職（不在填單名單上）就不放行
    const roster = (await fsGet(cfg.project, cfg.rosterPath)).people || [];
    const p = roster.find((x) => x && String(x.id).toLowerCase() === id);
    if (roster.length && !p) return json({ error: "not_active" }, 403, h);
    if (p?.name) name = p.name;
  } catch (e) { /* 名單暫時讀不到就照綁定資料 */ }

  let saObj;
  try { saObj = JSON.parse(sa); } catch (e) { return json({ error: "not_configured" }, 503, h); }
  if (saObj.project_id && saObj.project_id !== cfg.project) return json({ error: "not_configured" }, 503, h);
  const token = await firebaseCustomToken(saObj, `${b.system}_${id}`, { staffId: id, sys: b.system });
  return json({ token, id, name }, 200, h);
}
