@echo off
setlocal
set CSC=%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe
set OUT=bin\HyperXBattery-cli.exe

if not exist bin mkdir bin

"%CSC%" /target:exe ^
        /out:%OUT% ^
        /reference:System.dll ^
        /reference:System.Core.dll ^
        /optimize+ ^
        /nologo ^
        Cli.cs BatteryReader.cs

if %ERRORLEVEL% neq 0 (
  echo Build FAILED
  exit /b %ERRORLEVEL%
)

for %%I in (%OUT%) do echo Built %%~fI  (%%~zI bytes)
