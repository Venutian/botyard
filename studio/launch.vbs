' Build and launch hidden, then open the browser.
Option Explicit
Dim sh, fso, base, result
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
base = fso.GetParentFolderName(WScript.ScriptFullName)
result = sh.Run("powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & base & "\tools\launch.ps1""", 0, True)
If result <> 0 Then
  MsgBox "Botyard did not start. See launcher\launcher-error.log in your Botyard home folder (" & sh.ExpandEnvironmentStrings("%USERPROFILE%") & "\.botyard unless you chose another).", vbExclamation, "Botyard"
End If
