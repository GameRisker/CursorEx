@echo off
chcp 65001 >nul
title 打包 Cursor 工具窗口插件

echo.
echo ==========================================
echo  Cursor 工具窗口 - 自動打包腳本
echo  位置: %~f0
echo ==========================================

rem 1) 切換到工程根目錄（當前腳本放在工程根目錄）
echo.
echo [步驟 1] 切換到工程根目錄...
cd /d "%~dp0"
if errorlevel 1 (
    echo 切換目錄失敗，請確認腳本所在位置是否為工程根目錄下的 build.bat。
    pause
    exit /b 1
)

echo 當前目錄:
cd

rem 2) 檢查 Node / npm
echo.
echo [步驟 2] 檢查 Node / npm 版本...
node -v
if errorlevel 1 (
    echo 未找到 node 命令，請確認已安裝 Node.js 並加入 PATH。
    pause
    exit /b 1
)
npm -v
if errorlevel 1 (
    echo 未找到 npm 命令，請確認已安裝 npm 並加入 PATH。
    pause
    exit /b 1
)

rem 3) 安裝依賴
echo.
echo [步驟 3] 安裝依賴：npm install ...
npm install
if errorlevel 1 (
    echo npm install 出錯，請向上滾動查看具體錯誤信息。
    pause
    exit /b 1
)

rem 4) 編譯 TypeScript
echo.
echo [步驟 4] 編譯 TypeScript：npm run compile ...
npm run compile
if errorlevel 1 (
    echo 編譯失敗，請向上滾動查看具體錯誤信息。
    pause
    exit /b 1
)

rem 5) 自動遞增 patch 版本並打包 VSIX
echo.
echo [步驟 5] 自動遞增 patch 版本並打包 VSIX...
npm run package:vsix
if errorlevel 1 (
    echo 打包 VSIX 失敗，請向上滾動查看具體錯誤信息。
    pause
    exit /b 1
)

rem 6) 顯示當前目錄下的 vsix 文件
echo.
echo [步驟 6] 查找已生成的 VSIX 文件...
set "VSIX_FOUND=0"
for %%F in (*.vsix) do (
    echo  - 已生成: %%F
    set "VSIX_FOUND=1"
)

if "%VSIX_FOUND%"=="0" (
    echo 未在當前目錄找到 .vsix 文件，請確認 vsce 是否成功輸出。
) else (
    echo.
    echo ********************************************
    echo 打包完成！請在當前目錄使用上面列出的
    echo VSIX 文件，在 Cursor / VS Code 中：
    echo   擴展面板 -> ... -> 從 VSIX 安裝 -> 選擇該文件
    echo ********************************************
)

echo.
pause
exit /b 0
