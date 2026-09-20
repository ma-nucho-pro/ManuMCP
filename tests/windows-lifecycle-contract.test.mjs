import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scripts = Object.fromEntries([
  'install-windows.ps1',
  'start-windows.ps1',
  'install-tunnel-windows.ps1',
  'start-tunnel-windows.ps1',
  'stdio-entrypoint.ps1',
  'uninstall-windows.ps1',
  'windows-lifecycle.ps1',
].map((name) => [name, fs.readFileSync(path.join(root, 'scripts', name), 'utf8')]));

test('Windows lifecycle has one restart authority and an atomic update barrier', () => {
  assert.match(scripts['install-windows.ps1'], /-RestartCount 0/u);
  assert.match(scripts['install-tunnel-windows.ps1'], /-RestartCount 0/u);
  assert.match(scripts['install-windows.ps1'], /-MultipleInstances IgnoreNew/u);
  assert.match(scripts['install-tunnel-windows.ps1'], /-MultipleInstances IgnoreNew/u);
  assert.match(scripts['install-windows.ps1'], /New-ScheduledTaskTrigger -AtLogOn -User/u);
  assert.match(scripts['install-tunnel-windows.ps1'], /New-ScheduledTaskTrigger -AtLogOn -User/u);
  assert.match(scripts['install-windows.ps1'], /-StartWhenAvailable/u);
  assert.match(scripts['install-tunnel-windows.ps1'], /-StartWhenAvailable/u);
  assert.match(scripts['start-windows.ps1'], /Start-Process/u);
  assert.match(scripts['start-tunnel-windows.ps1'], /Start-Process/u);
  assert.match(scripts['start-windows.ps1'], /\$RunOnce/u);
  assert.match(scripts['start-tunnel-windows.ps1'], /\$RunOnce/u);
  assert.match(scripts['windows-lifecycle.ps1'], /Write-ManuMcpAtomicText/u);
  assert.match(scripts['windows-lifecycle.ps1'], /stop-request/u);
  assert.match(scripts['install-windows.ps1'], /TaskRegistered/u);
  assert.match(scripts['install-tunnel-windows.ps1'], /TaskRegistered/u);
});

test('Windows lifecycle rejects mixed roots and protects critical hashes', () => {
  assert.match(scripts['stdio-entrypoint.ps1'], /installation-manifest\.json/u);
  assert.match(scripts['stdio-entrypoint.ps1'], /Get-ManuMcpFileSha256/u);
  assert.match(scripts['start-windows.ps1'], /project-root\.txt/u);
  assert.match(scripts['start-windows.ps1'], /criticalFiles/u);
  assert.match(scripts['start-tunnel-windows.ps1'], /tunnel-install-manifest\.json/u);
  assert.match(scripts['install-windows.ps1'], /userSid/u);
  assert.match(scripts['install-tunnel-windows.ps1'], /userSid/u);
});

test('Tunnel readiness is stricter than local process availability', () => {
  assert.match(scripts['install-tunnel-windows.ps1'], /--require-control-plane-poll/u);
  assert.match(scripts['install-tunnel-windows.ps1'], /result -eq ["']ok/u);
  assert.match(scripts['install-tunnel-windows.ps1'], /healthz\.ok/u);
  assert.match(scripts['install-tunnel-windows.ps1'], /readyz\.ok/u);
  assert.match(scripts['install-tunnel-windows.ps1'], /control_plane_poll\.ok/u);
  assert.match(scripts['windows-lifecycle.ps1'], /@\('http', 'https'\)/u);
});

test('Windows scripts declare PowerShell 5.1 compatibility', () => {
  for (const [name, contents] of Object.entries(scripts)) {
    assert.match(contents, /#requires -Version 5\.1/u, `${name} must run on Windows PowerShell 5.1`);
  }
});

test('Windows PowerShell parser accepts lifecycle scripts', { skip: process.platform !== 'win32' }, () => {
  for (const name of Object.keys(scripts)) {
    const file = path.join(root, 'scripts', name);
    const command = '$path=$env:MANUMCP_TEST_PS_PATH;$tokens=$null;$errors=$null;[System.Management.Automation.Language.Parser]::ParseFile($path,[ref]$tokens,[ref]$errors)|Out-Null;if($errors.Count -gt 0){$errors|ForEach-Object{Write-Error $_.Message};exit 1}';
    const result = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command], {
      encoding: 'utf8',
      env: { ...process.env, MANUMCP_TEST_PS_PATH: file },
    });
    assert.equal(result.status, 0, `${name}: ${result.stderr || result.stdout}`);
  }
});
