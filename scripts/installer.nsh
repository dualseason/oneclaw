; OneClaw NSIS 自定义钩子
; 解决托盘常驻模式下 WM_CLOSE 被拦截、安装器报"无法关闭"的问题

!macro KillOneClawNamedProcesses
  nsExec::ExecToLog 'taskkill /IM "虾虾.exe" /T /F'
  nsExec::ExecToLog 'taskkill /IM "OneClaw.exe" /T /F'
  nsExec::ExecToLog 'taskkill /IM "虾虾 Helper.exe" /T /F'
  nsExec::ExecToLog 'taskkill /IM "OneClaw Helper.exe" /T /F'
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
  Delete "$SMPROGRAMS\OneClaw.lnk"
  Delete "$SMPROGRAMS\虾虾.lnk"
  RMDir /r "$SMPROGRAMS\OneClaw"
  RMDir /r "$SMPROGRAMS\虾虾"
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

!macro customInit
  ; 升级安装前尽量把旧版主进程、Helper 和残留 runtime/node 进程全部清掉
  !insertmacro KillOneClawNamedProcesses
  !insertmacro KillInstallDirProcesses HKCU
  !insertmacro KillInstallDirProcesses HKLM
  ; 不依赖旧卸载器，直接清理旧安装目录与注册表，避免被“应用无法关闭”弹窗卡死
  !insertmacro ForceCleanupPreviousInstall HKCU
  !insertmacro ForceCleanupPreviousInstall HKLM
  Sleep 1200
!macroend

!macro customCheckAppRunning
  ; 覆盖默认检测逻辑：先按显示名和安装目录强制清理旧进程，避免托盘常驻导致升级中断
  !insertmacro KillOneClawNamedProcesses
  !insertmacro KillInstallDirProcesses HKCU
  !insertmacro KillInstallDirProcesses HKLM
  Sleep 1200
!macroend

!macro customUnInit
  ; 直接卸载当前版本时也先清理自己和 gateway 子进程，避免“应用无法关闭”
  !insertmacro KillOneClawNamedProcesses
  !insertmacro KillInstallDirProcesses HKCU
  !insertmacro KillInstallDirProcesses HKLM
  Sleep 1200
!macroend

!macro customInstall
  ; 回收旧版“显示名改名后”留下的可执行文件，避免升级后安装目录残留双份入口
  Delete "$INSTDIR\虾虾.exe"
  Delete "$INSTDIR\虾虾 Helper.exe"
!macroend
