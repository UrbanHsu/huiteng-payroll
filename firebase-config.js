/*
 * Firebase 設定
 * ------------------------------------------------------------
 * 建好新的 Firebase 專案後，把 Firebase 主控台「專案設定 → 你的應用程式 → SDK 設定」
 * 裡的 firebaseConfig 貼到下面。這些值本來就是公開的（瀏覽器一定拿得到），
 * 真正保護資料的是 firestore.rules。
 */
export const firebaseConfig = {
  apiKey: "AIzaSyDmc3iyFDz92jbyKiNDZKkjoYP-LtTxmlQ",
  authDomain: "huiteng-payroll-ddef6.firebaseapp.com",
  projectId: "huiteng-payroll-ddef6",
  storageBucket: "huiteng-payroll-ddef6.firebasestorage.app",
  messagingSenderId: "376984928012",
  appId: "1:376984928012:web:75e88048fa249de7409329",
};

/** 員工登入帳號的網域：員工帳號是 <代號>@staff.huiteng-payroll.app（不會真的寄信） */
export const STAFF_DOMAIN = "@staff.huiteng-payroll.app";

export const isConfigured = () => !!firebaseConfig.apiKey && !!firebaseConfig.projectId;

/** LINE 推播中心（Cloudflare Worker，三套系統共用） */
export const LINE_CENTER_URL = "https://hh-line-center.huihui-clinic.workers.dev";
/** 這套系統在推播中心的代號、診所名稱（印在 LINE 薪資單抬頭） */
export const LINE_SYSTEM = "huiteng";
export const CLINIC_NAME = "惠騰內科診所";
/** 員工加好友連結 */
export const LINE_ADD_FRIEND_URL = "https://lin.ee/nmhN9bY";
