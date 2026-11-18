param(
  [ValidateSet('tauri', 'electron')][string]$Shell,
  [string]$Worktree = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path,  # the repository folder
  [int]$MemoryAfter = 120,  # seconds after start; 0 = only the start-up time
  [int]$Port = 47830,
  [string]$ElectronExe = ''  # default: <repository>\node_modules\electron\dist\electron.exe
)
# T7 of docs/plans/tauri-shell.md (Windows); results and method in docs/plans/tauri-measurements.md.
# One measurement of a Platypus shell with the demo on: time to the first answer of /api/state with the window
# visible, then the memory of the whole process tree (shell + webview/renderers + Node engine) after $MemoryAfter s.
# Fresh temporary home, the loop's port and data folder. Stops only the process it started (by PID, whole tree).
$ErrorActionPreference = 'Stop'
Add-Type @'
using System; using System.Runtime.InteropServices; using System.Collections.Generic;
public static class Win {
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc f, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  public struct RECT { public int L, T, R, B; }
  public static bool AnyVisible(HashSet<uint> pids) {
    bool found = false;
    EnumWindows((h, l) => { uint p; GetWindowThreadProcessId(h, out p); RECT r;
      if (pids.Contains(p) && IsWindowVisible(h) && GetWindowRect(h, out r) && (r.R - r.L) > 300 && (r.B - r.T) > 200) { found = true; return false; }
      return true; }, IntPtr.Zero);
    return found;
  }
}
'@
function Get-Tree([int]$root) {
  $all = Get-CimInstance Win32_Process -Property ProcessId, ParentProcessId, Name
  $ids = New-Object 'System.Collections.Generic.HashSet[uint32]'; [void]$ids.Add([uint32]$root)
  do { $added = $false; foreach ($p in $all) { if ($ids.Contains([uint32]$p.ParentProcessId) -and $ids.Add([uint32]$p.ProcessId)) { $added = $true } } } while ($added)
  return , $ids
}
function Test-State { try { (Invoke-WebRequest -UseBasicParsing -TimeoutSec 1 "http://127.0.0.1:$Port/api/state").StatusCode -eq 200 } catch { $false } }

if (Test-State) { throw "port $Port is already in use: not measuring" }
$home2 = Join-Path $env:TEMP ('tauri-t7-home-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Force -Path (Join-Path $home2 '.claude\projects'), (Join-Path $home2 'AppData\Roaming'), (Join-Path $home2 'AppData\Local') | Out-Null
$psi = New-Object System.Diagnostics.ProcessStartInfo
if ($Shell -eq 'tauri') { $psi.FileName = Join-Path $Worktree 'shells\tauri\src-tauri\target\release\platypus.exe'; $psi.Arguments = '--demo' }
else {
  if (-not $ElectronExe) { $ElectronExe = Join-Path $Worktree 'node_modules\electron\dist\electron.exe' }
  $psi.FileName = $ElectronExe; $psi.Arguments = "`"$Worktree`" --demo"
}
$psi.UseShellExecute = $false; $psi.WorkingDirectory = $Worktree
$e = $psi.EnvironmentVariables
$e['HOME'] = $home2; $e['USERPROFILE'] = $home2; $e['APPDATA'] = (Join-Path $home2 'AppData\Roaming'); $e['LOCALAPPDATA'] = (Join-Path $home2 'AppData\Local')
$e['CLAUDE_CONFIG_DIR'] = (Join-Path $home2 '.claude'); $e['PLATYPUS_PORT'] = "$Port"; $e['PLATYPUS_DATA_DIR'] = (Join-Path $Worktree '.platypus-dev')
$aumid = 'com.platypus.desktop.measure'; $e['PLATYPUS_AUMID'] = $aumid  # Tauri registers this test ID for its toasts: removed below
$e.Remove('ELECTRON_RUN_AS_NODE')
$sw = [System.Diagnostics.Stopwatch]::StartNew()
$p = [System.Diagnostics.Process]::Start($psi)
$tState = $null; $tWin = $null
while ($sw.Elapsed.TotalSeconds -lt 30 -and ($tState -eq $null -or $tWin -eq $null)) {
  if ($tState -eq $null -and (Test-State)) { $tState = $sw.ElapsedMilliseconds }
  if ($tWin -eq $null -and [Win]::AnyVisible((Get-Tree $p.Id))) { $tWin = $sw.ElapsedMilliseconds }
  Start-Sleep -Milliseconds 50
}
$ready = if ($tState -ne $null -and $tWin -ne $null) { [math]::Max($tState, $tWin) } else { $null }
$mem = $null
if ($MemoryAfter -gt 0) {
  while ($sw.Elapsed.TotalSeconds -lt $MemoryAfter) { Start-Sleep -Milliseconds 500 }
  $tree = Get-Tree $p.Id
  $procs = foreach ($id in $tree) { Get-Process -Id $id -ErrorAction SilentlyContinue }
  $mem = [pscustomobject]@{
    processes  = @($procs).Count
    names      = ((@($procs) | Group-Object ProcessName | ForEach-Object { "$($_.Name) x$($_.Count) " + [math]::Round(($_.Group | Measure-Object WorkingSet64 -Sum).Sum / 1MB) + "/" + [math]::Round(($_.Group | Measure-Object PrivateMemorySize64 -Sum).Sum / 1MB) + " MB" }) -join ', ')
    workingMB  = [math]::Round((@($procs) | Measure-Object WorkingSet64 -Sum).Sum / 1MB, 1)
    privateMB  = [math]::Round((@($procs) | Measure-Object PrivateMemorySize64 -Sum).Sum / 1MB, 1)
  }
}
# stop the whole tree we started, children first (by PID only)
$tree = Get-Tree $p.Id
foreach ($id in ($tree | Where-Object { $_ -ne $p.Id })) { Stop-Process -Id $id -Force -ErrorAction SilentlyContinue }
Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 1
Remove-Item -Recurse -Force $home2 -ErrorAction SilentlyContinue
Remove-Item -Recurse -Force "HKCU:\Software\Classes\AppUserModelId\$aumid" -ErrorAction SilentlyContinue
[pscustomobject]@{ shell = $Shell; stateMs = $tState; windowMs = $tWin; readyMs = $ready; memory = $mem; portFree = -not (Test-State) } | ConvertTo-Json -Compress -Depth 4

