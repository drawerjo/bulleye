Unicode true
!include "MUI2.nsh"
!define APP "bulleye"
!define VER "1.3.7"
!define UNKEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\bulleye"
Name "${APP}"
OutFile "..\out\bulleye-setup.exe"
InstallDir "$LOCALAPPDATA\Programs\bulleye"
RequestExecutionLevel user
SetCompressor /SOLID lzma
SetCompressorDictSize 32
BrandingText "bulleye ${VER}"
VIProductVersion "${VER}.0"
VIAddVersionKey "ProductName" "bulleye"
VIAddVersionKey "FileDescription" "bulleye installer"
VIAddVersionKey "FileVersion" "${VER}"
VIAddVersionKey "ProductVersion" "${VER}"
VIAddVersionKey "CompanyName" "Joseph"
VIAddVersionKey "LegalCopyright" "Copyright 2026 Joseph"
!define MUI_ICON "icon.ico"
!define MUI_UNICON "icon.ico"
!define MUI_INSTFILESPAGE_FINISHHEADER_TEXT "bulleye is installed"
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"

Function .onInit
  ; close a running copy so its files can be replaced
  nsExec::Exec 'taskkill /F /IM bulleye.exe'
FunctionEnd

Section "Install"
  SetOutPath "$INSTDIR"
  File /r "..\build-win/bulleye-win32-x64/*.*"
  CreateShortCut "$DESKTOP\bulleye.lnk" "$INSTDIR\bulleye.exe" "" "$INSTDIR\bulleye.exe" 0
  CreateDirectory "$SMPROGRAMS\bulleye"
  CreateShortCut "$SMPROGRAMS\bulleye\bulleye.lnk" "$INSTDIR\bulleye.exe" "" "$INSTDIR\bulleye.exe" 0
  WriteUninstaller "$INSTDIR\Uninstall bulleye.exe"
  WriteRegStr HKCU "${UNKEY}" "DisplayName" "bulleye"
  WriteRegStr HKCU "${UNKEY}" "DisplayVersion" "${VER}"
  WriteRegStr HKCU "${UNKEY}" "Publisher" "Joseph"
  WriteRegStr HKCU "${UNKEY}" "DisplayIcon" "$INSTDIR\bulleye.exe"
  WriteRegStr HKCU "${UNKEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${UNKEY}" "UninstallString" '"$INSTDIR\Uninstall bulleye.exe"'
  WriteRegDWORD HKCU "${UNKEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNKEY}" "NoRepair" 1
  SetAutoClose true
  Exec '"$INSTDIR\bulleye.exe"'
SectionEnd

Section "Uninstall"
  nsExec::Exec 'taskkill /F /IM bulleye.exe'
  Sleep 500
  Delete "$DESKTOP\bulleye.lnk"
  Delete "$SMPROGRAMS\bulleye\bulleye.lnk"
  RMDir "$SMPROGRAMS\bulleye"
  ; "Open with" entries that bulleye added for ebook files
  DeleteRegKey HKCU "Software\Classes\Applications\bulleye.exe"
  DeleteRegKey HKCU "Software\Classes\bulleye.ebook"
  DeleteRegValue HKCU "Software\Classes\.epub\OpenWithProgids" "bulleye.ebook"
  DeleteRegValue HKCU "Software\Classes\.mobi\OpenWithProgids" "bulleye.ebook"
  DeleteRegValue HKCU "Software\Classes\.azw3\OpenWithProgids" "bulleye.ebook"
  DeleteRegValue HKCU "Software\Classes\.azw\OpenWithProgids" "bulleye.ebook"
  DeleteRegValue HKCU "Software\Classes\.kf8\OpenWithProgids" "bulleye.ebook"
  DeleteRegValue HKCU "Software\Classes\.fb2\OpenWithProgids" "bulleye.ebook"
  DeleteRegValue HKCU "Software\Classes\.cbz\OpenWithProgids" "bulleye.ebook"
  DeleteRegKey HKCU "${UNKEY}"
  RMDir /r "$INSTDIR"
SectionEnd
