import { Readable } from 'stream'
import { Document, diffDocuments, parseAllDocuments, parseDocument } from 'yaml'
import { cli } from 'yaml/cli'

describe('value vs format changes', () => {
  test('single to double quotes is a format-only change', () => {
    const a = parseDocument("'foo'")
    const b = parseDocument('"foo"')
    const diff = diffDocuments(a, b)
    expect(diff.status).toBe('format')
    expect(diff.equal).toBe(false)
    expect(diff.valueEqual).toBe(true)
    expect(diff.changes.length).toBeGreaterThan(0)
    expect(diff.changes.every(c => c.kind === 'format')).toBe(true)
    expect(diff.changes.some(c => c.message.includes('quote style'))).toBe(true)
  })

  test('changed scalar value is a value difference', () => {
    const diff = diffDocuments(parseDocument("'foo'"), parseDocument("'bar'"))
    expect(diff.status).toBe('value')
    expect(diff.valueEqual).toBe(false)
    expect(diff.changes).toMatchObject([
      { kind: 'value', path: [], a: '"foo"', b: '"bar"' }
    ])
  })

  test('comment change is format-only', () => {
    const a = parseDocument('a: 1 # first')
    const b = parseDocument('a: 1 # second')
    const diff = diffDocuments(a, b)
    expect(diff.status).toBe('format')
    expect(diff.valueEqual).toBe(true)
    expect(diff.changes.some(c => c.message.includes('comment'))).toBe(true)
  })

  test('indentation change is format-only', () => {
    // Indentation is read from source tokens, kept with keepSourceTokens.
    const a = parseDocument('a:\n  b: 1\n', { keepSourceTokens: true })
    const b = parseDocument('a:\n    b: 1\n', { keepSourceTokens: true })
    const diff = diffDocuments(a, b)
    expect(diff.status).toBe('format')
    expect(diff.valueEqual).toBe(true)
    expect(diff.changes.some(c => c.message.includes('indentation'))).toBe(true)
  })

  test('flow vs block style is format-only', () => {
    const a = parseDocument('a: [1, 2]\n')
    const b = parseDocument('a:\n  - 1\n  - 2\n')
    const diff = diffDocuments(a, b)
    expect(diff.status).toBe('format')
    expect(diff.valueEqual).toBe(true)
  })

  test('identical documents are equal', () => {
    const diff = diffDocuments(
      parseDocument("a: 'x'\nb: [1, 2]\n"),
      parseDocument("a: 'x'\nb: [1, 2]\n")
    )
    expect(diff.status).toBe('equal')
    expect(diff.equal).toBe(true)
    expect(diff.changes).toEqual([])
    expect(diff.refs).toEqual([])
  })

  test('a document is equal to itself', () => {
    const doc = parseDocument('a: 1')
    expect(diffDocuments(doc, doc).equal).toBe(true)
  })
})

describe('map & seq pairing', () => {
  test('maps are paired by key identity, not position', () => {
    const a = parseDocument('{ a: 1, b: 2 }')
    const b = parseDocument('{ b: 2, a: 1 }')
    const diff = diffDocuments(a, b)
    expect(diff.status).toBe('equal')
    expect(diff.equal).toBe(true)
  })

  test('reordered keys with a changed value point at the right key', () => {
    const a = parseDocument('{ a: 1, b: 2 }')
    const b = parseDocument('{ b: 3, a: 1 }')
    const diff = diffDocuments(a, b)
    expect(diff.status).toBe('value')
    expect(diff.changes).toMatchObject([{ kind: 'value', path: ['b'] }])
  })

  test('added and removed map keys are value changes', () => {
    const a = parseDocument('a: 1\nb: 2\n')
    const b = parseDocument('a: 1\nc: 3\n')
    const diff = diffDocuments(a, b)
    expect(diff.status).toBe('value')
    expect(diff.changes).toMatchObject([
      { kind: 'value', path: ['b'], message: 'map key removed' },
      { kind: 'value', path: ['c'], message: 'map key added' }
    ])
  })

  test('sequences are compared by position', () => {
    const a = parseDocument('- 1\n- 2\n')
    const b = parseDocument('- 2\n- 1\n')
    const diff = diffDocuments(a, b)
    expect(diff.status).toBe('value')
    expect(diff.changes).toMatchObject([
      { kind: 'value', path: [0] },
      { kind: 'value', path: [1] }
    ])
  })

  test('quoted vs plain key is a format-only change', () => {
    const a = parseDocument('a: 1\n')
    const b = parseDocument('"a": 1\n')
    const diff = diffDocuments(a, b)
    expect(diff.status).toBe('format')
    expect(diff.valueEqual).toBe(true)
    expect(diff.changes.some(c => c.message.startsWith('key '))).toBe(true)
  })
})

describe('references: anchors, aliases, copies', () => {
  const withAlias = 'a: &x [1, 2]\nb: *x\n'
  const withCopy = 'a: [1, 2]\nb: [1, 2]\n'

  test('alias reuse vs copied node is marked separately, not as a value change', () => {
    const diff = diffDocuments(
      parseDocument(withAlias),
      parseDocument(withCopy)
    )
    expect(diff.valueEqual).toBe(true)
    expect(diff.refsEqual).toBe(false)
    expect(diff.equal).toBe(false)
    const atB = diff.refs.find(r => r.path.join('.') === 'b')
    expect(atB).toMatchObject({ a: 'alias *x', b: 'copy' })
    expect(diff.refs.some(r => r.anchor === 'x')).toBe(true)
  })

  test('mirrored alias vs copy is also marked', () => {
    const diff = diffDocuments(
      parseDocument(withCopy),
      parseDocument(withAlias)
    )
    expect(diff.valueEqual).toBe(true)
    const atB = diff.refs.find(r => r.path.join('.') === 'b')
    expect(atB).toMatchObject({ a: 'copy', b: 'alias *x' })
  })

  test('identical alias structure has no ref differences', () => {
    const diff = diffDocuments(
      parseDocument(withAlias),
      parseDocument(withAlias)
    )
    expect(diff.equal).toBe(true)
    expect(diff.refs).toEqual([])
  })

  test('value change behind an alias is still a value change', () => {
    const a = parseDocument('a: &x [1, 2]\nb: *x\n')
    const b = parseDocument('a: &x [1, 3]\nb: *x\n')
    const diff = diffDocuments(a, b)
    expect(diff.status).toBe('value')
    expect(diff.changes).toMatchObject([{ kind: 'value', path: ['a', 1] }])
  })

  test('cyclic alias graphs are not expanded into infinite trees', () => {
    const a = parseDocument('&a\nself: *a\nv: 1\n')
    const b = parseDocument('&a\nself: *a\nv: 2\n')
    const diff = diffDocuments(a, b)
    expect(diff.status).toBe('value')
    expect(diff.changes).toMatchObject([{ kind: 'value', path: ['v'] }])
    const same = diffDocuments(a, parseDocument('&a\nself: *a\nv: 1\n'))
    expect(same.equal).toBe(true)
  })

  test('shared node vs separate copies is marked for programmatic docs', () => {
    const a = new Document({})
    const seq = a.createNode([1, 2])
    a.set('x', seq)
    a.set('y', seq) // same node object reused
    const b = new Document({ x: [1, 2], y: [1, 2] }) // two separate copies
    const diff = diffDocuments(a, b)
    expect(diff.valueEqual).toBe(true)
    expect(diff.refsEqual).toBe(false)
    expect(
      diff.refs.some(
        r => r.a.startsWith('shared node') && r.b === 'single copy'
      )
    ).toBe(true)
  })
})

describe('custom tags are unknown, never equal', () => {
  test('identical custom-tagged scalars are unknown, not equal', () => {
    const diff = diffDocuments(parseDocument('!foo 1'), parseDocument('!foo 1'))
    expect(diff.status).toBe('unknown')
    expect(diff.equal).toBe(false)
    expect(diff.valueEqual).toBe(false)
    expect(diff.changes).toMatchObject([{ kind: 'unknown', path: [] }])
  })

  test('custom tag nested in a map is unknown', () => {
    const a = parseDocument('a: !foo 1\nb: 2\n')
    const b = parseDocument('a: !foo 1\nb: 2\n')
    const diff = diffDocuments(a, b)
    expect(diff.status).toBe('unknown')
    expect(diff.changes).toMatchObject([{ kind: 'unknown', path: ['a'] }])
  })

  test('custom-tagged map keys are unknown', () => {
    const a = parseDocument('!foo k: 1\n')
    const b = parseDocument('!foo k: 1\n')
    const diff = diffDocuments(a, b)
    expect(diff.status).toBe('unknown')
    expect(diff.equal).toBe(false)
  })

  test('explicit core-schema tags are still comparable', () => {
    const a = parseDocument('!!str foo')
    const b = parseDocument('!!str foo')
    expect(diffDocuments(a, b).equal).toBe(true)
  })

  test('custom toJSON is never executed', () => {
    const a = parseDocument('v: 1\n')
    const b = parseDocument('v: 1\n')
    const bomb = () => {
      throw new Error('toJSON must not be called')
    }
    Object.assign(a.value as object, { toJSON: bomb })
    Object.assign(b.value as object, { toJSON: bomb })
    expect(() => diffDocuments(a, b)).not.toThrow()
    expect(diffDocuments(a, b).equal).toBe(true)
  })
})

describe('source documents are not modified', () => {
  test('toString output is unchanged by diffing', () => {
    const srcA = 'a: &x [1, 2]\nb: *x\nc: !foo 1\n'
    const srcB = "a: [1, 2]\nb: [1, 2]\nc: !foo '1'\n"
    const a = parseDocument(srcA)
    const b = parseDocument(srcB)
    const strA = a.toString()
    const strB = b.toString()
    diffDocuments(a, b)
    expect(a.toString()).toBe(strA)
    expect(b.toString()).toBe(strB)
  })
})

describe('three-document example', () => {
  const source = [
    '# baseline document',
    "name: 'yaml'",
    'items:',
    '  - 1',
    '  - 2',
    'defaults: &defaults',
    '  retries: 3',
    'primary: *defaults',
    '---',
    '# same values, restyled',
    'name: "yaml"',
    'items:',
    '    - 1',
    '    - 2',
    'defaults: &defaults',
    '  retries: 3',
    'primary: *defaults',
    '---',
    '# changed values, alias replaced by a copy',
    "name: 'yaml'",
    'items:',
    '  - 1',
    '  - 3',
    'defaults: &defaults',
    '  retries: 3',
    'primary:',
    '  retries: 3',
    ''
  ].join('\n')

  test('baseline vs restyled is format-only', () => {
    const [base, restyled] = parseAllDocuments(source)
    const diff = diffDocuments(base, restyled)
    expect(diff.status).toBe('format')
    expect(diff.valueEqual).toBe(true)
    expect(diff.changes.length).toBeGreaterThan(0)
    expect(diff.changes.every(c => c.kind === 'format')).toBe(true)
  })

  test('baseline vs changed has value and reference differences', () => {
    const [base, , changed] = parseAllDocuments(source)
    const diff = diffDocuments(base, changed)
    expect(diff.status).toBe('value')
    expect(diff.changes).toContainEqual(
      expect.objectContaining({ kind: 'value', path: ['items', 1] })
    )
    expect(diff.refs).toContainEqual(
      expect.objectContaining({
        path: ['primary'],
        a: 'alias *defaults',
        b: 'copy'
      })
    )
    expect(diff.refsEqual).toBe(false)
  })

  test('restyled vs changed still finds the value change', () => {
    const [, restyled, changed] = parseAllDocuments(source)
    const diff = diffDocuments(restyled, changed)
    expect(diff.status).toBe('value')
    expect(diff.changes).toContainEqual(
      expect.objectContaining({ kind: 'value', path: ['items', 1] })
    )
  })
})

describe('CLI: yaml diff', () => {
  const stdout: unknown[] = []
  const stderr: unknown[] = []
  beforeAll(() => {
    vi.spyOn(global.console, 'log').mockImplementation(thing => {
      stdout.push(thing)
    })
    vi.spyOn(global.console, 'error').mockImplementation(thing => {
      stderr.push(thing)
    })
  })
  beforeEach(() => {
    stdout.length = 0
    stderr.length = 0
  })

  const run = (input: string, args: string[] = ['diff']) =>
    new Promise<{ error?: Error }>(resolve => {
      void cli(Readable.from([input]), error => resolve({ error }), args)
    })

  test('equal documents exit cleanly', async () => {
    const { error } = await run('a: 1\n---\na: 1\n')
    expect(error).toBeUndefined()
    expect(stdout.join('\n')).toContain('status: equal')
  })

  test('format-only difference reports format and exits 1', async () => {
    const { error } = await run('a: \'x\'\n---\na: "x"\n')
    expect(error).toMatchObject({ code: 1 })
    expect(stdout.join('\n')).toContain('status: format')
    expect(stdout.join('\n')).toContain('format a:')
  })

  test('value difference reports value and exits 1', async () => {
    const { error } = await run('a: 1\n---\na: 2\n')
    expect(error).toMatchObject({ code: 1 })
    expect(stdout.join('\n')).toContain('status: value')
    expect(stdout.join('\n')).toContain('value a:')
  })

  test('--json outputs the full diff report', async () => {
    const { error } = await run('a: 1\n---\na: 2\n', ['diff', '--json'])
    expect(error).toMatchObject({ code: 1 })
    const report = JSON.parse(stdout.join(''))
    expect(report.status).toBe('value')
    expect(report.changes).toMatchObject([{ kind: 'value', path: ['a'] }])
  })

  test('requires exactly two documents', async () => {
    const { error } = await run('a: 1\n')
    expect(error).toMatchObject({ code: 2 })
    expect(String(error)).toContain('requires exactly two documents')
  })
})
