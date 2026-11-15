# Veil Bookmark · 0.1.9 Beta

原專案代號 Veilmark；因 Chrome 商店已有同名產品，2026-11-15 由使用者正式改名為 Veil Bookmark。內部加密格式與同步協定識別碼保留 `veilmark`，避免破壞資料相容性。

Chrome Manifest V3 擴充功能。TypeScript、React、Vite。Made by Ryan Hsu · BitingBox Studio（[在 GitHub 查看 Ryan Hsu 的作品](https://github.com/RyanXuwei)）。本機執行，不需 EXE 或本機伺服器。

## 安裝

1. 將擴充功能 ZIP 解壓縮至固定位置。
2. 在 Chrome 網址列輸入 `chrome://extensions`，開啟「開發人員模式」。
3. 按「載入未封裝項目」，選擇內含 `manifest.json` 的目錄。若使用完整專案，選擇 `dist`。
4. 在一般視窗點工具列圖示即可使用，建立至少 4 字元的主密碼。
5. 若也要在無痕視窗使用，於 Veil Bookmark 的「詳細資料」手動開啟「允許在無痕模式中執行」，再按 Ctrl + Shift + N。一般使用不需要這項授權。

ZIP 必須解壓縮後載入；它不是 Chrome Web Store 已上架版本。更新時請保留同一路徑，並先匯出加密備份。解除安裝會移除本機資料。

## 功能

- 新增、編輯、刪除書籤；資料夾、逗號分隔標籤、私人筆記與搜尋。
- 工具列預設開啟 380px 浮框，書籤以清單及可展開資料夾呈現；支援搜尋、直接收藏當前網頁、手動新增、編輯與刪除。
- 點書籤在目前分頁開啟；Ctrl / Command 點擊或滑鼠中鍵則在同一模式的新分頁開啟。一般視窗維持一般模式，無痕視窗維持無痕模式；「⋯」也保留另開無痕視窗、編輯、刪除。
- 兩種模式的浮框內均提供新增、編輯、刪除、搜尋、資料夾、筆記、同步設定與匯出備份，不需要另開一般管理分頁。點浮框外部會關閉；關閉前請儲存正在編輯的內容。
- 一般與無痕模式皆可開啟書籤；只接受 HTTP / HTTPS，不接受含帳密網址。
- AES-256-GCM 全庫加密，PBKDF2-SHA256 600,000 次、隨機 16-byte salt、每次隨機 12-byte IV；驗證版本、庫 ID 及 KDF 參數。
- 主密碼不持久儲存；衍生金鑰只放在 `chrome.storage.session`。本機長期儲存只有密文與同步設定。
- 最後一次管理介面操作後 15 分鐘上鎖；系統閒置 15 分鐘、系統鎖定、關閉所有 Chrome 視窗及瀏覽器重新啟動也會上鎖。瀏覽器允許背景執行時，仍檢查瀏覽器視窗的工作階段。
- 匯出加密 JSON；空白安裝可由檔案或 Drive 還原。
- Drive 選用同步已實作，需設定自己的 Google OAuth Client ID。交付的本機版沒有假 Client ID，未設定時連線按鈕停用。

## Google Drive 設定（0.1.7 起改用擴充功能內的說明頁，下方為建置時內建 Client ID 的進階方式）

1. 在自己的 Google Cloud 專案啟用 Google Drive API，設定 OAuth 同意畫面／測試使用者。
2. 建立 **Chrome Extension** 類型 OAuth Client，綁定 `chrome://extensions` 顯示的擴充功能 ID。只需要公開的 Client ID，不要提供 Client Secret。
3. 在專案目錄開啟 PowerShell：

```powershell
npm ci
$env:VEILMARK_OAUTH_CLIENT_ID = '你的Client-ID.apps.googleusercontent.com'
npm run build
```

4. 到 `chrome://extensions` 重新載入 `dist`，在「同步與備份」按「連接 Google Drive」。
5. 新裝置必須載入同一擴充功能 ID、同一 OAuth 設定，先從 Drive 或加密備份還原同一保險庫，再啟用同步。不要分別建立兩個新庫；程式會拒絕合併不同庫以保護資料。

未封裝擴充功能的 ID 可能因路徑或裝置改變。開發者可提供固定公開 `manifest.key`（建置環境變數 `VEILMARK_EXTENSION_KEY`），並以該 ID 建立 OAuth Client；正式上架需使用商店對應 ID。公開 key 不是加密私鑰；不要把任何私鑰放入 manifest。

Google 文件：[Chrome Identity](https://developer.chrome.com/docs/extensions/reference/api/identity)、[Drive 應用程式資料夾](https://developers.google.com/workspace/drive/api/guides/appdata)。只請求 `drive.appdata`，資料放在使用者 Drive 隱藏的 `appDataFolder`，不讀取一般 Drive 文件。

解鎖且啟用同步時每 5 分鐘同步；修改後約 30 秒安排同步；上鎖時暫停。斷線會保留本機密文，下次解鎖可重試。中斷連線不會刪除雲端備份，也不等同在 Google 帳戶撤銷授權。

同步採不可覆寫的加密快照，下載後以書籤 ID、更新時間及 revision 做確定性合併；保留刪除墓碑。不同裝置同時上傳不會覆寫對方快照，下一輪收斂。**同一書籤同時編輯採最後更新優先，不做欄位級合併；裝置時鐘應正確。** 遠端歷史快照不自動刪除，因此刪除的書籤仍可能存在於較舊的加密快照；超過 2000 份會停止同步並提示整理。此 Beta 尚無快照清理介面。

## 隱私與限制

- 不載入外部 favicon、字型、分析或廣告；頁面不注入內容腳本。
- 浮框在按收藏時，透過 activeTab 讀取目前網頁的標題與網址。兩種模式共用相同的加密收藏、主密碼與解鎖狀態；在任一模式手動上鎖，另一模式也會上鎖。
- 使用 spanning 模式，由同一背景服務依序處理一般與無痕請求，避免同時寫入互相覆蓋。網頁開啟要求會明確指定來源視窗，維持原本的瀏覽模式。
- 解鎖時，受控制的瀏覽器／電腦仍可能讀取畫面或記憶體。此工具不防範裝置已被控制的情況。
- 無主密碼重設；遺失主密碼無法復原。一般瀏覽可能留下／同步瀏覽紀錄；無痕不會隱藏網路活動。加密書籤會持續保存在本機；由你主動匯出的備份檔及下載檔也可能保留。
- 沒有修改主密碼、Chrome 原生書籤匯入、密碼找回功能；本版也未經第三方安全稽核。
- `storage` 儲存密文／工作階段；`alarms` 處理逾時與同步；`idle` 偵測閒置／鎖屏；`activeTab` 只在點工具列時讀當前頁；`identity` 與 Google API 網域用於選用同步。不請求 Chrome 書籤庫或瀏覽歷史權限。

## 開發與驗證

```powershell
npm ci
npm test
npm run build
npx playwright install chromium
node scripts/popup-e2e.mjs
```

測試只使用合成網址與隔離瀏覽器設定檔，不讀真實書籤／Chrome 個人設定。測試設定檔寫到專案外層 `work`；視覺預覽寫到 `outputs/previews`。

交付狀態請見 `TEST_REPORT.md`。Drive HTTP／合併有模擬測試，**未以真實 Google OAuth 或兩台電腦驗證同步**。尚未發布到商店或 GitHub。

產品圖示 SVG 位於 `public/icons/icon.svg`，可用 `python scripts/generate_icons.py`（需 Pillow）重新產生各尺寸；第三方套件授權見 `THIRD_PARTY_NOTICES.txt`。首次可交付日期：2026-11-15。

## 0.1.2 更新安裝

先由原版匯出加密備份，再將新版 ZIP 解壓縮並覆蓋原本載入的擴充功能資料夾，到 `chrome://extensions` 按重新載入。保持相同安裝路徑、不要先解除安裝，可保留本機保險庫與擴充功能 ID。重新載入後工具列改開浮框，主密碼仍為原密碼。

## 歷史：0.1.3 無痕專用版（已由 0.1.5 雙模式取代）

使用 Chrome `incognito: split`，一般與無痕有各自背景程序；加密本機庫沿用原格式與原路徑，主密碼不變。只有無痕背景程序可操作保險庫及執行同步，避免兩個程序同時寫入。無痕開關關閉時顯示授權指南；開啟後在無痕視窗直接使用浮框。

更新前先從舊版匯出加密備份，再覆蓋原本載入的資料夾並於 `chrome://extensions` 重新載入，勿先解除安裝。Chrome 可能重設／要求確認無痕授權，請再次檢查「允許在無痕模式中執行」。

Google OAuth 真實帳戶連線及無痕狀態下的互動授權尚未驗證；本機版沒有 OAuth Client ID，Drive 仍停用。

## 0.1.4 圖示更新

改用深綠底、象牙白書籤及鎖孔的獨立產品圖示。明確指定工具列與擴充功能管理頁的 16／32／48／128px 圖示，介面也採用同一圖形。更新後若工具列仍顯示舊圖，請先重新載入擴充功能，必要時取消釘選後重新釘選。

## 0.1.5 雙模式更新

保留原書籤＋鎖孔圖示，恢復一般與無痕兩種模式。共用同一份加密庫及解鎖狀態；在任何模式新增／編輯，另一模式可於重開浮框或更新畫面後看到。只關閉無痕視窗、仍有一般視窗時，解鎖會保留到逾時或手動上鎖。所有 Chrome 視窗關閉或重啟時上鎖。

更新前先匯出加密備份；覆蓋原資料夾後重新載入，勿先解除安裝。資料格式及主密碼保持相容。需要在無痕使用時，再確認「允許在無痕模式中執行」。Drive 真實帳戶同步仍未驗證，未設定 OAuth 的交付包維持停用。

## 0.1.6 多語切換

- 介面支援繁體中文、简体中文、English、日本語。浮框底部的語言選單可隨時切換，選擇會保存在本機（`uiLang`），一般與無痕視窗共用。
- 第一次使用時依 Chrome 介面語言自動選擇；其他語言預設 English。
- 擴充功能名稱、說明與工具列提示使用 Chrome `_locales`，依 Chrome 語言顯示。
- 背景服務的錯誤訊息也會依所選語言顯示。書籤名稱、資料夾等你輸入的內容不會被翻譯。
- 翻譯來源為 `i18n/translations.tsv`（繁中｜英｜日），简体中文以 OpenCC 由繁中轉換。修改後執行 `npm install --no-save opencc-js && npm run i18n` 重新產生；`npm run build` 會先檢查是否有未翻譯字串。

更新方式同前：先匯出加密備份，覆蓋原資料夾後於 `chrome://extensions` 重新載入，勿解除安裝。資料格式與主密碼不變。

## 製作資訊

- 製作者：Ryan Hsu
- 工作室：BitingBox Studio
- 程式製作年份：2026
- 程式製作日期：2026-11-15（首次完成可交付版本 0.1.0，Asia/Taipei）
- 最後更新日期：2026-11-15（0.1.9）
- 發佈日期：尚未公開發佈
- Copyright：© 2026 Ryan Hsu. All rights reserved.（權利人由使用者於 2026-11-15 確認；第三方套件保留各自授權，見 THIRD_PARTY_NOTICES.txt）
- GitHub：https://github.com/RyanXuwei

## 0.1.7 Google Drive 設定說明頁

- 不必再重新建置。在「同步與備份」按「開啟設定說明 ↗」，或在新電腦的歡迎畫面按「從 Google Drive 還原」，會開啟擴充功能內的設定頁（`index.html?setup`）。
- 設定頁分 4 步：啟用 Drive API → OAuth 同意畫面（把自己的 Gmail 加為測試使用者）→ 建立「網頁應用程式」類型的 OAuth 用戶端並貼上頁面顯示的重新導向 URI（`https://<擴充功能ID>.chromiumapp.org/`，可一鍵複製）→ 貼上用戶端 ID 並連接。
- 只需要用戶端 ID，不需要也不接受 Client Secret。用戶端 ID 存在本機 `oauthClientId`，存取權杖只存在瀏覽器工作階段記憶體，約 1 小時到期，重啟瀏覽器即清除。
- 其他電腦的擴充功能 ID 不同時，把那台電腦設定頁顯示的網址加到同一個用戶端的重新導向 URI 即可，所有電腦共用同一個 Drive 應用程式資料夾。
- 若建置時已用 `VEILMARK_OAUTH_CLIENT_ID` 內建 Client ID，會優先使用內建設定，設定頁的輸入欄停用。
- 尚未以真實 Google 帳戶驗證整個流程；第一次使用時請先匯出加密備份。

## 0.1.8 固定擴充功能 ID、Drive 快照清理、隱私權政策

- **固定擴充功能 ID：`edehlgkopbgmnopdaepadcopfnkgcpab`**。`manifest.json` 內含公開金鑰（`key`），不論安裝在哪台電腦、哪個資料夾，ID 都相同，可登記一個「Chrome 擴充功能」類型的 OAuth 用戶端給所有電腦使用。私鑰不在儲存庫中，未封裝安裝與上架都不需要它。
- **從舊版升級會變成新的擴充功能**：ID 改變後，Chrome 會把它視為另一個擴充功能，舊版的本機保險庫不會自動帶過來。請先在舊版「同步與備份」匯出加密備份，再載入 0.1.8，於歡迎畫面選「已有備份？從加密檔案還原」。確認無誤後再移除舊版。
- **Drive 快照清理**：同步時若 Drive 有多份快照，會先上傳合併後的新快照，再刪除本次已讀取並合併的舊快照，Drive 上維持一份。只刪除已合併的快照，其他電腦同時上傳的新快照不會被刪；下載途中被其他電腦清掉的快照會略過。
- **隱私權政策與首頁**：`docs/`（GitHub Pages）。關於頁加入隱私權政策連結：https://ryanxuwei.github.io/veil-bookmark/privacy.html ；manifest `homepage_url` 指向 https://ryanxuwei.github.io/veil-bookmark/ 。
- 上架 Chrome 線上應用程式商店時，商店會指派另一個 ID，屆時需以商店 ID 另建 OAuth 用戶端。

## 0.1.9 加密記事本與主密碼聲明

- **加密記事本**：浮框新增「書籤／記事本」分頁。記事（標題選填、內容上限 100,000 字）與書籤存在同一個加密保險庫，用同一個主密碼加解密，並一起透過 Drive 同步與加密備份。可搜尋、編輯、複製內容、刪除；刪除時立即清空內容，只留下刪除標記供同步使用。
- **保險庫格式 v2**：為了容納記事，保險庫內部格式升為 v2。0.1.9 可直接開啟舊版（v1）的保險庫與備份；但 0.1.8 以前的版本無法開啟 0.1.9 產生的保險庫或備份。多台電腦同步時，請全部更新到 0.1.9，舊版會顯示格式錯誤並停止同步，不會覆蓋或刪除記事。
- **建立保險庫時的確認**：必須勾選「我了解遺失主密碼後無法救援，並會自行妥善保管」才能建立。「同步與備份」最下方顯示完整「重要聲明」。

### 重要聲明（免責聲明）

1. 主密碼只存在你的記憶中。Veil Bookmark 不會在任何地方（本機、Google Drive 或開發者）儲存、備份或傳送你的主密碼。
2. 沒有任何密碼救援或重設機制，開發者也無法協助找回密碼或解密資料。
3. 一旦遺失主密碼，所有加密的書籤與記事將永久無法開啟。
4. 請自行妥善保管主密碼，並定期匯出加密備份；備份檔同樣需要主密碼才能還原。
5. 本軟體依「現狀」提供，不提供任何明示或默示擔保。在法律允許的範圍內，開發者對資料遺失、無法存取或其他損害不負任何責任。
