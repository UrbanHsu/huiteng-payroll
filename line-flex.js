/*
 * 把薪資單（engine.js 的 row）轉成 LINE Flex Message
 * 樣式對應後台下載的薪資單圖片
 */
const C = { teal: "#1F6F6B", ink: "#2B3837", muted: "#5C6B69", faint: "#8A9795", red: "#B5483B", band: "#F5F8F7", line: "#E6ECEA" };
const fmt = (n) => (n < 0 ? "−" + Math.abs(n).toLocaleString("en-US") : n.toLocaleString("en-US"));

function row(x, neg) {
  const label = { type: "span", text: x.label };
  const spans = x.note ? [label, { type: "span", text: "  " + x.note, size: "xxs", color: C.faint }] : [label];
  return {
    type: "box", layout: "horizontal", margin: "sm",
    contents: [
      { type: "text", text: x.label, contents: spans, size: "sm", color: C.ink, flex: 5, wrap: true },
      { type: "text", text: fmt(x.amount), size: "sm", align: "end", color: neg || x.amount < 0 ? C.red : C.ink, flex: 3 },
    ],
  };
}
function section(title, items, neg) {
  return {
    type: "box", layout: "vertical", paddingStart: "16px", paddingEnd: "16px", paddingTop: "12px", paddingBottom: "8px",
    contents: [{ type: "text", text: title, size: "xs", weight: "bold", color: C.teal }, ...(items.length ? items.map((x) => row(x, neg)) : [{ type: "text", text: "無", size: "sm", color: C.faint, margin: "sm" }])],
  };
}
function subtotal(label, amount, neg) {
  return {
    type: "box", layout: "horizontal", backgroundColor: C.band, paddingTop: "10px", paddingBottom: "10px", paddingStart: "16px", paddingEnd: "16px",
    contents: [
      { type: "text", text: label, size: "sm", weight: "bold", color: C.ink },
      { type: "text", text: fmt(amount), size: "sm", weight: "bold", align: "end", color: neg ? C.red : C.ink },
    ],
  };
}

/**
 * @param r      engine.js computePayroll() 的 rows[i]
 * @param opts   { clinic, year, month, payDay, footer }
 */
export function slipFlexMessage(r, opts) {
  const { clinic, year, month } = opts;
  const pm = month === 12 ? 1 : month + 1;
  const payDay = opts.payDay ?? 10;
  const net = [
    { type: "text", text: "本月實領", size: "xs", color: C.muted },
    { type: "text", text: "NT$ " + fmt(r.net), contents: [{ type: "span", text: "NT$ ", size: "sm", color: C.muted }, { type: "span", text: fmt(r.net), size: "xxl", weight: "bold", color: C.teal }], margin: "xs" },
  ];
  if (r.cash) net.push({ type: "text", text: `其中現金 ${fmt(r.cash)}・轉帳 ${fmt(r.net - r.cash)}`, size: "xs", color: C.muted, margin: "xs" });
  const body = [
    { type: "box", layout: "vertical", paddingAll: "16px", contents: net },
    { type: "separator", color: C.line },
    section("收入", r.income),
    subtotal("收入小計", r.incomeSum),
    section("扣除", r.deduct, true),
    subtotal("扣除小計", r.deductSum, true),
  ];
  if (r.adjust && r.adjust.length) body.push(section("調整", r.adjust));
  body.push({ type: "box", layout: "vertical", paddingAll: "16px", contents: [{ type: "text", text: opts.footer || "薪資屬個人資料，請勿外流。如有疑問請直接洽院方。", size: "xxs", color: C.faint, wrap: true }] });
  return {
    type: "flex",
    altText: `您的 ${month} 月薪資單已送達，請點開查看。`,
    contents: {
      type: "bubble", size: "mega",
      header: {
        type: "box", layout: "vertical", backgroundColor: C.teal, paddingAll: "16px",
        contents: [
          { type: "text", text: clinic, size: "xs", color: "#FFFFFFD9" },
          { type: "box", layout: "horizontal", margin: "md", contents: [
            { type: "text", text: r.name, size: "xl", weight: "bold", color: "#FFFFFF", gravity: "bottom", flex: 1 },
            { type: "text", text: `${year} 年 ${month} 月薪資\n${pm} 月 ${payDay} 日發放`, size: "xxs", color: "#FFFFFFE6", align: "end", wrap: true, flex: 1 },
          ] },
        ],
      },
      body: { type: "box", layout: "vertical", paddingAll: "0px", contents: body },
    },
  };
}
