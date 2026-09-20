#!/usr/bin/env node
/**
 * Workaround for Electron postinstall failing on Node.js 22+ where extract-zip
 * exits early and leaves a partial dist/ without path.txt.
 */
const { downloadArtifact } = require('@electron/get')
const { execFileSync } = require('child_process')
const fs = require('fs')
const path = require('path')

const electronDir = path.resolve(__dirname, '../node_modules/electron')
const { version } = require(path.join(electronDir, 'package.json'))
const distPath = path.join(electronDir, 'dist')

const PLATFORM_CONFIG = {
  darwin: {
    // Relative path written to path.txt, matching the electron npm package layout.
    binary: 'Electron.app/Contents/MacOS/Electron',
    verify: (dist) =>
      fs.existsSync(path.join(dist, 'Electron.app/Contents/Frameworks')),
    missingMessage: 'Frameworks directory missing',
  },
  win32: {
    binary: 'electron.exe',
    verify: (dist) => fs.existsSync(path.join(dist, 'electron.exe')),
    missingMessage: 'electron.exe missing',
  },
  linux: {
    binary: 'electron',
    verify: (dist) => fs.existsSync(path.join(dist, 'electron')),
    missingMessage: 'electron binary missing',
  },
}

const platformConfig = PLATFORM_CONFIG[process.platform]
if (!platformConfig) {
  throw new Error(`Unsupported platform for Electron fix: ${process.platform}`)
}

function isInstalled() {
  return (
    fs.existsSync(path.join(electronDir, 'path.txt')) &&
    platformConfig.verify(distPath)
  )
}

async function main() {
  if (isInstalled() && !process.argv.includes('--force')) {
    console.log('Electron binary already installed')
    return
  }

  const zipPath = await downloadArtifact({
    version,
    artifactName: 'electron',
    platform: process.platform,
    arch: process.arch,
    checksums: require(path.join(electronDir, 'checksums.json')),
    force: process.argv.includes('--force'),
  })

  console.log('Extracting', zipPath)
  if (!zipPath || !fs.existsSync(zipPath)) {
    throw new Error(`Electron artifact download failed: ${zipPath}`)
  }
  fs.rmSync(distPath, { recursive: true, force: true })
  fs.mkdirSync(distPath, { recursive: true })

  if (process.platform === 'win32') {
    execFileSync('tar', ['-xf', zipPath, '-C', distPath], { stdio: 'inherit' })
  } else {
    execFileSync('unzip', ['-o', zipPath, '-d', distPath], { stdio: 'inherit' })
  }

  if (!platformConfig.verify(distPath)) {
    throw new Error(
      `Extraction incomplete (${process.platform}): ${platformConfig.missingMessage}`
    )
  }

  fs.writeFileSync(path.join(electronDir, 'path.txt'), platformConfig.binary)
  console.log('Electron installed successfully')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
