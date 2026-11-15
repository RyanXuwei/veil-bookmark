# Veil Bookmark

加密的私人書籤與記事本 Chrome 擴充功能，一般視窗與無痕視窗都能使用。

Made by Ryan Hsu · BitingBox Studio　｜　[隱私權政策](https://ryanxuwei.github.io/veil-bookmark/privacy.html)　｜　目前版本：0.1.9 Beta

## 功能

- **私人書籤**：資料夾、標籤、筆記與搜尋；一鍵收藏目前網頁。不會加入 Chrome 書籤列。
- **加密記事本**：記下密碼提示、帳號資訊或私人想法，與書籤一起加密保存。
- **一般與無痕都能用**：點書籤會在目前的瀏覽模式開啟，也可以另開無痕視窗。
- **自動上鎖**：閒置 15 分鐘、電腦鎖定或關閉所有 Chrome 視窗後自動上鎖。
- **加密備份**：可匯出加密備份檔，在新電腦還原。
- **選用 Google Drive 同步**：只上傳加密後的資料到 Drive 的隱藏應用程式資料夾。
- **四種語言**：繁體中文、简体中文、English、日本語。

## 安裝

目前尚未上架 Chrome 線上應用程式商店，請手動安裝：

1. 下載並解壓縮 `VeilBookmark_v0.1.9_Chrome.zip`，放在固定的資料夾。
2. 在 Chrome 網址列輸入 `chrome://extensions`，開啟右上角的「開發人員模式」。
3. 按「載入未封裝項目」，選擇剛才解壓縮的資料夾。
4. 點工具列上的 Veil Bookmark 圖示，設定至少 4 個字元的主密碼。
5. 若要在無痕視窗使用：在擴充功能的「詳細資料」開啟「允許在無痕模式中執行」。

### 更新版本

1. 先在「同步與備份」按「匯出加密備份」。
2. 用新版檔案覆蓋原本的資料夾，到 `chrome://extensions` 按「重新載入」。請勿先解除安裝，否則本機資料會被刪除。

> 從 0.1.7 以前的版本升級時，擴充功能會被 Chrome 視為新的項目，原本的資料不會自動帶過來。請先匯出加密備份，安裝新版後在歡迎畫面選「已有備份？從加密檔案還原」。

## Google Drive 同步（選用）

在「同步與備份」按「開啟設定說明」，依照擴充功能內的說明頁完成一次設定即可。新電腦可在歡迎畫面按「從 Google Drive 還原」。

- 只請求 `drive.appdata` 權限，資料放在 Drive 的隱藏應用程式資料夾，不會讀取你的其他檔案。
- 上傳前已用主密碼加密，Google 看不到書籤與記事內容。
- 同一筆資料在兩台電腦同時修改時，以最後修改的版本為準，請確認電腦時間正確。

## 安全與隱私

- 書籤與記事以 AES-256-GCM 加密，金鑰由主密碼經 PBKDF2-SHA256（600,000 次）衍生。
- 主密碼不會被儲存；解鎖金鑰只存在瀏覽器工作階段記憶體，上鎖或關閉瀏覽器即清除。
- 沒有開發者伺服器，不含分析、追蹤或廣告，不載入外部網站圖示。
- 一般視窗開啟的網站仍可能留下瀏覽紀錄；無痕模式不會隱藏你的網路活動。
- 解鎖期間，若電腦已遭他人控制，畫面與記憶體內容仍可能被讀取。

完整說明請見[隱私權政策](https://ryanxuwei.github.io/veil-bookmark/privacy.html)。

## 重要聲明（免責聲明）

1. 主密碼只存在你的記憶中。Veil Bookmark 不會在任何地方（本機、Google Drive 或開發者）儲存、備份或傳送你的主密碼。
2. 沒有任何密碼救援或重設機制，開發者也無法協助找回密碼或解密資料。
3. 一旦遺失主密碼，所有加密的書籤與記事將永久無法開啟。
4. 請自行妥善保管主密碼，並定期匯出加密備份；備份檔同樣需要主密碼才能還原。
5. 本軟體依「現狀」提供，不提供任何明示或默示擔保。在法律允許的範圍內，開發者對資料遺失、無法存取或其他損害不負任何責任。

## Beta 版限制

- 尚未以真實 Google 帳號完整驗證 Drive 同步。
- 尚未提供修改主密碼、匯入 Chrome 書籤的功能。
- 尚未經第三方安全稽核。

## 開發

需要 Node.js 22 以上。

```bash
npm ci
npm test
npm run build
```

建置結果在 `dist/`，可直接以「載入未封裝項目」載入。

- 瀏覽器測試：`npx playwright install chromium`，再執行 `scripts/` 內的 `popup-e2e.mjs`、`setup-e2e.mjs`、`about-e2e.mjs`。
- 翻譯：編輯 `i18n/translations.tsv`（繁中｜English｜日本語），執行 `npm install --no-save opencc-js && npm run i18n` 重新產生；`npm run build` 會先檢查是否有缺漏的翻譯。
- 圖示：`public/icons/icon.svg`，可用 `python scripts/generate_icons.py`（需 Pillow）產生各尺寸。
- 版本紀錄見 [CHANGELOG.md](CHANGELOG.md)，測試紀錄見 [TEST_REPORT.md](TEST_REPORT.md)。

## 授權

© 2026 Ryan Hsu. All rights reserved.

本專案原始碼公開供檢視，但未授權他人使用、修改或散布。第三方套件保留各自授權，見 [THIRD_PARTY_NOTICES.txt](THIRD_PARTY_NOTICES.txt)。
