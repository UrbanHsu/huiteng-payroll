# 惠騰內科 月報表填單／薪資系統

| 頁面 | 給誰 | 網址 |
|---|---|---|
| `index.html` | 員工每月填互評、出勤、業績數字 | `https://urbanhsu.github.io/huiteng-payroll/` |
| `admin.html` | 管理者：本月設定、薪資表、薪資單圖片、團隊看板、參數 | `https://urbanhsu.github.io/huiteng-payroll/admin.html` |

- 計算核心：`engine.js`（規則說明 `docs/RULES.md`）
- Firebase 設定：`firebase-config.js`
- 資料庫安全規則：`firestore.rules`

> **這個 repo 是公開的。** 任何人的薪資數字、比例、互評、驗證資料都不能 commit 進來。
> 這些都存在 Firestore，只有管理者讀得到。`.gitignore` 已排除常見的私人檔名。

## 第一次設定（新的 Firebase 專案）

1. **建立專案**：到 [Firebase 主控台](https://console.firebase.google.com/) →「新增專案」（Google Analytics 可以不開）
2. **新增網頁應用程式**：專案總覽 → `</>` 圖示 → 取個名字 → 複製 `firebaseConfig`，貼到 `firebase-config.js`
3. **開啟登入**：Authentication → 開始使用 → 登入方式 → 啟用「電子郵件/密碼」
4. **建立管理者帳號**：Authentication → 使用者 → 新增使用者（填管理者的 Email 與密碼）
5. **建立資料庫**：Firestore Database → 建立資料庫 → 位置選 `asia-east1`（台灣）→ 正式版模式
6. **安全規則**：把 `firestore.rules` 裡的 `ADMIN_EMAIL_HERE` 換成第 4 步的 Email，整份貼到 Firestore → 規則 → 發布
7. **授權網域**：Authentication → 設定 → 已授權網域 → 新增 `urbanhsu.github.io`
8. **匯入參數**：打開 `admin.html` 登入 →「⑤ 參數」→ 匯入參數 JSON 檔（私下保存，不在 repo 裡）→ 檢查並儲存

## 每月流程

1. 員工在 `index.html` 填報（互評、出勤、請假診次、負責的業績數字）
2. 管理者在 `admin.html`「① 本月資料」：
   - 填**本月總人次**
   - 填**請假診次的看診人次**（系統會列出有人不在的診次）
   - 有颱風等全院停診時，填停診時數與說明
   - 核對業績數字與出勤（紅字＝主管代填的數字不一致），需要時覆寫
3.「② 薪資表」確認數字 →「儲存本月結果」存檔
4.「③ 薪資單」下載每人的圖片，用 LINE 傳給本人
5.「④ 團隊看板」下載圖片，發到員工群組

## 驗證計算

```bash
node tests/verify.mjs <params.json> <驗證資料.json>
```
兩個檔案含真實資料，放在 repo 以外。每一項都應顯示 ✓。

## 部署

推到 `main` 後，GitHub Pages 會自動更新（Settings → Pages → Source：Deploy from a branch，`main` / root）。
