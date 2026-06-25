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
const platformPath = 'Electron.app/Contents/MacOS/Electron'
const frameworksPath = path.join(distPath, 'Electron.app/Contents/Frameworks')

function isInstalled() {
  return (
    fs.existsSync(path.join(electronDir, 'path.txt')) &&
    fs.existsSync(frameworksPath)
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
  fs.rmSync(distPath, { recursive: true, force: true })
  fs.mkdirSync(distPath, { recursive: true })

  if (process.platform === 'win32') {
    execFileSync('tar', ['-xf', zipPath, '-C', distPath], { stdio: 'inherit' })
  } else {
    execFileSync('unzip', ['-o', zipPath, '-d', distPath], { stdio: 'inherit' })
  }

  if (!fs.existsSync(frameworksPath)) {
    throw new Error('Extraction incomplete: Frameworks directory missing')
  }

  fs.writeFileSync(path.join(electronDir, 'path.txt'), platformPath)
  console.log('Electron installed successfully')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
