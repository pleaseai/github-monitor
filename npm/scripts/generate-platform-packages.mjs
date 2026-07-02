#!/usr/bin/env node
// Generate the per-platform npm packages from built release assets ("copy"
// distribution: the binary is copied into each package, no postinstall download).
//
//   node npm/scripts/generate-platform-packages.mjs <version> <assets-dir>
//
// <assets-dir> holds the github-monitor-channel-<target>[.exe] binaries produced
// by release-rust.yml. For each known target it writes npm/dist/<pkg>/ with a
// package.json (os/cpu constraints) + the binary, plus a wrapper package.json
// with pinned optionalDependencies. Publish each with `npm publish ./<dir>`.

import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const npmRoot = resolve(here, '..')

// asset = the file name emitted by release-rust.yml; binary = its name inside
// the published package (matches bin/github-monitor-channel.js resolution).
const TARGETS = [
  { pkg: '@pleaseai/github-monitor-darwin-arm64', asset: 'github-monitor-channel-darwin-arm64', binary: 'github-monitor-channel', os: 'darwin', cpu: 'arm64' },
  { pkg: '@pleaseai/github-monitor-darwin-x64', asset: 'github-monitor-channel-darwin-x64', binary: 'github-monitor-channel', os: 'darwin', cpu: 'x64' },
  { pkg: '@pleaseai/github-monitor-linux-x64', asset: 'github-monitor-channel-linux-x64', binary: 'github-monitor-channel', os: 'linux', cpu: 'x64', libc: 'glibc' },
  { pkg: '@pleaseai/github-monitor-linux-arm64', asset: 'github-monitor-channel-linux-arm64', binary: 'github-monitor-channel', os: 'linux', cpu: 'arm64' },
  { pkg: '@pleaseai/github-monitor-win32-x64', asset: 'github-monitor-channel-windows-x64.exe', binary: 'github-monitor-channel.exe', os: 'win32', cpu: 'x64' },
]

const [, , version, assetsDir] = process.argv
if (!version || !assetsDir) {
  process.stderr.write('usage: generate-platform-packages.mjs <version> <assets-dir>\n')
  process.exit(1)
}

const distRoot = join(npmRoot, 'dist')
mkdirSync(distRoot, { recursive: true })

const repoRoot = resolve(npmRoot, '..')
const base = JSON.parse(readFileSync(join(npmRoot, 'github-monitor', 'package.json'), 'utf8'))

// One package per target whose asset is present. A missing asset is skipped
// with a warning (partial matrix still publishes what built); only generated
// targets are pinned in the wrapper's optionalDependencies.
const generated = []
for (const t of TARGETS) {
  const src = join(assetsDir, t.asset)
  if (!existsSync(src)) {
    process.stderr.write(`skip ${t.pkg}: asset ${t.asset} not found in ${assetsDir}\n`)
    continue
  }

  const outDir = join(distRoot, t.pkg.replace('/', '__'))
  mkdirSync(outDir, { recursive: true })

  const pkg = {
    name: t.pkg,
    version,
    description: `github-monitor-channel binary for ${t.os}-${t.cpu}${t.libc ? ` (${t.libc})` : ''}.`,
    homepage: base.homepage,
    repository: base.repository,
    license: base.license,
    os: [t.os],
    cpu: [t.cpu],
    ...(t.libc ? { libc: [t.libc] } : {}),
    files: [t.binary],
  }
  writeFileSync(join(outDir, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`)

  const dest = join(outDir, t.binary)
  copyFileSync(src, dest)
  chmodSync(dest, 0o755)
  // Ship LICENSE in each platform package too (license scanners expect one per
  // published package directory).
  copyFileSync(join(repoRoot, 'LICENSE'), join(outDir, 'LICENSE'))
  generated.push(t)
  process.stdout.write(`wrote ${t.pkg}@${version} (${t.asset} -> ${t.binary})\n`)
}

if (generated.length === 0) {
  process.stderr.write('error: no assets matched any known target — nothing generated\n')
  process.exit(1)
}

// Stamp the wrapper with the release version + pinned optionalDependencies
// (only the targets actually generated this run).
const wrapper = {
  ...base,
  version,
  optionalDependencies: Object.fromEntries(generated.map(t => [t.pkg, version])),
}
const wrapperDir = join(distRoot, 'github-monitor')
mkdirSync(join(wrapperDir, 'bin'), { recursive: true })
mkdirSync(join(wrapperDir, 'lib'), { recursive: true })
writeFileSync(join(wrapperDir, 'package.json'), `${JSON.stringify(wrapper, null, 2)}\n`)
// The launcher shim, the postinstall copy-over, and the shared resolver.
copyFileSync(
  join(npmRoot, 'github-monitor', 'bin', 'github-monitor-channel.js'),
  join(wrapperDir, 'bin', 'github-monitor-channel.js'),
)
copyFileSync(join(npmRoot, 'github-monitor', 'install.js'), join(wrapperDir, 'install.js'))
copyFileSync(join(npmRoot, 'github-monitor', 'lib', 'resolve.js'), join(wrapperDir, 'lib', 'resolve.js'))

// Ship README + LICENSE in the published wrapper so the npm page renders docs.
copyFileSync(join(repoRoot, 'README.md'), join(wrapperDir, 'README.md'))
copyFileSync(join(repoRoot, 'LICENSE'), join(wrapperDir, 'LICENSE'))
process.stdout.write(`wrote wrapper @pleaseai/github-monitor@${version}\n`)
