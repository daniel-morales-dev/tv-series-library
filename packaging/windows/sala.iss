; Sala para Windows 11: instalador Inno Setup 6.
; Compilar (el payload lo prepara .github/workflows/build-windows-installer.yml en packaging\windows\payload):
;   iscc /DAppVersion=1.0.0 packaging\windows\sala.iss
; Salida: packaging\windows\output\sala-setup-<version>.exe

#ifndef AppVersion
  #define AppVersion "0.0.0-dev"
#endif

#define SourceDir AddBackslash(SourcePath)
#define PayloadDir SourceDir + "payload"

[Setup]
AppId={{662CE837-27B3-4316-8AA4-14B4FC3950AA}
AppName=Sala
AppVersion={#AppVersion}
AppVerName=Sala {#AppVersion}
DefaultDirName={autopf}\Sala
DefaultGroupName=Sala
DisableProgramGroupPage=yes
PrivilegesRequired=admin
MinVersion=10.0
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
OutputDir=output
OutputBaseFilename=sala-setup-{#AppVersion}
UninstallDisplayName=Sala
DirExistsWarning=no
; La app no escribe nada bajo {app}: el estado vive en %LOCALAPPDATA%\sala (base, imagenes, HLS, copias).

[Messages]
; El instalador no toca la configuracion: la app guia el primer arranque (carpeta, token TMDB opcional).
FinishedLabel=Sala quedo instalada. Al abrirse en el navegador te guiara paso a paso: elegir la carpeta de tus series y peliculas y, si quieres, agregar tu token de TMDB para los posters.

[Files]
Source: "{#PayloadDir}\node\node.exe"; DestDir: "{app}\node"
Source: "{#PayloadDir}\ffmpeg\bin\ffmpeg.exe"; DestDir: "{app}\ffmpeg\bin"
Source: "{#PayloadDir}\ffmpeg\bin\ffprobe.exe"; DestDir: "{app}\ffmpeg\bin"
Source: "{#SourceDir}sala-launcher.vbs"; DestDir: "{app}"
Source: "{#PayloadDir}\package.json"; DestDir: "{app}"
Source: "{#PayloadDir}\scripts\dev.mjs"; DestDir: "{app}\scripts"
Source: "{#PayloadDir}\apps\server\package.json"; DestDir: "{app}\apps\server"
Source: "{#PayloadDir}\apps\server\src\*"; DestDir: "{app}\apps\server\src"; Flags: recursesubdirs createallsubdirs
Source: "{#PayloadDir}\apps\server\node_modules\*"; DestDir: "{app}\apps\server\node_modules"; Flags: recursesubdirs createallsubdirs
Source: "{#PayloadDir}\apps\web\dist\*"; DestDir: "{app}\apps\web\dist"; Flags: recursesubdirs createallsubdirs

[Icons]
Name: "{group}\Sala"; Filename: "{sys}\wscript.exe"; Parameters: """{app}\sala-launcher.vbs"""; WorkingDir: "{app}"; Comment: "Abrir Sala"
Name: "{group}\{cm:UninstallProgram,Sala}"; Filename: "{uninstallexe}"
Name: "{userstartup}\Sala"; Filename: "{sys}\wscript.exe"; Parameters: """{app}\sala-launcher.vbs"""; WorkingDir: "{app}"; Comment: "Iniciar Sala al iniciar sesion"

[Run]
Filename: "{sys}\netsh.exe"; Parameters: "advfirewall firewall add rule name=""Sala 8080"" dir=in action=allow protocol=TCP localport=8080 remoteip=LocalSubnet"; Flags: runhidden; StatusMsg: "Permitiendo el acceso desde la red local (puerto 8080)..."
Filename: "{sys}\wscript.exe"; Parameters: """{app}\sala-launcher.vbs"""; WorkingDir: "{app}"; Description: "Iniciar Sala y abrir el navegador"; Flags: postinstall nowait skipifsilent runasoriginaluser

[UninstallRun]
Filename: "{sys}\netsh.exe"; Parameters: "advfirewall firewall delete rule name=""Sala 8080"""; Flags: runhidden; RunOnceId: "RemoveFirewallRule"

[UninstallDelete]
; Restos de {app} (logs, caches) que no son archivos instalados. Los datos del usuario viven en %LOCALAPPDATA%\sala.
Type: filesandordirs; Name: "{app}"

[Code]
// Mata solo los node/ffmpeg que viven bajo {app} (por ruta, no por nombre de imagen: no toca otros Node del usuario).
procedure StopSalaProcesses();
var
  ResultCode: Integer;
  Cmd: String;
begin
  Cmd := '-NoProfile -ExecutionPolicy Bypass -Command "Get-Process node,ffmpeg -ErrorAction SilentlyContinue | Where-Object { $_.Path -like ''' + ExpandConstant('{app}') + '\*'' } | Stop-Process -Force; Start-Sleep -Seconds 1"';
  Exec(ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe'), Cmd, '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
begin
  StopSalaProcesses();
  Result := '';
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin
  if CurUninstallStep = usUninstall then
  begin
    StopSalaProcesses();
    // Solo se pregunta en modo interactivo; en silencioso se conservan los datos.
    // Nunca se borra la carpeta de biblioteca ni los videos originales.
    if (not UninstallSilent()) and (MsgBox('¿Borrar también tus datos de Sala (catálogo, carátulas, progreso, ajustes y videos procesados)? Tus videos originales NO se borran.', mbConfirmation, MB_YESNO) = IDYES) then
      DelTree(ExpandConstant('{localappdata}\sala'), True, True, True);
  end;
end;
