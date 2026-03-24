@echo off
:: Exocortex launcher for Windows.
:: Starts the daemon in the background, launches the TUI,
:: and kills the daemon when the TUI exits.

setlocal

:: Resolve the directory this .bat lives in
set "DIR=%~dp0"

:: Start the daemon hidden (no console window)
start "" /B "%DIR%exocortexd.exe" >nul 2>&1

:: Give the daemon a moment to start listening
timeout /t 2 /nobreak >nul

:: Run the TUI in this console (blocks until user quits)
"%DIR%exocortex.exe"

:: TUI exited — kill the daemon
taskkill /F /IM exocortexd.exe >nul 2>&1

endlocal
