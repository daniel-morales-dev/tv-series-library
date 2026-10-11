' Sala - lanzador para Windows.
' Se ejecuta con wscript.exe (sin ventana): copia verificada de SQLite, servidor en segundo plano
' y apertura del navegador. Si el servidor ya responde, solo abre el navegador.
Option Explicit

Dim fso, shell, install, nodeExe, serverDir, envFile, userEnvFile, ffmpegDir, url
Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")

install = fso.GetParentFolderName(WScript.ScriptFullName)
nodeExe = fso.BuildPath(fso.BuildPath(install, "node"), "node.exe")
serverDir = fso.BuildPath(fso.BuildPath(install, "apps"), "server")
' .env opcionales: junto a la instalacion (si el usuario lo crea) y por usuario en %LOCALAPPDATA%\sala.
envFile = fso.BuildPath(install, ".env")
userEnvFile = fso.BuildPath(fso.BuildPath(shell.ExpandEnvironmentStrings("%LOCALAPPDATA%"), "sala"), ".env")
ffmpegDir = fso.BuildPath(fso.BuildPath(install, "ffmpeg"), "bin")
url = "http://127.0.0.1:8080"

' ffmpeg/ffprobe se lanzan por nombre; FFMPEG_BIN/FFPROBE_BIN los fijan de forma explicita.
shell.Environment("Process")("WEB_DIR") = fso.BuildPath(fso.BuildPath(fso.BuildPath(install, "apps"), "web"), "dist")
shell.Environment("Process")("PORT") = "8080"
shell.Environment("Process")("FFMPEG_BIN") = fso.BuildPath(ffmpegDir, "ffmpeg.exe")
shell.Environment("Process")("FFPROBE_BIN") = fso.BuildPath(ffmpegDir, "ffprobe.exe")
shell.Environment("Process")("PATH") = ffmpegDir & ";" & shell.Environment("Process")("PATH")

If HealthOk() Then
  OpenBrowser
  WScript.Quit 0
End If

' Copia verificada de SQLite antes de abrir la base; tambien detecta el puerto 8080 ocupado.
shell.CurrentDirectory = serverDir
Dim backupCode
backupCode = shell.Run(q(nodeExe) & " --env-file-if-exists=" & q(envFile) & " --env-file-if-exists=" & q(userEnvFile) & " src\cli\backup.ts", 0, True)
If backupCode <> 0 Then
  ' Carrera al abrir dos veces (inicio de sesion + acceso directo): el servidor puede estar arrancando.
  If HealthOk() Then
    OpenBrowser
    WScript.Quit 0
  End If
  MsgBox "No se pudo preparar Sala: el puerto 8080 esta ocupado o fallo la copia de seguridad." & vbCrLf & _
         "Cierra el programa que use el puerto 8080 y vuelve a intentarlo.", 16, "Sala"
  WScript.Quit 1
End If

' Servidor en segundo plano y sin ventana; sigue vivo al cerrarse este lanzador.
shell.Run q(nodeExe) & " --env-file-if-exists=" & q(envFile) & " --env-file-if-exists=" & q(userEnvFile) & " src\index.ts", 0, False

Dim waited
waited = 0
Do While waited < 30
  WScript.Sleep 1000
  waited = waited + 1
  If HealthOk() Then
    OpenBrowser
    WScript.Quit 0
  End If
Loop

MsgBox "Sala no respondio en 30 segundos." & vbCrLf & _
       "Puede que Windows haya bloqueado la aplicacion; vuelve a intentarlo.", 16, "Sala"
WScript.Quit 1

Function q(value)
  q = """" & value & """"
End Function

Function HealthOk()
  Dim http
  HealthOk = False
  On Error Resume Next
  Set http = CreateObject("WinHttp.WinHttpRequest.5.1")
  If Err.Number <> 0 Then Exit Function
  http.SetTimeouts 500, 500, 500, 1500
  http.Open "GET", "http://127.0.0.1:8080/api/health", False
  If Err.Number <> 0 Then Exit Function
  http.Send
  If Err.Number = 0 Then
    If http.Status = 200 Then HealthOk = True
  End If
  On Error GoTo 0
End Function

Sub OpenBrowser
  ' start con titulo vacio: abre la URL en el navegador predeterminado, sin consola visible.
  shell.Run "cmd /c start """" " & q(url), 0, False
End Sub
