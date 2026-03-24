; OneClaw NSIS hooks.
; Goal:
; 1) Ensure old processes and files never block reinstall/upgrade.
; 2) Backup existing user config and reset to a clean state for reinstall.

!macro KillOneClawNamedProcesses
  nsExec::ExecToLog 'taskkill /IM "万博虾虾.exe" /T /F'
  nsExec::ExecToLog 'taskkill /IM "万博虾虾 Helper.exe" /T /F'
  nsExec::ExecToLog 'taskkill /IM "虾虾.exe" /T /F'
  nsExec::ExecToLog 'taskkill /IM "虾虾 Helper.exe" /T /F'
  nsExec::ExecToLog 'taskkill /IM "OneClaw.exe" /T /F'
  nsExec::ExecToLog 'taskkill /IM "OneClaw Helper.exe" /T /F'
!macroend

!macro KillGatewayPortProcesses
  nsExec::ExecToLog `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -Command "$$ports = @(18789, 18791); $$pids = Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $$ports -contains $$_.LocalPort } | Select-Object -ExpandProperty OwningProcess -Unique; foreach ($$pid in $$pids) { Stop-Process -Id $$pid -Force -ErrorAction SilentlyContinue }"`
!macroend

!macro KillInstallDirProcesses ROOT_KEY
  ReadRegStr $0 ${ROOT_KEY} "${INSTALL_REGISTRY_KEY}" "InstallLocation"
  StrCmp $0 "" done_${ROOT_KEY}
  DetailPrint "Stopping processes under $0"
  nsExec::ExecToLog `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -Command "$$p = [System.IO.Path]::GetFullPath('$0'); Get-CimInstance Win32_Process | Where-Object { $$_.Path -and $$_.Path.StartsWith($$p, [System.StringComparison]::CurrentCultureIgnoreCase) } | ForEach-Object { Stop-Process -Id $$_.ProcessId -Force -ErrorAction SilentlyContinue }"`
  Sleep 1200
  done_${ROOT_KEY}:
!macroend

!macro PurgeLegacyShortcuts
  Delete "$DESKTOP\OneClaw.lnk"
  Delete "$DESKTOP\虾虾.lnk"
  Delete "$DESKTOP\万博虾虾.lnk"
  Delete "$SMPROGRAMS\OneClaw.lnk"
  Delete "$SMPROGRAMS\虾虾.lnk"
  Delete "$SMPROGRAMS\万博虾虾.lnk"
  RMDir /r "$SMPROGRAMS\OneClaw"
  RMDir /r "$SMPROGRAMS\虾虾"
  RMDir /r "$SMPROGRAMS\万博虾虾"
!macroend

!macro ForceCleanupPreviousInstall ROOT_KEY
  ReadRegStr $1 ${ROOT_KEY} "${INSTALL_REGISTRY_KEY}" "InstallLocation"
  StrCmp $1 "" cleanup_done_${ROOT_KEY}
  DetailPrint "Removing previous install at $1"
  nsExec::ExecToLog `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -Command "if (Test-Path -LiteralPath '$1') { Remove-Item -LiteralPath '$1' -Recurse -Force -ErrorAction SilentlyContinue }"`
  RMDir /r "$1"
  DeleteRegKey ${ROOT_KEY} "${UNINSTALL_REGISTRY_KEY}"
  !ifdef UNINSTALL_REGISTRY_KEY_2
    DeleteRegKey ${ROOT_KEY} "${UNINSTALL_REGISTRY_KEY_2}"
  !endif
  DeleteRegKey ${ROOT_KEY} "${INSTALL_REGISTRY_KEY}"
  !insertmacro PurgeLegacyShortcuts
  cleanup_done_${ROOT_KEY}:
!macroend

!macro BackupAndResetUserConfig
  DetailPrint "Backing up and resetting %USERPROFILE%\\.openclaw\\openclaw.json"
  nsExec::ExecToLog `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -Command "$$stateDir = Join-Path $$env:USERPROFILE '.openclaw'; if (!(Test-Path -LiteralPath $$stateDir)) { exit 0 }; $$configPath = Join-Path $$stateDir 'openclaw.json'; if (Test-Path -LiteralPath $$configPath) { $$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'; $$backupPath = Join-Path $$stateDir ('openclaw.json.before-reinstall-' + $$stamp + '.bak'); Copy-Item -LiteralPath $$configPath -Destination $$backupPath -Force -ErrorAction SilentlyContinue; Set-Content -LiteralPath $$configPath -Value '{}' -Encoding UTF8 }; $$markerFiles = @('oneclaw.config.json', 'openclaw-setup-baseline.json', 'openclaw.last-known-good.json'); foreach ($$name in $$markerFiles) { $$markerPath = Join-Path $$stateDir $$name; if (Test-Path -LiteralPath $$markerPath) { Remove-Item -LiteralPath $$markerPath -Force -ErrorAction SilentlyContinue } }"`
!macroend

!macro customInit
  ; Stop old processes first to avoid "cannot close app" install failures.
  !insertmacro KillOneClawNamedProcesses
  !insertmacro KillGatewayPortProcesses
  !insertmacro KillInstallDirProcesses HKCU
  !insertmacro KillInstallDirProcesses HKLM

  ; Remove stale install directories and registry entries from both scopes.
  !insertmacro ForceCleanupPreviousInstall HKCU
  !insertmacro ForceCleanupPreviousInstall HKLM

  ; Reinstall safety: backup old config and reset to clean defaults.
  !insertmacro BackupAndResetUserConfig
  Sleep 1200
!macroend

!macro customCheckAppRunning
  !insertmacro KillOneClawNamedProcesses
  !insertmacro KillGatewayPortProcesses
  !insertmacro KillInstallDirProcesses HKCU
  !insertmacro KillInstallDirProcesses HKLM
  Sleep 1200
!macroend

!macro customUnInit
  !insertmacro KillOneClawNamedProcesses
  !insertmacro KillGatewayPortProcesses
  !insertmacro KillInstallDirProcesses HKCU
  !insertmacro KillInstallDirProcesses HKLM
  Sleep 1200
!macroend

!macro customInstall
  ; Remove leftovers from legacy executable naming.
  Delete "$INSTDIR\万博虾虾.exe"
  Delete "$INSTDIR\万博虾虾 Helper.exe"
  Delete "$INSTDIR\虾虾.exe"
  Delete "$INSTDIR\虾虾 Helper.exe"
!macroend