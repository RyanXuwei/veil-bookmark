# Veil Bookmark 0.1.9 Beta 驗證紀錄

驗證日期：2026-11-15（Asia/Taipei）。所有內容為合成資料，未讀取使用者真實 Chrome 設定檔、書籤或帳號。

## 先前版本已通過（0.1.0–0.1.2）

- TypeScript 嚴格型別檢查及 Vite 正式建置。
- 6 組 Node 測試：AES-GCM 往返、不同 IV、錯密碼／密文與認證資訊竄改拒絕、KDF 格式限制、危險網址拒絕、確定性合併與刪除墓碑。
- 背景服務：建立、解鎖、增刪改查、加密備份與還原、逾時、閒置／系統鎖定事件、最後視窗關閉事件及 startup 事件。
- 模擬 Drive HTTP：加密上傳／下載、遠端新增與本機刪除合併、不變資料不重複上傳、不同庫拒絕、503 保留原本密文。網路請求阻塞期間仍可立即上鎖，請求完成不會恢復金鑰。
- 獨立 Chrome for Testing 159 / Playwright 1.65.1：實際載入打包的 Manifest V3 擴充功能、建立保險庫、3 筆測試書籤、新增／編輯／刪除、搜尋、加密下載、錯誤密碼、手動上鎖、期限已過拒絕、關閉並重新啟動瀏覽器保持上鎖、無痕開啟 API 成功。
- 1440px 桌面與 390px 窄版視覺檢查；窄版頁面無水平溢出。執行期間無頁面 JavaScript 錯誤。
- 查看關於頁的定稿 Logo、Ryan Hsu / BitingBox Studio、首次交付日期及 GitHub 連結目的地。使用 `bitingbox-promotion` 技能；定稿 SVG SHA-256 與來源一致：`78e7ca74d6f406b0c0fed90c0c69a30c647fced624c8583c3b822a9b7ee5aff3`。
- npm 安裝稽核沒有發現已知弱點（依當時 registry 回應；不代表安全稽核）。

## 尚未驗證／已知限制

- 沒有 Google OAuth Client ID，未測真實帳戶授權、Drive 存取或兩台實體裝置同步。交付包為可使用的本機版，同步程式碼已備妥但未啟用。
- 逾時是修改測試工作階段期限後驗證，不是實際等待 15 分鐘；系統閒置、鎖屏及最後視窗事件為背景模擬測試。瀏覽器關閉／重啟則有實際執行。
- 未在使用者日常 Chrome 設定檔安裝，未測 Chrome Web Store 上架，未做第三方安全稽核。
- 同一筆並行修改採最後更新優先；舊加密快照不自動刪除；最多讀取 2000 份快照。
- 不支援密碼重設／更換、原生書籤匯入或快照清理介面。請保留主密碼及加密備份。

未發布到 Chrome Web Store 或 GitHub。畫面預覽位於相鄰的 `previews` 目錄。

## 0.1.1 更新

依使用者要求，建立主密碼最短改為 4 個字元。背景測試使用 `1234` 驗證建立、鎖定後解鎖、備份還原及加密同步；拒絕 3 字元密碼。瀏覽器操作測試亦改用 4 字元密碼。

## 0.1.2 浮框更新

預設入口改為原生 Chrome 工具列浮框（`action.default_popup`），不再由 action click 自動建立分頁。以 Chrome for Testing 的實際工具列動作觸發並掛接 popup target，確認 contextType 為 POPUP；合成書籤清單實測 380 × 431 px、無水平溢出。測試包含 4 字元建立／解鎖、activeTab 當前網頁標題網址擷取、資料夾展開、搜尋、編輯、刪除、上鎖、關閉後重開及在原分頁開啟收藏。新增／編輯表單浮框可捲動，完整管理頁保留為選用入口。

## 0.1.3 無痕專用版實測

- 7 組 Node 測試通過；新增一般環境讀取／解鎖／修改／匯出拒絕檢查。
- 隔離 Chrome for Testing 159 中，透過 Chrome 自己的擴充功能設定啟用開發者模式及無痕授權；沒有更改使用者日常 Chrome 設定。
- 真實無痕 BrowserContext 及原生 POPUP context 實測；確認 `chrome.extension.inIncognitoContext` 為 true，背景 STATUS 亦回報無痕。測試網頁由 CDP Fetch 攔截提供合成內容，不送出私人網址。
- 4 碼建立／解鎖、無痕 activeTab 擷取、資料夾、搜尋、編輯、刪除及原無痕分頁開啟通過；一般環境的匯出被拒絕，畫面未顯示私人標題。本機長期儲存沒有書籤明文。
- 實際關閉所有無痕視窗後，重新開啟無痕視窗及浮框要求再次輸入密碼；4 碼解鎖後仍能取得先前收藏。
- 使用 split 隔離；一般背景程序不執行保險庫自動同步或保險庫寫入。原本一般管理頁的測試流程留作歷史，不適用於本版入口限制。
- 本版尚未驗證真實 Google OAuth／Drive、Chrome Web Store 發布與第三方安全稽核。

## 0.1.4 產品圖示

依使用者要求改為幾何書籤＋鎖孔圖示，沒有動物元素；工具列 default_icon、擴充功能 icons、浮框標頭與關於頁統一。提供 SVG 及 16／32／48／128px PNG；BitingBox Studio 以文字連結署名。

## 0.1.5 一般與無痕雙模式

7 組 Node 測試通過，包含一般與無痕請求共用庫及鎖定狀態。Chrome for Testing 159 實測一般與無痕原生工具列浮框：一般模式不需無痕授權即可建立入口；開啟無痕授權後，無痕浮框能建立／解鎖／收藏／編輯／刪除；一般浮框能讀取同庫、收藏一般頁面、在一般新分頁開啟；新增後回到無痕浮框也可看到。任一模式手動上鎖會使另一模式的讀取被拒絕。本機持久儲存無書籤明文。測試網站由本機暫時 HTTP fixture 提供，測試完自動關閉，不是產品依賴。

改為 spanning 單一背景 writer，保留目前視窗的模式；此版取代 0.1.3／0.1.4 的無痕限定與關閉最後無痕視窗即鎖定行為。圖示 PNG／SVG 沒有更動。Google OAuth／Drive 真實帳戶同步依然未驗證。

## 0.1.6 多語切換

- 7 組 Node 測試通過；`scripts/check-i18n.mjs` 確認介面與背景錯誤訊息的 158 個字串都有 4 種語言。
- Chrome for Testing 實測無痕浮框：切換 English、日本語、简体中文後，按鈕文字與 `<html lang>` 正確更新；關閉並重開浮框後仍維持所選語言；切回繁體中文後上鎖流程正常。截圖：previews/18-lang-en.png、19-lang-ja.png、20-lang-zh-cn.png。
- 原有一般／無痕雙模式、收藏、搜尋、編輯、刪除、上鎖與加密保存流程全部重跑通過。
- 修正測試腳本重開浮框時可能接到正在關閉的舊浮框的競態（僅測試程式）。
- 英文與日文為人工撰寫翻譯，尚未經母語者校稿；Google OAuth／Drive 真實帳戶同步仍未驗證。

## 0.1.6 品牌署名（bitingbox-promotion）

- 關於頁改為：製作者 Ryan Hsu、工作室 BitingBox Studio、版本、程式製作年份 2026、程式製作日期 2026-11-15（首次可交付版本）、最後更新日期，並提供「在 GitHub 查看 Ryan Hsu 的作品」可點擊連結（新分頁、noopener noreferrer）。
- 頁尾改為「Made by Ryan Hsu ↗ · BitingBox Studio」；GitHub 只連在 Ryan Hsu 名字上，不再把個人 GitHub 標成工作室網站。
- 移除未確認權利人的「© 2026 BitingBox Studio」；Copyright 權利人待使用者確認。未加入 ®／™。
- 依使用者先前要求不使用寶箱怪圖形作產品圖示，關於頁維持書籤鎖孔圖示，工作室以文字冠名。
- `scripts/about-e2e.mjs` 實測：380px 浮框無水平溢出、兩處連結目的地正確、無花括號／null／©；繁中與英文截圖 previews/21–23。

- 使用者確認 Copyright 權利人為 Ryan Hsu；關於頁加入「© 2026 Ryan Hsu. All rights reserved.」，README 同步。about-e2e 改為檢查此行。

## 0.1.7 Google Drive 設定說明頁

- 新增執行期設定的 OAuth 用戶端 ID：`chrome.identity.launchWebAuthFlow` 隱含授權流程，含 state 驗證、scope 檢查、權杖只存 session、401 清除快取。建置時內建的 Client ID 仍走原 `getAuthToken` 路徑。
- 8 組 Node 測試通過；新增測試涵蓋：格式錯誤 ID 拒絕、前後空白修剪、STATUS 回報、首次互動授權、權杖重用、401 清除、偽造 state 拒絕、缺少 drive.appdata scope 拒絕、使用者取消、權杖不寫入長期儲存、移除設定後停用同步。
- `scripts/setup-e2e.mjs`（Chrome for Testing）：歡迎畫面「從 Google Drive 還原」在未設定時開啟說明頁；顯示正確的 `https://<ID>.chromiumapp.org/`；4 個 Google Cloud 連結目的地正確；Client Secret 樣式輸入被拒、合成 ID 可儲存並顯示「已設定，尚未連接」；380px 無水平捲動；英文版正常；移除設定後回到未設定；整個測試沒有對外連線。截圖 previews/24–26。
- 浮框、多語、關於頁回歸測試全部重跑通過。
- **未驗證**：真實 Google Cloud 專案與帳戶的授權、實際 Drive 上傳／下載、兩台電腦同步、`prompt=none` 背景更新權杖在真實環境的行為。

## 0.1.8 固定 ID、快照清理、隱私權政策

- Chrome for Testing 載入 dist 後，實際擴充功能 ID 為 `edehlgkopbgmnopdaepadcopfnkgcpab`，與由公開金鑰計算的 ID 一致；設定頁顯示 `https://edehlgkopbgmnopdaepadcopfnkgcpab.chromiumapp.org/`。
- 8 組 Node 測試通過。Drive 測試更新：兩份快照時上傳合併快照並刪除兩份舊快照，Drive 只剩一份且內容包含遠端新增項目；列表後消失的快照（下載 404）會略過；其他保險庫被拒絕時不刪除任何檔案；Drive 內容沒有明文。
- 浮框、多語、關於頁（含 GitHub 與隱私權政策兩個連結、版本號）、Drive 設定頁 E2E 全部重跑通過。
- docs/index.html、docs/privacy.html：1100px 與 380px 無水平捲動、圖片正常載入；隱私權政策所述加密方式（PBKDF2-SHA256、AES-256-GCM）與程式一致。截圖 previews/27–28。
- **未驗證**：GitHub Pages 尚未啟用，隱私權政策網址目前無法開啟；真實 Google OAuth 與 Drive 同步仍未驗證。

## 0.1.9 加密記事本與主密碼聲明

- 11 組 Node 測試通過。新增：v1 保險庫可開啟並轉為 v2（記事為空）；記事加密後無明文、格式錯誤記事被拒、記事合併為逐筆最後更新優先且刪除標記勝出、合併可交換；背景服務記事新增／編輯／刪除（刪除清空內容）、空白與超長內容拒絕、上鎖後拒絕。
- 浮框 E2E（Chrome for Testing，無痕）：未勾選確認時「建立保險庫」停用，勾選後可建立；記事本分頁新增記事、清單顯示、本機儲存無明文、重開內容一致、刪除確認後消失、切回書籤正常。原有書籤、多語、一般／無痕流程全部重跑通過。截圖 previews/29–31。
- 未驗證：記事在真實 Google Drive 的同步。
