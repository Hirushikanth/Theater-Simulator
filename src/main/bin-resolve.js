/**
 * Binary resolution for ffmpeg / ffprobe.
 *
 * Pure module — deliberately NO electron import so it can be unit-tested in
 * plain node. Callers pass `isPackaged` in (ffmpeg-bridge.js reads it from
 * `app.isPackaged`).
 *
 * Background: `ffprobe-static` shipped a mislabeled darwin/arm64 binary (really
 * x86_64), which fails without Rosetta. The old code then fell back to the
 * bare name `'ffprobe'`, which resolves via PATH. That works in dev (terminal
 * PATH includes Homebrew) but a Finder-launched .app has a sparse PATH
 * (/usr/bin:/bin:/usr/sbin:/sbin), so every drag-drop analyze failed with
 * "ffprobe error: spawn ffprobe ENOENT".
 *
 * Strategy now:
 *   1. Gather candidates: bundled static binary + system hits (PATH plus
 *      well-known Homebrew/MacPorts dirs that GUI apps don't inherit).
 *   2. Keep only binaries that actually execute.
 *   3. Pick the NEWEST working one (system ffmpeg 9.x beats static 6.0;
 *      static 4.4.1 predates Atmos profile reporting, so a modern system
 *      ffprobe preserves full Atmos pre-hints; the bundled static remains
 *      the offline fallback that keeps the app working with zero setup).
 *   4. Only if nothing executes do we return the bare name (last resort,
 *      preserves the historical error shape instead of crashing at startup).
 */
import { execFileSync } from 'child_process'
import { existsSync } from 'fs'
import { join, delimiter } from 'path'
import { createRequire } from 'module'

// In the packaged CJS bundle `require` exists natively; under plain-node ESM
// (unit tests) fall back to createRequire bound to this file.
const _require = typeof require !== 'undefined' ? require : createRequire(import.meta.url)

/**
 * Extra directories GUI-launched apps should search. A Finder/open-launched
 * Electron app inherits a minimal PATH without Homebrew/MacPorts locations.
 */
function pathHintDirs() {
  if (process.platform === 'darwin') return ['/opt/homebrew/bin', '/usr/local/bin', '/opt/local/bin']
  if (process.platform === 'win32') return []
  return ['/usr/local/bin', '/opt/local/bin']
}

/**
 * Check that a binary actually executes on this machine.
 * Catches mislabeled-arch bundles (e.g. an x86_64 binary on arm64 without
 * Rosetta fails with EBADARCH / error -86 "bad CPU type in executable").
 */
export function binaryWorks(binPath) {
  try {
    execFileSync(binPath, ['-version'], { stdio: 'ignore', timeout: 8000 })
    return true
  } catch {
    return false
  }
}

/**
 * Parse `X.Y` out of `<tool> version X.Y...` output for ranking candidates.
 * Returns 0 when the version cannot be determined (still usable as fallback).
 */
export function binaryVersion(binPath) {
  try {
    const out = execFileSync(binPath, ['-version'], { encoding: 'utf8', timeout: 8000 })
    const m = out.match(/version\s+(?:n)?(\d+)(?:\.(\d+))?/i)
    if (!m) return 0
    return parseInt(m[1], 10) * 1000 + parseInt(m[2] || '0', 10)
  } catch {
    return 0
  }
}

/** Resolve the bundled static binary path, or null when unavailable. */
function staticPathFor(name) {
  try {
    if (name === 'ffmpeg') {
      const p = _require('ffmpeg-static')
      return typeof p === 'string' ? p : null
    }
    if (name === 'ffprobe') {
      const m = _require('@ffprobe-installer/ffprobe')
      return m && typeof m.path === 'string' ? m.path : null
    }
  } catch {
    return null
  }
  return null
}

/** All existing executables named `name` in hint dirs + PATH (deduped). */
function systemHits(name) {
  const exe = process.platform === 'win32' ? `${name}.exe` : name
  const dirs = [...pathHintDirs(), ...(process.env.PATH || '').split(delimiter)]
  const seen = new Set()
  const hits = []
  for (const dir of dirs) {
    if (!dir || seen.has(dir)) continue
    seen.add(dir)
    const full = join(dir, exe)
    if (existsSync(full)) hits.push(full)
  }
  return hits
}

/**
 * Resolve the best working binary for `name`.
 * @param {string} name - 'ffmpeg' | 'ffprobe'
 * @param {{ isPackaged?: boolean }} [opts]
 * @returns {string} absolute path to the newest working binary, or the bare
 *   name as a last resort when nothing on the machine executes.
 */
export function resolveBinary(name, opts = {}) {
  const { isPackaged = false } = opts
  const candidates = []
  const seen = new Set()
  const push = (p) => { if (p && !seen.has(p)) { seen.add(p); candidates.push(p) } }

  const sp = staticPathFor(name)
  if (sp && existsSync(sp)) {
    push(isPackaged ? sp.replace('app.asar', 'app.asar.unpacked') : sp)
  }
  for (const hit of systemHits(name)) push(hit)

  const working = candidates.filter(binaryWorks)
  if (working.length === 0) {
    console.error(
      `[bin-resolve] No working ${name} binary found ` +
      `(bundled static + PATH + Homebrew/MacPorts hints all failed). ` +
      `Install Rosetta or a native ${name} (e.g. 'brew install ffmpeg').`
    )
    return name
  }
  working.sort((a, b) => binaryVersion(b) - binaryVersion(a))
  const best = working[0]
  console.log(`[bin-resolve] ${name} -> ${best}`)
  return best
}
