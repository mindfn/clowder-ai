; Cat Cafe — Inno Setup Installer Script
; Builds an offline Windows .exe installer that bundles source + deps + Electron shell.
;
; Prerequisites: Inno Setup 6.x (https://jrsoftware.org/isinfo.php)
; Build:         iscc.exe desktop\installer\cat-cafe.iss
;
; The installer:
;   1. Ships bulk tar.gz archives (deploy packages, Electron, Node.js)
;      instead of 30K+ individual files — eliminates per-file NTFS + Defender
;      overhead that caused 10+ min installs
;   2. Extracts archives post-install using Windows' built-in tar.exe
;   3. Copies small files directly (skills, docs, scripts, Redis, CLI tarballs)
;   4. Runs post-install-offline.ps1 for .env / skills / CLI tools setup
;   5. Runs user-level Agent CLI hook sync under the invoking user profile
;   6. Creates desktop shortcut to the Electron app

#define MyAppName      "Cat Cafe"
; MyAppVersion can be overridden by iscc /DMyAppVersion=X.Y.Z (CI release pipeline).
; Default kept for local manual builds.
#ifndef MyAppVersion
  #define MyAppVersion "0.2.0"
#endif
#define MyAppPublisher "Cat Cafe"
#define MyAppURL       "https://github.com/zts212653/cat-cafe"
#define MyAppExeName   "Cat Cafe.exe"

[Setup]
AppId={{A1B2C3D4-E5F6-7890-ABCD-EF1234567890}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
AppPublisherURL={#MyAppURL}
DefaultDirName={autopf}\CatCafe
DefaultGroupName={#MyAppName}
OutputDir=..\..\dist
OutputBaseFilename=CatCafe-Setup-{#MyAppVersion}
Compression=lzma2/ultra64
SolidCompression=yes
WizardStyle=modern
PrivilegesRequired=admin
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
SetupIconFile=..\assets\icon.ico
UninstallDisplayIcon={app}\desktop\assets\icon.ico
LicenseFile=..\..\LICENSE

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"
Name: "chinese_simplified"; MessagesFile: "compiler:Languages\ChineseSimplified.isl"

[Types]
Name: "full";    Description: "Full installation (all CLI tools)"
Name: "minimal"; Description: "Minimal (no extra CLI tools)"; Flags: iscustom

[Components]
Name: "core";         Description: "Cat Cafe Core (required)";      Types: full minimal; Flags: fixed
Name: "cli_claude";   Description: "Claude CLI (Anthropic)";          Types: full
Name: "cli_codex";    Description: "Codex CLI (OpenAI)";              Types: full
Name: "cli_antigravity"; Description: "Antigravity CLI (Google agy)";  Types: full
Name: "cli_kimi";     Description: "Kimi CLI (Moonshot)";             Types: full

[Dirs]
; Target directories for tar.exe archive extraction ([Run] section).
; Must exist before tar -C writes into them.
Name: "{app}\packages\api"; Components: core
Name: "{app}\packages\web"; Components: core
Name: "{app}\packages\mcp-server"; Components: core
Name: "{app}\desktop-dist"; Components: core
Name: "{app}\node"; Components: core

[Files]
; ── Bulk archives ─────────────────────────────────────────────────────
; Shipped as tar.gz and extracted post-install by Windows' built-in tar.exe.
; This replaces per-file Inno Setup extraction of 30K+ node_modules files,
; eliminating per-file NTFS + Defender overhead (10+ min → <2 min install).
Source: "..\..\bundled\archives\deploy-api.tar.gz";        DestDir: "{app}\bundled\archives"; Components: core
Source: "..\..\bundled\archives\deploy-web.tar.gz";        DestDir: "{app}\bundled\archives"; Components: core
Source: "..\..\bundled\archives\deploy-mcp-server.tar.gz"; DestDir: "{app}\bundled\archives"; Components: core
Source: "..\..\bundled\archives\electron.tar.gz";           DestDir: "{app}\bundled\archives"; Components: core
Source: "..\..\bundled\archives\node.tar.gz";               DestDir: "{app}\bundled\archives"; Components: core
; ── Individual files (small — per-file overhead negligible) ───────────
; cat-template.json — the authoritative source for cat model defaults.
; cat-config-loader.js resolves it relative to its own location 4 dirs up
; (= install root). Without this file, getCatModel("codex") falls back to
; the hardcoded CAT_CONFIGS default ("codex") which fox/custom proxies
; don't recognize — yielding 404 on every CLI invocation.
Source: "..\..\cat-template.json";               DestDir: "{app}"; Components: core
; Repository structure so findMonorepoRoot() resolves correctly at install root.
; Without pnpm-workspace.yaml at {app}, the monorepo marker walks above Program
; Files, which breaks docs/skills/package resolution paths in the API.
Source: "..\..\pnpm-workspace.yaml";             DestDir: "{app}"; Components: core
Source: "..\..\package.json";                    DestDir: "{app}"; Components: core
; Skills manifest — loaded by API routes/capabilities.ts when listing available
; skills. Missing → skills panel shows empty; cats lose skill context.
Source: "..\..\cat-cafe-skills\*";               DestDir: "{app}\cat-cafe-skills"; \
  Flags: recursesubdirs createallsubdirs; Components: core
; Documentation directories used by git-doc-reader and feat-index-doc-import
; routes (features, threads, architecture). Missing → /api/docs/* returns 404.
Source: "..\..\docs\*";                          DestDir: "{app}\docs"; \
  Flags: recursesubdirs createallsubdirs; Components: core
; Service recommendation matrix — loaded synchronously at API startup by
; recommendation-matrix-data.ts via the import chain (services route → index).
; Missing → API crashes with ENOENT at launch.
Source: "..\..\scripts\services\recommendation-matrix.yaml"; DestDir: "{app}\scripts\services"; Components: core
; (Node.js runtime is shipped as node.tar.gz in bulk archives above)
; Desktop scripts (post-install config generation)
Source: "..\scripts\post-install-offline.ps1";   DestDir: "{app}\scripts"; Components: core
Source: "..\scripts\generate-desktop-config.ps1"; DestDir: "{app}\scripts"; Components: core
Source: "..\scripts\sync-agent-hooks-offline.mjs"; DestDir: "{app}\scripts"; Components: core
; User-level Agent CLI hook truth source used by F180 health/sync.
Source: "..\..\.claude\hooks\user-level\*";      DestDir: "{app}\.claude\hooks\user-level"; \
  Flags: recursesubdirs createallsubdirs; Components: core
; (Electron app is shipped as electron.tar.gz in bulk archives above)
; Desktop assets (icon used by uninstaller entry)
Source: "..\assets\*";                           DestDir: "{app}\desktop\assets"; \
  Flags: recursesubdirs createallsubdirs; Components: core
; CLI tool tarballs (offline install — produced by build-desktop.ps1)
Source: "..\..\bundled\cli-tools\*";             DestDir: "{app}\bundled\cli-tools"; \
  Flags: recursesubdirs createallsubdirs; Components: core
; Portable Redis for Windows
Source: "..\..\bundled\redis\*";                 DestDir: "{app}\.cat-cafe\redis\windows"; \
  Flags: recursesubdirs createallsubdirs; Components: core

[Icons]
Name: "{group}\{#MyAppName}";        Filename: "{app}\desktop-dist\{#MyAppExeName}"
Name: "{autodesktop}\{#MyAppName}";  Filename: "{app}\desktop-dist\{#MyAppExeName}"
Name: "{group}\Uninstall {#MyAppName}"; Filename: "{uninstallexe}"

[Run]
; ── Extract bulk archives (tar.exe built into Windows 10 1803+) ───────
Filename: "tar.exe"; \
  Parameters: "-xzf ""{app}\bundled\archives\deploy-api.tar.gz"" -C ""{app}\packages\api"""; \
  StatusMsg: "Extracting API runtime..."; \
  Flags: runhidden waituntilterminated; Components: core
Filename: "tar.exe"; \
  Parameters: "-xzf ""{app}\bundled\archives\deploy-web.tar.gz"" -C ""{app}\packages\web"""; \
  StatusMsg: "Extracting Web runtime..."; \
  Flags: runhidden waituntilterminated; Components: core
Filename: "tar.exe"; \
  Parameters: "-xzf ""{app}\bundled\archives\deploy-mcp-server.tar.gz"" -C ""{app}\packages\mcp-server"""; \
  StatusMsg: "Extracting MCP Server..."; \
  Flags: runhidden waituntilterminated; Components: core
Filename: "tar.exe"; \
  Parameters: "-xzf ""{app}\bundled\archives\electron.tar.gz"" -C ""{app}\desktop-dist"""; \
  StatusMsg: "Extracting Electron shell..."; \
  Flags: runhidden waituntilterminated; Components: core
Filename: "tar.exe"; \
  Parameters: "-xzf ""{app}\bundled\archives\node.tar.gz"" -C ""{app}\node"""; \
  StatusMsg: "Extracting Node.js runtime..."; \
  Flags: runhidden waituntilterminated; Components: core
; Clean up archives after extraction (saves ~100 MB disk space)
Filename: "cmd.exe"; \
  Parameters: "/c rmdir /s /q ""{app}\bundled\archives"""; \
  StatusMsg: "Cleaning up temporary files..."; \
  Flags: runhidden waituntilterminated; Components: core
; ── Post-install configuration ────────────────────────────────────────
; Enable Windows long paths — pnpm creates paths > 260 chars
Filename: "reg.exe"; \
  Parameters: "add ""HKLM\SYSTEM\CurrentControlSet\Control\FileSystem"" /v LongPathsEnabled /t REG_DWORD /d 1 /f"; \
  StatusMsg: "Enabling long path support..."; \
  Flags: runhidden waituntilterminated; Components: core
; Post-install: .env, skills, CLI tools (single source of truth for CLI provisioning).
; Switch params are only present when the user selected that component — avoids the
; -File mode pitfall where -Switch $false still sets .IsPresent to $true.
Filename: "powershell.exe"; \
  Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\scripts\post-install-offline.ps1"" -AppDir ""{app}""{code:CliSwitches|}"; \
  StatusMsg: "Configuring Cat Cafe..."; \
  Flags: runhidden waituntilterminated; \
  Components: core
; User-level Agent CLI hook sync writes to ~/.claude and ~/.codex, so it must
; run as the invoking user rather than the elevated installer account.
; If Windows cannot recover the original credentials, Hub health check repairs it later.
Filename: "powershell.exe"; \
  Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\scripts\post-install-offline.ps1"" -AppDir ""{app}"" -AgentHooksOnly"; \
  StatusMsg: "Configuring Agent CLI hooks..."; \
  Flags: runhidden waituntilterminated runasoriginaluser; \
  Components: core

; Generate desktop-config.json with selected components
Filename: "powershell.exe"; \
  Parameters: "-ExecutionPolicy Bypass -Command ""& '{app}\scripts\generate-desktop-config.ps1' -AppDir '{app}' -Claude {code:BoolComponent|cli_claude} -Codex {code:BoolComponent|cli_codex} -Antigravity {code:BoolComponent|cli_antigravity} -Kimi {code:BoolComponent|cli_kimi}"""; \
  StatusMsg: "Generating desktop configuration..."; \
  Flags: runhidden waituntilterminated

; Offer to launch after install
Filename: "{app}\desktop-dist\{#MyAppExeName}"; \
  Description: "Launch {#MyAppName}"; Flags: postinstall nowait skipifsilent

[Code]
function BoolComponent(Param: String): String;
begin
  if WizardIsComponentSelected(Param) then
    Result := '$true'
  else
    Result := '$false';
end;

{ Returns only the -Switch flags for CLI components the user selected.
  Used with -File mode where switches must be absent (not "$false") to be off. }
function CliSwitches(Param: String): String;
begin
  Result := '';
  if WizardIsComponentSelected('cli_claude') then Result := Result + ' -Claude';
  if WizardIsComponentSelected('cli_codex')  then Result := Result + ' -Codex';
  if WizardIsComponentSelected('cli_antigravity') then Result := Result + ' -Antigravity';
  if WizardIsComponentSelected('cli_kimi')   then Result := Result + ' -Kimi';
end;

[UninstallRun]
Filename: "powershell.exe"; \
  Parameters: "-ExecutionPolicy Bypass -Command ""Stop-Process -Name 'Cat Cafe' -Force -ErrorAction SilentlyContinue"""; \
  Flags: runhidden

[UninstallDelete]
; Directories created by tar.exe extraction are not tracked by Inno Setup's
; built-in file registry — must be explicitly listed for clean removal.
Type: filesandordirs; Name: "{app}\packages"
Type: filesandordirs; Name: "{app}\desktop-dist"
Type: filesandordirs; Name: "{app}\node"
Type: filesandordirs; Name: "{app}\bundled"
