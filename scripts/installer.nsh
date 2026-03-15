; OneClaw NSIS 自定义钩子
; 解决托盘常驻模式下 WM_CLOSE 被拦截、安装器报"无法关闭"的问题

!macro customInit
  ; 安装前强制终止正在运行的虾虾/OneClaw进程树（兼容新旧显示名）
  nsExec::ExecToLog 'taskkill /IM "虾虾.exe" /T /F'
  nsExec::ExecToLog 'taskkill /IM "OneClaw.exe" /T /F'
  nsExec::ExecToLog 'taskkill /IM "虾虾 Helper.exe" /T /F'
  nsExec::ExecToLog 'taskkill /IM "OneClaw Helper.exe" /T /F'
  ; 等待进程退出和文件句柄释放
  Sleep 1000
!macroend

!macro customInstall
  ; 回收旧版“显示名改名后”留下的可执行文件，避免升级后安装目录残留双份入口
  Delete "$INSTDIR\虾虾.exe"
  Delete "$INSTDIR\虾虾 Helper.exe"
!macroend
