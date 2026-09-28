Option Explicit

Dim shell, fileSystem, platformRoot, launcher, command

Set shell = CreateObject("WScript.Shell")
Set fileSystem = CreateObject("Scripting.FileSystemObject")

platformRoot = fileSystem.GetParentFolderName(WScript.ScriptFullName)
launcher = fileSystem.BuildPath(platformRoot, "aplicaciones\cargador-tmo\Abrir-Cargador-TMO.vbs")
command = "wscript.exe " & Chr(34) & launcher & Chr(34)

If WScript.Arguments.Named.Exists("ValidateOnly") Then
    command = command & " /ValidateOnly"
    shell.Run command, 0, True
Else
    shell.Run command, 0, False
End If
