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
