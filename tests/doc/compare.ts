import * as YAML from 'yaml'
import { describe, expect, test } from 'vitest'
import { compareDocuments } from '../../src/doc/compare.ts'

const parse = (src: string) => YAML.parseDocument(src)

describe('compareDocuments', () => {
  test('same string with single vs double quotes is style-only', () => {
    const a = parse("name: 'foo'")
    const b = parse('name: "foo"')
    const diff = compareDocuments(a, b)
    expect(diff.equal).toBe(true)
    expect(diff.valueChanges).toHaveLength(0)
    expect(diff.unknownChanges).toHaveLength(0)
    expect(diff.styleChanges).toHaveLength(1)
    expect(diff.styleChanges[0].path).toEqual(['name'])
    expect(diff.styleChanges[0].fields).toContainEqual({
      field: 'type',
      left: 'QUOTE_SINGLE',
      right: 'QUOTE_DOUBLE'
    })
  })

  test('changed scalar value is a value difference', () => {
    const a = parse("name: 'foo'")
    const b = parse("name: 'bar'")
    const diff = compareDocuments(a, b)
    expect(diff.equal).toBe(false)
    expect(diff.styleEqual).toBe(true)
    expect(diff.valueChanges).toHaveLength(1)
    expect(diff.valueChanges[0]).toMatchObject({
      path: ['name'],
      kind: 'scalar',
      left: 'foo',
      right: 'bar'
    })
  })

  test('alias reuse vs independent copies is a reference change', () => {
    const a = parse('a: &x {foo: 1}\nb: *x')
    const b = parse('a: {foo: 1}\nb: {foo: 1}')
    const diff = compareDocuments(a, b)
    expect(diff.equal).toBe(true)
    expect(diff.valueChanges).toHaveLength(0)
    expect(diff.refChanges).toHaveLength(1)
    expect(diff.refChanges[0].path).toEqual(['b'])
    expect(diff.refChanges[0].left).toMatchObject({ kind: 'alias', anchor: 'x' })
    expect(diff.refChanges[0].right).toMatchObject({ kind: 'copy' })
    expect(diff.references.left).toHaveLength(1)
    expect(diff.references.left[0]).toMatchObject({
      anchor: 'x',
      targetPath: ['a'],
      aliasPaths: [['b']]
    })
    expect(diff.references.right).toHaveLength(0)
  })

  test('matching alias reuse on both sides is not a reference change', () => {
    const a = parse('a: &x {foo: 1}\nb: *x')
    const b = parse('a: &y {foo: 1}\nb: *y')
    const diff = compareDocuments(a, b)
    expect(diff.equal).toBe(true)
    expect(diff.refChanges).toHaveLength(0)
    expect(diff.references.left).toHaveLength(1)
    expect(diff.references.right).toHaveLength(1)
  })

  test('cyclic references are not expanded into infinite trees', () => {
    const a = parse('node: &n\n  child: *n')
    const b = parse('node: &m\n  child: *m')
    const diff = compareDocuments(a, b)
    expect(diff.equal).toBe(true)
    expect(diff.valueChanges).toHaveLength(0)
    expect(diff.refChanges).toHaveLength(0)
    expect(diff.references.left[0].anchor).toBe('n')
    expect(diff.references.right[0].anchor).toBe('m')
  })

  test('unknown custom tags are marked unknown and never equal', () => {
    const a = parse('!foo {a: 1}')
    const b = parse('!bar {a: 1}')
    const diff = compareDocuments(a, b)
    expect(diff.equal).toBe(false)
    expect(diff.unknownChanges).toHaveLength(1)
    expect(diff.unknownChanges[0]).toMatchObject({ side: 'both' })
    expect(diff.valueChanges).toHaveLength(0)
  })

  test('unknown custom tag on one side only', () => {
    const a = parse('!foo {a: 1}')
    const b = parse('{a: 1}')
    const diff = compareDocuments(a, b)
    expect(diff.equal).toBe(false)
    expect(diff.unknownChanges).toHaveLength(1)
    expect(diff.unknownChanges[0].side).toBe('left')
  })

  test('maps pair by key identity, not order', () => {
    const a = parse('b: 2\na: 1')
    const b = parse('a: 1\nb: 2')
    const diff = compareDocuments(a, b)
    expect(diff.equal).toBe(true)
    expect(diff.valueChanges).toHaveLength(0)
  })

  test('sequences compare by position', () => {
    const a = parse('[1, 2, 3]')
    const b = parse('[1, 3, 2]')
    const diff = compareDocuments(a, b)
    expect(diff.equal).toBe(false)
    expect(diff.valueChanges.map(c => c.path)).toEqual([[1], [2]])
  })

  test('added and removed keys are value changes', () => {
    const a = parse('a: 1\nb: 2')
    const b = parse('a: 1\nc: 3')
    const diff = compareDocuments(a, b)
    expect(diff.equal).toBe(false)
    expect(diff.valueChanges).toHaveLength(2)
    expect(diff.valueChanges[0]).toMatchObject({ path: ['b'], kind: 'key-removed' })
    expect(diff.valueChanges[1]).toMatchObject({ path: ['c'], kind: 'key-added' })
  })

  test('comments are style-only changes', () => {
    const a = parse('a: 1 # hello')
    const b = parse('a: 1 # world')
    const diff = compareDocuments(a, b)
    expect(diff.equal).toBe(true)
    expect(diff.styleChanges).toHaveLength(1)
    expect(diff.styleChanges[0].fields).toContainEqual({
      field: 'comment',
      left: ' hello',
      right: ' world'
    })
  })

  test('flow vs block layout is a style change', () => {
    const a = parse('a: {x: 1}')
    const b = parse('a:\n  x: 1')
    const diff = compareDocuments(a, b)
    expect(diff.equal).toBe(true)
    expect(diff.styleChanges.some(c => c.path.join('.') === 'a')).toBe(true)
  })

  test('source documents are not modified', () => {
    const src = "name: 'foo' # comment\nitems: &i [1, 2]\nmore: *i"
    const a = parse(src)
    const b = parse(src)
    const beforeA = a.toString()
    const beforeB = b.toString()
    compareDocuments(a, b)
    expect(a.toString()).toBe(beforeA)
    expect(b.toString()).toBe(beforeB)
    expect(a.toString()).toBe(b.toString())
  })

  test('three-document example: baseline vs style-only vs value-changed', () => {
    const stream = `name: 'foo'
version: 1
---
name: "foo"
version: 1
---
name: 'bar'
version: 2
`
    const docs = YAML.parseAllDocuments(stream)
    expect(docs).toHaveLength(3)
    const [baseline, styleOnly, valueChanged] = docs

    // The baseline document itself is unchanged after comparison.
    const before = baseline.toString()

    const styleDiff = baseline.compare(styleOnly)
    expect(styleDiff.equal).toBe(true)
    expect(styleDiff.styleChanges.length).toBeGreaterThan(0)
    expect(styleDiff.valueChanges).toHaveLength(0)
    expect(styleDiff.styleChanges[0].fields).toContainEqual({
      field: 'type',
      left: 'QUOTE_SINGLE',
      right: 'QUOTE_DOUBLE'
    })

    const valueDiff = baseline.compare(valueChanged)
    expect(valueDiff.equal).toBe(false)
    expect(valueDiff.valueChanges.length).toBeGreaterThan(0)
    expect(valueDiff.valueChanges.map(c => c.path)).toEqual([
      ['name'],
      ['version']
    ])

    expect(baseline.toString()).toBe(before)
  })

  test('toJSON is serializable and reflects the diff', () => {
    const a = parse("name: 'foo'")
    const b = parse("name: 'bar'")
    const diff = compareDocuments(a, b)
    const json = JSON.parse(JSON.stringify(diff))
    expect(json.equal).toBe(false)
    expect(json.valueChanges).toHaveLength(1)
    expect(json.valueChanges[0].left).toBe('foo')
    expect(json.valueChanges[0].right).toBe('bar')
  })
})
