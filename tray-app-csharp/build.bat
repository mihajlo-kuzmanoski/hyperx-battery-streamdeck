@echo off
setlocal
set CSC=%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe
set OUT=bin\HyperXBattery.exe

if not exist bin mkdir bin

"%CSC%" /target:winexe ^
        /out:%OUT% ^
        /win32manifest:app.manifest ^
        /reference:System.dll ^
        /reference:System.Drawing.dll ^
        /reference:System.Windows.Forms.dll ^
        /reference:System.Core.dll ^
        /optimize+ ^
        /nologo ^
        Program.cs BatteryReader.cs IconRenderer.cs

if %ERRORLEVEL% neq 0 (
  echo Build FAILED
  exit /b %ERRORLEVEL%
)

for %%I in (%OUT%) do echo Built %%~fI  (%%~zI bytes)
