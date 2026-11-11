// 用法：node tests/verify.mjs <params.json> <驗證資料.json>
// 兩個檔案都含真實薪資資料，請放在 repo 以外，不要 commit。
import { readFileSync } from "node:fs";
import { computePayroll } from "../engine.js";

const [paramsPath, fixturePath] = process.argv.slice(2);
if (!paramsPath || !fixturePath) { console.error("用法：node tests/verify.mjs <params.json> <驗證資料.json>"); process.exit(2); }
const params = JSON.parse(readFileSync(paramsPath, "utf8"));
const fx = JSON.parse(readFileSync(fixturePath, "utf8"));
const I = fx.inputs, E = fx.expected;
const id = Object.fromEntries(params.people.map((p) => [p.name, p.id]));
const ITEM = { "衛教": "edu", "口服營養": "oral", "自費疫苗": "vac", "自費點滴": "iv", "自費減重": "ws", "甲狀腺穿刺": "fna", "慢籤": "rx" };

// 把驗證資料轉成 Firestore 的資料形狀
const subs = {};
for (const p of params.people) if (p.inPool) subs[p.id] = { peer: {}, att: {}, metrics: {} };
for (const [name, s] of Object.entries(I.staff)) {
  const a = subs[id[name]].att;
  a.ot = s.overtime_min; a.personal = s.personal_leave_hr; a.sick = s.sick_leave_hr; a.annual = s.annual_leave_hr; a.late = s.late_min;
}
for (const l of I.leave_sessions) subs[id[l.staff]].att.absences = [{ date: l.date, slots: ["am"] }];
for (const [item, raters] of Object.entries(I.peer_review))
  for (const [rn, scores] of Object.entries(raters))
    scores.forEach((v, j) => { const tid = id[I.peer_review_order[j]]; if (v == null || tid === id[rn]) return; (subs[id[rn]].peer[tid] = subs[id[rn]].peer[tid] || {})[ITEM[item]] = v; });
Object.assign(subs.huang.metrics, { m_edu: I.health_education_cases });
Object.assign(subs.yiwen.metrics, { m_oralPool: I.oral_bonus_pool, m_oralSale: I.oral_sales_amount });
Object.assign(subs.ling.metrics, { m_vac: I.vaccine_pool, m_iv: I.iv_visits });
Object.assign(subs.yu.metrics, { m_ws: I.weight_loss_visits });
Object.assign(subs.zhuang.metrics, { m_fna: I.fna_visits });
Object.assign(subs.dong.metrics, { m_rx: I.chronic_rx_count });
Object.assign(subs.mei.metrics, { m_firstVisit: I.first_visits, m_audit: I.mei_audit_books });
const month = {
  totalVisits: I.total_visits,
  sessionVisits: Object.fromEntries(I.leave_sessions.map((l) => [l.date + "|am", l.visits_in_session])),
  typhoonHours: I.typhoon_hours_total,
  directScores: { init: Object.fromEntries(Object.entries(I.first_visit_scores).map(([n, v]) => [id[n], v])) },
};

const R = computePayroll(params, month, subs);
let fail = 0;
const eq = (label, got, want, tol = 0) => { const ok = Math.abs(got - want) <= tol; if (!ok) fail++; console.log(`${ok ? "✓" : "✗"} ${label}: ${got}${ok ? "" : `（應為 ${want}）`}`); };
eq("獎池合計", R.poolTotal, E.pool_total);
for (const p of params.people.filter((p) => p.inPool)) eq(`${p.name} 最終自費獎金`, +R.selfpay.final[p.id].toFixed(4), E.selfpay_final[p.name], 0.0001);
for (const r of R.rows) {
  const want = r.id === "xu" ? E.net_pay_xu : E.payslips[r.name].net_pay;
  eq(`${r.name} 實領`, r.net, want);
  if (r.id !== "xu") {
    const exp = E.payslips[r.name];
    for (const line of [...r.income, ...r.deduct]) {
      const key = line.label.startsWith("自費獎金") ? Object.keys(exp.income).find((k) => k.startsWith("自費獎金")) : line.label;
      const w = exp.income[key] ?? exp.deductions[key];
      if (w !== line.amount) { fail++; console.log(`  ✗ ${r.name} ${line.label} ${line.amount}（應為 ${w}）`); }
    }
  }
}
eq("實領合計", R.netTotal, E.net_pay_total);
console.log(R.checks.itemsBalanced && R.checks.poolConserved ? "✓ 各項分配平衡、獎池守恆" : (fail++, "✗ 守恆檢查失敗"));
console.log(fail ? `\n✗ ${fail} 項不符` : "\n全部通過 ✓");
process.exit(fail ? 1 : 0);
