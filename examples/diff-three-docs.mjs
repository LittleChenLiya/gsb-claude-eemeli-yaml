/**
 * Three-document diff example for `diffDocuments()`.
 *
 * The stream below contains three documents:
 *   1. a baseline document
 *   2. the same values, restyled (quotes, comments, indentation)
 *   3. changed values, with an alias replaced by an inline copy
 *
 * Run locally with:  npm run example:diff
 * (or directly:      node examples/diff-three-docs.mjs)
 */
import { diffDocuments, parseAllDocuments } from '../src/index.ts'

const source = `\
# baseline document
name: 'yaml'
items:
  - 1
  - 2
defaults: &defaults
  retries: 3
primary: *defaults
---
# same values, restyled
name: "yaml"
items:
    - 1
    - 2
defaults: &defaults
  retries: 3
primary: *defaults
---
# changed values, alias replaced by a copy
name: 'yaml'
items:
  - 1
  - 3
defaults: &defaults
  retries: 3
primary:
  retries: 3
`

const [base, restyled, changed] = parseAllDocuments(source, {
  keepSourceTokens: true
})

const fmtPath = path =>
  path.length === 0
    ? '(root)'
    : path
        .map(seg => (typeof seg === 'number' ? `[${seg}]` : `.${seg}`))
        .join('')
        .replace(/^\./, '')

const show = (label, diff) => {
  console.log(`\n=== ${label}: ${diff.status} ===`)
  console.log(
    `equal: ${diff.equal}, valueEqual: ${diff.valueEqual}, refsEqual: ${diff.refsEqual}`
  )
  for (const c of diff.changes) {
    const sides =
      c.a !== undefined || c.b !== undefined
        ? ` (${c.a ?? '∅'} → ${c.b ?? '∅'})`
        : ''
    console.log(`  ${c.kind} ${fmtPath(c.path)}: ${c.message}${sides}`)
  }
  for (const r of diff.refs)
    console.log(`  ref ${fmtPath(r.path)}: ${r.message} (${r.a} vs ${r.b})`)
}

show('baseline vs restyled', diffDocuments(base, restyled))
show('baseline vs changed', diffDocuments(base, changed))
show('restyled vs changed', diffDocuments(restyled, changed))
