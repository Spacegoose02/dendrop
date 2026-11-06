; Updates reinstall over the old copy; only a real uninstall stops Dendrop starting with Windows.
!macro customUnInstall
  ${ifNot} ${isUpdated}
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Dendrop"
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run" "Dendrop"
  ${endIf}
!macroend
