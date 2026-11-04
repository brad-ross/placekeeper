; NSIS 3.11, Unicode. Extraction only; the guarded coordinator owns activation.
Unicode true
RequestExecutionLevel user
SilentInstall silent
Name "Placekeeper"
OutFile "${OUTPUT}"
SetCompressor /SOLID lzma
!include "LogicLib.nsh"
!include "FileFunc.nsh"
Section
  InitPluginsDir
  SetOutPath "$PLUGINSDIR\candidate"
  File /r "${CANDIDATE}\*"
  WriteUninstaller "$PLUGINSDIR\candidate\Uninstall.exe"
  ${GetParameters} $1
  ; No copy, kill, Squirrel hook or independent install mutation happens here.
  ExecWait '"$PLUGINSDIR\candidate\resources\desktop\node\bin\node.exe" "$PLUGINSDIR\candidate\resources\desktop\installer\installer-entry.mjs" "$PLUGINSDIR\candidate" $1' $0
  ${If} $0 != 0
    SetErrorLevel $0
    MessageBox MB_OK|MB_ICONSTOP "Placekeeper installation stopped. Your previous installation and review work are retained. See the installer error for recovery instructions."
  ${EndIf}
SectionEnd

Section "Uninstall"
  ; The app's isolated installer UI performs guarded drain/backup and removes
  ; app-owned files and matching registrations from a separate staged runtime.
  ; A complete prior app and verified recovery backup remain available.
  ExecWait '"$INSTDIR\resources\desktop\node\bin\node.exe" "$INSTDIR\resources\desktop\installer\stage-uninstall.mjs" "$INSTDIR"' $0
  SetErrorLevel $0
SectionEnd
