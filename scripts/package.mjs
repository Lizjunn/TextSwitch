import { readFile, stat, mkdir, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const manifest = JSON.parse(await readFile(new URL('../extension/manifest.json', import.meta.url), 'utf8'));
for (const file of [manifest.background.service_worker, manifest.action.default_popup,
  ...manifest.content_scripts.flatMap((entry) => entry.js), ...Object.values(manifest.icons)]) {
  await stat(new URL(`../extension/${file}`, import.meta.url));
}
await mkdir(new URL('../release/', import.meta.url), { recursive: true });
const name = `TextSwitch-${manifest.version}.zip`;
if (!/^[\w.-]+$/.test(name)) throw new Error('Invalid release filename');
await rm(new URL(`../release/${name}`, import.meta.url), { force: true });
execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
  `
  $ErrorActionPreference = 'Stop'
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  Add-Type -AssemblyName System.IO.Compression
  $taskSource = (Resolve-Path -LiteralPath 'extension').Path
  $taskDestination = Join-Path (Get-Location) 'release\\${name}'
  $taskArchive = [System.IO.Compression.ZipFile]::Open($taskDestination, [System.IO.Compression.ZipArchiveMode]::Create)
  try {
    Get-ChildItem -LiteralPath $taskSource -Recurse -File | ForEach-Object {
      $taskEntry = $_.FullName.Substring($taskSource.Length + 1).Replace('\\', '/')
      [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($taskArchive, $_.FullName, $taskEntry, [System.IO.Compression.CompressionLevel]::Optimal) | Out-Null
    }
  } finally { $taskArchive.Dispose() }
  `], { cwd: root, stdio: 'inherit' });
console.log(`已生成 release/${name}`);
