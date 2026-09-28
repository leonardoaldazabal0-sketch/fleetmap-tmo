Option Explicit

Dim shell, fileSystem, scriptFolder, powerShellScript, command, exitCode

Set shell = CreateObject("WScript.Shell")
Set fileSystem = CreateObject("Scripting.FileSystemObject")

scriptFolder = fileSystem.GetParentFolderName(WScript.ScriptFullName)
powerShellScript = fileSystem.BuildPath(scriptFolder, "Cargador-TMO.ps1")
command = "powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File " & Chr(34) & powerShellScript & Chr(34)
If WScript.Arguments.Named.Exists("ValidateOnly") Then
    command = command & " -ValidateOnly"
End If

' El proceso se espera dentro de WScript, que no muestra consola. La ventana
' WinForms del cargador sigue visible y los errores de inicio se notifican.
exitCode = shell.Run(command, 0, True)
If exitCode <> 0 Then
    MsgBox "El Cargador TMO termino con un error. Revise su configuracion.", vbCritical, "Cargador TMO"
End If
