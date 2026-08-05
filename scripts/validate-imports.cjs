'use strict'

const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const ignored = new Set(['node_modules', '.git', 'dist', 'coverage', 'tmp'])
const sourceExtensions = new Set(['.js', '.cjs', '.mjs', '.ts', '.d.ts'])
const files = []
const failures = []

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ignored.has(entry.name)) continue
    const file = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(file)
    else if (sourceExtensions.has(path.extname(entry.name)) || entry.name.endsWith('.d.ts')) files.push(file)
  }
}

function resolveRelative(from, request) {
  const base = path.resolve(path.dirname(from), request)
  const candidates = [
    base,
    `${base}.js`,
    `${base}.cjs`,
    `${base}.mjs`,
    `${base}.json`,
    `${base}.node`,
    `${base}.d.ts`,
    path.join(base, 'index.js'),
    path.join(base, 'index.d.ts')
  ]
  return candidates.find(candidate => fs.existsSync(candidate))
}

walk(root)

const importPattern = /(?:require\s*\(\s*|from\s+|import\s*\(\s*)(['"])(\.\.?[\\/][^'"\n]+)\1/g
for (const file of files) {
  const text = fs.readFileSync(file, 'utf8')
  let match
  while ((match = importPattern.exec(text))) {
    if (!resolveRelative(file, match[2])) {
      failures.push(`${path.relative(root, file)} -> ${match[2]}`)
    }
  }
}

if (failures.length) {
  console.error('Standalone validation failed:')
  for (const failure of failures) console.error(`- ${failure}`)
  process.exitCode = 1
} else {
  console.log(`Validated ${files.length} source files and all relative imports.`)
}
