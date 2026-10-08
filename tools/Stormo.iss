; Stormo installer (Inno Setup 6). Built with: node tools/make-installer.mjs
; ASCII characters only: Inno Setup reads this file as ANSI.
#ifndef AppVersion
  #define AppVersion "1.0.0"
#endif

[Setup]
AppId={{B7E3A1C2-5D4F-4E8A-9C61-2F0A7D3B8E15}
AppName=Stormo
AppVersion={#AppVersion}
AppPublisher=Stormo contributors
DefaultDirName={autopf}\Stormo
DefaultGroupName=Stormo
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
CloseApplications=yes
RestartApplications=no
SetupIconFile=..\assets\icon.ico
UninstallDisplayIcon={app}\Stormo.exe
UninstallDisplayName=Stormo
OutputDir=..\dist
OutputBaseFilename=Stormo-Setup
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
VersionInfoVersion={#AppVersion}.0
VersionInfoProductName=Stormo
VersionInfoDescription=Stormo setup

[Languages]
Name: "en"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "Create a desktop icon"; GroupDescription: "Icons:"

[Files]
Source: "..\dist\Stormo\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{autoprograms}\Stormo"; Filename: "{app}\Stormo.exe"
Name: "{autodesktop}\Stormo"; Filename: "{app}\Stormo.exe"; Tasks: desktopicon

[Run]
Filename: "{app}\Stormo.exe"; Description: "Launch Stormo"; Flags: nowait postinstall skipifsilent
