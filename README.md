# Cursor 工具窗口擴展（示例）

> 說明：雖然此工程是按 VS Code 擴展規範搭建，但可以直接在 Cursor 中安裝和使用。

## 功能概覽

- **工具窗口**
  - 通過命令「**打開 Cursor 工具窗口**」打開一個 Webview 面板。
- **Todo 任務列表**
  - 添加簡單的待辦任務。
  - 勾選完成 / 未完成。
  - 刪除任務。
  - 使用 Webview 自帶 `setState` 做簡單持久化（關閉後再次打開仍會保留）。
- **注釋 / 筆記區**
  - 自由輸入當前開發思路、備註等。
  - 文本同樣會自動保存到 Webview 狀態。

> 所有數據僅保存在 Webview 狀態中，**不會寫入磁盤文件，也不會提交到代碼倉庫**。

## 本地開發與運行

1. **安裝依賴**

   在本工程目錄下執行（需要本機安裝 Node.js 與 npm）：

   ```bash
   npm install
   ```

2. **編譯 TypeScript**

   ```bash
   npm run compile
   ```

3. **啟動監視編譯（可選，開發建議）**

   會在你修改 `src/**/*.ts` 時自動增量編譯到 `out/`：

   ```bash
   npm run watch
   ```

4. **在 Cursor / VS Code 中啟動調試（Extension Development Host）**

   - 使用「打開文件夾」打開 `cursor-tool-window` 目錄。
   - 按 `F5`（或在「執行與調試」面板選擇「擴展」）啟動一個新的「擴展開發宿主」窗口。
   - 在新窗口的命令面板中輸入並執行：`打開 Cursor 工具窗口`。

   也可以用命令行啟動（需要系統已安裝 `code` 命令；Cursor 環境通常也可用同樣方式）：

   ```bash
   # 在本工程根目錄執行
   code --extensionDevelopmentPath .
   ```

## 打包 / 發佈（命令行）

### 打包成 VSIX（本地安裝/分發）

推薦使用 `npx`（不需要全局安裝 `vsce`）：

```bash
# 會自動先跑 npm run vscode:prepublish（內含 compile）
npx --yes @vscode/vsce package
```

打包後會生成類似 `cursor-tool-window-0.1.0.vsix` 的文件。

### 安裝 VSIX（命令行）

```bash
code --install-extension .\cursor-tool-window-0.1.0.vsix
```

（也可以在 Cursor/VS Code 的擴展面板選擇「從 VSIX 安裝」。）

### 發佈到 VS Code Marketplace（可選）

> 需要你有 Marketplace publisher，並準備好 Personal Access Token（PAT）。

```bash
# 第一次需要登入 publisher（交互式）
npx --yes @vscode/vsce login <your-publisher-id>

# 發佈（會自動執行 prepublish）
npx --yes @vscode/vsce publish
```

如需非交互式（CI）發佈，可使用環境變量 `VSCE_PAT`：

```bash
set VSCE_PAT=YOUR_TOKEN
npx --yes @vscode/vsce publish -p %VSCE_PAT%
```

> 提示：如果你希望打包內容更乾淨，建議新增 `.vscodeignore` 或在 `package.json` 裡配置 `"files"` 白名單。

## 後續擴展建議

- **更多模塊**
  - 如「快速代碼片段」、「常用命令收藏」、「當前分支變更摘要」等。
- **與工作區交互**
  - 通過 `vscode.postMessage` 與 `onDidReceiveMessage` 在 Webview 和擴展之間通信：
    - 例如：將 Todo 同步為任務文件，或根據當前打開文件自動填充備註模板。
- **多工程/多語言配置**
  - 為不同項目保存不同的 Todo/筆記集。

如需擴展具體功能（例如與 C# 專案聯動、根據當前光標位置生成備註模板等），可以在此工程基礎上繼續迭代。

