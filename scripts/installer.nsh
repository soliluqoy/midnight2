!macro customInstall
  CreateShortCut "$SMPROGRAMS\Midnight recovery.lnk" "$INSTDIR\midnight-recovery.exe"
!macroend

!macro customUnInstall
  Delete "$SMPROGRAMS\Midnight recovery.lnk"
!macroend
