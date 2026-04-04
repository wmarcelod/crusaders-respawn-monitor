@echo off
echo Building Crusaders Monitor TS3 Plugin...
echo.

REM Compile the plugin DLL
gcc -shared -o crusaders_monitor_win64.dll src/plugin.c -Isdk/include -lwinhttp -O2 -Wall

if %ERRORLEVEL% NEQ 0 (
    echo.
    echo BUILD FAILED!
    pause
    exit /b 1
)

echo DLL compiled: crusaders_monitor_win64.dll
echo.

REM Create .ts3_plugin package (zip with package.ini + dll in plugins/ folder)
if exist crusaders_monitor.ts3_plugin del crusaders_monitor.ts3_plugin

REM Create temp directory structure
if exist _pkg rmdir /s /q _pkg
mkdir _pkg
mkdir _pkg\plugins
copy package.ini _pkg\
copy crusaders_monitor_win64.dll _pkg\plugins\

REM Package as zip -> .ts3_plugin
powershell -Command "Compress-Archive -Path '_pkg\*' -DestinationPath 'crusaders_monitor.zip' -Force"
if exist crusaders_monitor.ts3_plugin del crusaders_monitor.ts3_plugin
ren crusaders_monitor.zip crusaders_monitor.ts3_plugin

REM Cleanup
rmdir /s /q _pkg

echo.
echo Package created: crusaders_monitor.ts3_plugin
echo.
echo To install: double-click the .ts3_plugin file, or copy the DLL to:
echo   %%APPDATA%%\TS3Client\plugins\crusaders_monitor_win64.dll
echo.
pause
