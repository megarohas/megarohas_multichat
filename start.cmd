@echo off
setlocal
set "DIR=%~dp0"
if exist "%DIR%runtime\node\node.exe" (
  set "NODE=%DIR%runtime\node\node.exe"
) else (
  set "NODE=node"
)
"%NODE%" "%DIR%server.js" %*
