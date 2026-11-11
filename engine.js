/*
 * 惠騰薪資計算核心（純計算，無 DOM、無 Firebase）
 * ------------------------------------------------------------
 * 所有與診所、人員相關的數字（底薪、加給、比例、貢獻度、個人獎金規則）
 * 都來自 params（存在 Firestore，只有管理者可讀），這支程式只放通用演算法。
 * 規則說明見 docs/RULES.md。
 */

/** 四捨五入到整數（0.5 進位，負數對稱） */
export function roundHalfUp(x) {
  const r = Math.round(Math.abs(x) + 1e-9);
  return x < 0 ? -r : r;
}

const sum = (a) => a.reduce((s, v) => s + v, 0);

/** 合併所有人填的業績數字，再套用管理者覆寫 */
export function collectMetrics(subs, override = {}) {
  const m = {};
  for (const id of Object.keys(subs || {})) Object.assign(m, (subs[id] && subs[id].metrics) || {});
  for (const k of Object.keys(override || {})) if (override[k] != null && override[k] !== "") m[k] = +override[k];
  return m;
}

/** 某人請假那幾診的看診人次合計 */
export function leaveVisitsOf(att, sessionVisits) {
  let t = 0;
  for (const l of (att && att.absences) || []) {
    if (!l.date) continue;
    for (const s of l.slots || []) t += +((sessionVisits || {})[l.date + "|" + s] || 0);
  }
  return t;
}

/** 列出本月所有「有人不在」的診次（後台要填人次的清單） */
export function absentSessions(people, subs) {
  const map = {};
  for (const p of people) {
    const att = (subs[p.id] && subs[p.id].att) || {};
    for (const l of att.absences || []) {
      if (!l.date) continue;
      for (const s of l.slots || []) {
        const k = l.date + "|" + s;
        (map[k] = map[k] || { key: k, date: l.date, slot: s, who: [] }).who.push(p.name + (l.note ? `（${l.note}）` : ""));
      }
    }
  }
  return Object.values(map).sort((a, b) => a.key.localeCompare(b.key));
}

/**
 * 互評占比
 * - 每位評者：把他在所有互評項目給出的分數合在一起，算平均與「母體」標準差
 * - z = (分數 − 平均) ÷ 標準差 + 5；標準差為 0 時 z = 5；空白不計
 * - 每項：參與者的 z 加總 → 占比；再做最低保障（重複套用直到沒人低於下限）
 */
export function peerShares(params, subs, members, opts = {}) {
  const peerItems = params.items.filter((it) => it.peerPct > 0);
  const ids = members.map((p) => p.id);
  const stats = {};
  for (const r of ids) {
    const peer = (subs[r] && subs[r].peer) || {};
    const vals = [];
    for (const ratee of Object.keys(peer)) {
      if (ratee === r) continue;
      for (const it of peerItems) {
        if (opts.directScores && opts.directScores[it.key]) continue; // 管理者直接給分的項目不列入評者統計
        const v = peer[ratee] && peer[ratee][it.key];
        if (typeof v === "number" && !isNaN(v)) vals.push(v);
      }
    }
    if (!vals.length) continue;
    const mu = sum(vals) / vals.length;
    const sd = Math.sqrt(sum(vals.map((v) => (v - mu) ** 2)) / vals.length);
    stats[r] = { mean: mu, sd, n: vals.length };
  }
  const shares = {}, raw = {};
  for (const it of peerItems) {
    const parts = ids.filter((id) => !(it.exclude || []).includes(id));
    const direct = opts.directScores && opts.directScores[it.key];
    const tot = {};
    if (direct) {
      for (const id of parts) tot[id] = +direct[id] || 0;
    } else {
      for (const id of parts) tot[id] = 0;
      for (const r of Object.keys(stats)) {
        const peer = subs[r].peer || {};
        for (const id of parts) {
          if (id === r) continue;
          const v = peer[id] && peer[id][it.key];
          if (typeof v !== "number" || isNaN(v)) continue;
          const { mean, sd } = stats[r];
          tot[id] += sd > 0 ? (v - mean) / sd + 5 : 5;
        }
      }
    }
    const s = sum(Object.values(tot));
    const sh = {};
    for (const id of parts) sh[id] = s > 0 ? tot[id] / s : 1 / parts.length;
    raw[it.key] = { ...sh };
    const floor = direct ? 0 : it.floor ?? 0;
    if (floor > 0) {
      for (let guard = 0; guard < 100; guard++) {
        const low = parts.filter((id) => sh[id] < floor - 1e-12);
        if (!low.length) break;
        const deficit = sum(low.map((id) => floor - sh[id]));
        low.forEach((id) => (sh[id] = floor));
        const hi = parts.filter((id) => sh[id] > floor + 1e-12);
        const ht = sum(hi.map((id) => sh[id]));
        if (ht <= 0) break;
        hi.forEach((id) => (sh[id] -= (deficit * sh[id]) / ht));
      }
    }
    shares[it.key] = sh;
  }
  return { stats, raw, shares };
}

/**
 * 主計算
 * @param params  人員與規則參數（Firestore admin/params）
 * @param month   本月管理者輸入（Firestore months/{YYYYMM}）
 * @param subs    員工填報 { id: {peer, att, metrics} }
 */
export function computePayroll(params, month, subs) {
  month = month || {};
  subs = subs || {};
  const people = params.people;
  const pool = people.filter((p) => p.inPool);
  const metrics = collectMetrics(subs, month.metricsOverride);
  const T = +month.totalVisits || 0;
  const flags = { ...(params.flags || {}), ...(month.flags || {}) };

  // 出勤：本人填報，管理者可覆寫
  const attOf = (id) => ({ ...((subs[id] && subs[id].att) || {}), ...((month.attOverride || {})[id] || {}) });
  const leaveVisits = {}, rate = {};
  for (const p of people) {
    const ov = (month.leaveVisitsOverride || {})[p.id];
    leaveVisits[p.id] = ov != null && ov !== "" ? +ov : leaveVisitsOf(attOf(p.id), month.sessionVisits);
    rate[p.id] = T > 0 ? (T - leaveVisits[p.id]) / T : 1;
  }

  // ---- 自費獎金池 ----
  const directScores = {};
  for (const it of params.items) if (month.directScores && month.directScores[it.key]) directScores[it.key] = month.directScores[it.key];
  const peer = peerShares(params, subs, pool, { directScores });
  const items = [];
  const pre = Object.fromEntries(pool.map((p) => [p.id, 0]));
  for (const it of params.items) {
    const poolAmt = (+metrics[it.metric] || 0) * (it.mult ?? 1);
    const parts = pool.filter((p) => !(it.exclude || []).includes(p.id));
    const csum = sum(parts.map((p) => +p.contrib || 0));
    const alloc = {};
    for (const p of pool) {
      const inItem = parts.includes(p);
      const fixed = (poolAmt * (+(it.fixed || {})[p.id] || 0)) / 100;
      const pr = inItem && it.peerPct > 0 ? ((poolAmt * it.peerPct) / 100) * (peer.shares[it.key][p.id] || 0) : 0;
      const ev = inItem && csum > 0 ? ((poolAmt * it.evenPct) / 100) * ((+p.contrib || 0) / csum) : 0;
      alloc[p.id] = { fixed, peer: pr, even: ev, subtotal: fixed + pr + ev };
      pre[p.id] += fixed + pr + ev;
    }
    items.push({ key: it.key, name: it.name, unit: it.unit || "", qty: +metrics[it.metric] || 0, pool: poolAmt, alloc, check: sum(Object.values(alloc).map((a) => a.subtotal)) });
  }
  const cut = {}, after = {}, back = {}, selfpay = {};
  for (const p of pool) { after[p.id] = pre[p.id] * rate[p.id]; cut[p.id] = pre[p.id] - after[p.id]; }
  const totalCut = sum(Object.values(cut));
  const denom = Math.max(pool.length - 1, 1);
  for (const p of pool) { back[p.id] = (totalCut - cut[p.id]) / denom; selfpay[p.id] = after[p.id] + back[p.id]; }
  const poolTotal = sum(items.map((i) => i.pool));

  // ---- 個人獎金（不進池、不折算）----
  const indiv = {};
  for (const b of params.individual || []) {
    let amt = 0, note = "";
    const base = +metrics[b.metric] || 0;
    if (b.kind === "perUnit") { amt = base * b.rate; if (b.unitLabel) note = `${base} ${b.unitLabel}`; }
    else if (b.kind === "pct") amt = (base * b.pct) / 100;
    else if (b.kind === "tier") {
      const sales = +metrics[b.salesMetric] || 0;
      let r = 0;
      if (b.flag && flags[b.flag]) r = Math.max(...b.tiers.map((t) => t.rate));
      else for (const t of [...b.tiers].sort((x, y) => x.min - y.min)) if (sales >= t.min) r = t.rate;
      amt = (base * r) / 100;
    }
    (indiv[b.id] = indiv[b.id] || []).push({ label: b.label, amount: amt, note, mergeInto: b.mergeInto || null, key: b.key || b.label });
  }

  // ---- 每人薪資單 ----
  const typhoonH = +month.typhoonHours || 0;
  const rows = people.map((p) => {
    const a = attOf(p.id);
    const allowSum = sum((p.allowances || []).map((x) => +x.amount || 0));
    const fixedPay = (+p.base || 0) + allowSum;
    const income = [], deduct = [], adjust = [];
    const add = (arr, label, amount, note = "", extra = {}) => arr.push({ label, raw: amount, amount: roundHalfUp(amount), note, ...extra });

    add(income, "本薪", +p.base || 0);
    const ot = +a.ot || 0;
    if (ot && p.otRate) add(income, "加班費", ot * p.otRate, `${ot} 分`);
    if (p.getsVisitBonus) add(income, "人次獎金", T - leaveVisits[p.id], `${(T - leaveVisits[p.id]).toLocaleString()} 人次`);
    const myIndiv = indiv[p.id] || [];
    if (p.inPool) {
      const merged = myIndiv.filter((x) => x.mergeInto === "selfpay");
      const amt = selfpay[p.id] + sum(merged.map((x) => x.amount));
      const label = merged.length ? `自費獎金（含${merged.map((x) => x.label.replace(/獎金$/, "")).join("、")}）` : "自費獎金";
      add(income, label, amt, "", { detail: { selfpay: selfpay[p.id], merged } });
    }
    for (const x of myIndiv.filter((x) => x.mergeInto !== "selfpay")) if (x.amount) add(income, x.label, x.amount, x.note);
    for (const x of p.extras || []) if (+x.amount) add(income, x.label, +x.amount, "", { cash: !!x.cash });
    if (+p.attFull) add(income, "出勤獎金", p.attFull * rate[p.id]);
    for (const x of p.allowances || []) if (+x.amount) add(income, x.label, +x.amount);

    if (p.nhi) add(deduct, "健保自付", p.nhi);
    if (p.li) add(deduct, "勞保自付", p.li);
    const lh = (+a.personal || 0) + (+a.sick || 0) * 0.5;
    if (lh) add(deduct, "請假扣除", (-fixedPay / 30 / 8) * lh, `${lh} 小時`);
    const late = +a.late || 0;
    if (late) add(deduct, "遲到扣款", p.lateRatePerMin != null ? -p.lateRatePerMin * late : (-fixedPay / 30 / 8 / 60) * late, `${late} 分`);
    if (typhoonH && !p.typhoonExempt) add(deduct, "颱風停診扣款", (-(+p.base || 0) / 30 / 8) * typhoonH, `${typhoonH} 小時`);
    const man = (month.manual || {})[p.id];
    if (man && +man.amount) add(adjust, "手動微調", +man.amount, man.note || "");

    const isum = sum(income.map((x) => x.amount)), dsum = sum(deduct.map((x) => x.amount)), asum = sum(adjust.map((x) => x.amount));
    const cash = sum(income.filter((x) => x.cash).map((x) => x.amount));
    return { id: p.id, name: p.name, role: p.role, rate: rate[p.id], leaveVisits: leaveVisits[p.id], income, deduct, adjust, incomeSum: isum, deductSum: dsum, adjustSum: asum, net: isum + dsum + asum, cash };
  });

  return {
    metrics, rate, leaveVisits, peer, items, poolTotal,
    selfpay: { pre, cut, back, final: selfpay, totalCut },
    rows, netTotal: sum(rows.map((r) => r.net)),
    checks: {
      itemsBalanced: items.every((i) => Math.abs(i.check - i.pool) < 1e-6),
      poolConserved: Math.abs(sum(Object.values(selfpay)) - poolTotal) < 1e-6,
      missingTotalVisits: !T,
      missingSessionVisits: absentSessions(people, Object.fromEntries(people.map((p) => [p.id, { att: attOf(p.id) }]))).filter((s) => (month.sessionVisits || {})[s.key] == null).map((s) => s.key),
    },
  };
}
