// Catches claude:// links that Windows hands to the Store build of Claude.
//
// Under MSIX, Windows sends claude:// to the package's own handler, which
// starts `Claude.exe "claude://..."` on the default profile, and only the user
// can change that default (Settings, hash-protected). So while a profile is
// armed for a sign-in, we watch for that exact process, kill it before it can
// use the link, and hand the link to the armed profile instead.
const { spawn } = require('child_process');

// WMI creation events (polled every 0.2 s, no admin needed). The kill happens
// inside the watcher itself, so no round trip to Node delays it.
const SCRIPT = `
$ErrorActionPreference = 'Stop'
$exe = $env:BUNSHIN_CLAUDE_EXE
$q = "SELECT * FROM __InstanceCreationEvent WITHIN 0.2 WHERE TargetInstance ISA 'Win32_Process' AND TargetInstance.Name = 'Claude.exe'"
Register-CimIndicationEvent -Query $q -SourceIdentifier bunshin | Out-Null
[Console]::Out.WriteLine('{"ready":true}')
while ($true) {
  $e = Wait-Event -SourceIdentifier bunshin
  Remove-Event -EventIdentifier $e.EventIdentifier
  $p = $e.SourceEventArgs.NewEvent.TargetInstance
  $cmd = [string]$p.CommandLine
  if ($p.ExecutablePath -ne $exe -or $cmd -notmatch 'claude://' -or $cmd -match '--user-data-dir|--type=') { continue }
  Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
  $url = [regex]::Match($cmd, 'claude://[^"\\s]+').Value
  [Console]::Out.WriteLine((@{ pid = $p.ProcessId; url = $url } | ConvertTo-Json -Compress))
}
`;

function watchClaudeLinks(claudeExe, { onLink, onReady, onExit }) {
  const ps = spawn(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', SCRIPT],
    { windowsHide: true, env: { ...process.env, BUNSHIN_CLAUDE_EXE: claudeExe } },
  );
  let buf = '';
  ps.stdout.setEncoding('utf8');
  ps.stdout.on('data', (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.ready) onReady?.();
      else if (msg.url) onLink(msg.url, msg.pid);
    }
  });
  let stderr = '';
  ps.stderr.on('data', (d) => { stderr += d; });
  ps.on('exit', (code) => onExit?.(code, stderr.trim()));
  ps.on('error', (err) => onExit?.(-1, err.message));
  return { stop: () => ps.kill() };
}

module.exports = { watchClaudeLinks };
