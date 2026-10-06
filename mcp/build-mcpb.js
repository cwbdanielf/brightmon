// Builds the BrightMon MCP deliverables:
//   1. artifacts/mcp/BrightMonMcpServer.mjs  — self-contained esbuild bundle
//      (stdio server + MCP SDK inlined) used by extraResources and as the
//      copyable claude_desktop_config.json target.
//   2. artifacts/BrightMon.mcpb              — Claude Desktop extension
//      (only when run directly; the beforePack hook only needs step 1).
'use strict'

const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')
const esbuild = require('esbuild')

const pkg = require('../package.json')

const ROOT = path.join(__dirname, '..')
const BUNDLE_DIR = path.join(ROOT, 'artifacts', 'mcp')
const BUNDLE_FILE = path.join(BUNDLE_DIR, 'BrightMonMcpServer.mjs')
const STAGE_DIR = path.join(ROOT, 'artifacts', 'mcp-bundle')
const MCPB_FILE = path.join(ROOT, 'artifacts', 'BrightMon.mcpb')

async function buildMcpBundle() {
  fs.mkdirSync(BUNDLE_DIR, { recursive: true })
  await esbuild.build({
    entryPoints: [path.join(__dirname, 'stdio-server.mjs')],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node18',
    outfile: BUNDLE_FILE,
    define: { __BRIGHTMON_VERSION__: JSON.stringify(pkg.version) },
    // mcpCommon.js is CJS (required by electron.js too); its `require('crypto')`
    // etc. need a real `require` in the ESM output for node builtins.
    banner: {
      js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);"
    },
    logLevel: 'info'
  })
  return BUNDLE_FILE
}

function stageMcpb() {
  fs.rmSync(STAGE_DIR, { recursive: true, force: true })
  fs.mkdirSync(STAGE_DIR, { recursive: true })
  fs.copyFileSync(BUNDLE_FILE, path.join(STAGE_DIR, 'BrightMonMcpServer.mjs'))

  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, 'manifest.json'), 'utf8'))
  manifest.version = pkg.version // keep in sync with the app
  fs.writeFileSync(path.join(STAGE_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8')
  return STAGE_DIR
}

async function packMcpb() {
  const stage = stageMcpb()
  fs.rmSync(MCPB_FILE, { force: true })
  // Proven on Windows: npx needs a shell here; args array + shell triggers a
  // deprecation warning but is the combination known to work.
  const result = spawnSync('npx', ['--yes', '@anthropic-ai/mcpb', 'pack', stage, MCPB_FILE], {
    cwd: ROOT,
    stdio: 'inherit',
    shell: true
  })
  if (result.status !== 0) {
    throw new Error(`mcpb pack failed with exit code ${result.status}`)
  }
  return MCPB_FILE
}

module.exports = { buildMcpBundle, stageMcpb, packMcpb, BUNDLE_FILE, MCPB_FILE }

if (require.main === module) {
  buildMcpBundle()
    .then(() => packMcpb())
    .then((file) => {
      console.log(`Built ${path.relative(ROOT, file)}`)
    })
    .catch((e) => {
      console.error(e)
      process.exit(1)
    })
}
