import { Alias, Scalar, type YAMLMap, type YAMLSeq } from 'yaml'
import { parseDocument, visit } from 'yaml'
import { source } from './_utils.ts'

describe('doc.clone()', () => {
  test('has expected members', () => {
    const doc = parseDocument('foo: bar')
    const copy = doc.clone()
    expect(copy).toMatchObject({
      comment: null,
      commentBefore: null,
      errors: [],
      warnings: []
    })
  })

  test('has expected methods', () => {
    const doc = parseDocument('foo: bar')
    const copy = doc.clone()
    expect(copy.toString()).toBe('foo: bar\n')
    expect(copy.toJS()).toEqual({ foo: 'bar' })

    const node = copy.createNode(42)
    expect(node).toBeInstanceOf(Scalar)
    expect(node).toMatchObject({ value: 42 })

    const alias = copy.createAlias(node, 'foo')
    expect(alias).toBeInstanceOf(Alias)
    expect(alias).toMatchObject({ source: 'foo' })
  })

  test('has separate value from original', () => {
    const doc = parseDocument('foo: bar')
    const copy = doc.clone()
    copy.set('foo', 'fizz')
    expect(doc.get('foo')).toMatchObject(new Scalar('bar'))
    expect(copy.get('foo')).toMatchObject(new Scalar('fizz'))
  })

  test('has separate directives from original', () => {
    const doc = parseDocument<YAMLMap>('foo: bar')
    const copy = doc.clone()
    copy.directives.yaml.explicit = true
    expect(copy.toString()).toBe(source`
      %YAML 1.2
      ---
      foo: bar
    `)
    expect(doc.toString()).toBe('foo: bar\n')
  })

  test('handles anchors & aliases', () => {
    const src = source`
      foo: &foo FOO
      bar: *foo
    `
    const doc = parseDocument(src)
    const copy = doc.clone()
    expect(copy.toString()).toBe(src)

    visit(doc, {
      Alias(_, it) {
        if (it.source === 'foo') it.source = 'x'
      },
      Node(_, it) {
        if (it.anchor === 'foo') it.anchor = 'x'
      }
    })
    expect(doc.toString()).toBe(source`
      foo: &x FOO
      bar: *x
    `)
    expect(copy.toString()).toBe(src)
  })
})

describe('doc.cloneSubtree()', () => {
  test('copies internal anchors & aliases', () => {
    const src = parseDocument<YAMLMap>('items: [&x 1, *x]\n')
    const tgt = parseDocument<YAMLMap>('other: 2\n')
    const items = src.get('items') as YAMLSeq
    const clone = tgt.cloneSubtree(src, items) as YAMLSeq
    tgt.value.set('copied', clone)
    expect(tgt.toString()).toBe(source`
      other: 2
      copied: [ &x 1, *x ]
    `)
    // The alias still resolves to the copied node.
    const alias = clone.at(1) as Alias
    expect(alias.resolve(tgt)).toBe(clone.at(0))
  })

  test('renames anchors that collide with the target', () => {
    const src = parseDocument<YAMLMap>('items: [&x 1, *x]\n')
    const tgt = parseDocument<YAMLMap>('other: &x 3\n')
    const items = src.get('items') as YAMLSeq
    const clone = tgt.cloneSubtree(src, items) as YAMLSeq
    tgt.value.set('copied', clone)
    // The copied anchor is renamed to avoid colliding with the target's &x.
    expect(tgt.toString()).toBe(source`
      other: &x 3
      copied: [ &a1 1, *a1 ]
    `)
    // The alias still points at the copied (renamed) node.
    const alias = clone.at(1) as Alias
    expect(alias.resolve(tgt)).toBe(clone.at(0))
    expect((clone.at(0) as Scalar).anchor).toBe('a1')
  })

  test('external alias reject mode leaves the target unchanged', () => {
    const src = parseDocument<YAMLMap>('a: &x 1\nb: *x\n')
    const tgt = parseDocument<YAMLMap>('c: 2\n')
    const before = tgt.toString()
    const b = src.get('b')!
    expect(() =>
      tgt.cloneSubtree(src, b, { externalAlias: 'reject' })
    ).toThrow(/outside the subtree/)
    expect(tgt.toString()).toBe(before)
  })

  test('external alias copy mode copies the referenced node', () => {
    const src = parseDocument<YAMLMap>('a: &x 1\nb: *x\n')
    const tgt = parseDocument<YAMLMap>('c: 2\n')
    const b = src.get('b')!
    const clone = tgt.cloneSubtree(src, b, { externalAlias: 'copy' })
    tgt.value.set('d', clone)
    // The external target &x 1 is copied and attached to the root, so the
    // alias resolves.
    expect(tgt.toString()).toBe(source`
      c: 2
      x: &x 1
      d: *x
    `)
    expect((clone as Alias).resolve(tgt)).toBe(tgt.value.get('x'))
  })

  test('preserves self-referential graph identity', () => {
    const src = parseDocument<YAMLSeq>('&a [1, *a]\n')
    const tgt = parseDocument<YAMLMap>('other: 2\n')
    const clone = tgt.cloneSubtree(src, src.value) as YAMLSeq
    tgt.value.set('copied', clone)
    expect(tgt.toString()).toBe(source`
      other: 2
      copied: &a [ 1, *a ]
    `)
    // The alias points at the copy itself, not a new expansion.
    const alias = clone.at(1) as Alias
    expect(alias.resolve(tgt)).toBe(clone)
    const res = tgt.toJS()
    expect(res.copied[1]).toBe(res.copied)
  })

  test('renames self-referential anchor on collision', () => {
    const src = parseDocument<YAMLSeq>('&a [1, *a]\n')
    const tgt = parseDocument<YAMLMap>('other: &a 2\n')
    const clone = tgt.cloneSubtree(src, src.value) as YAMLSeq
    tgt.value.set('copied', clone)
    expect(tgt.toString()).toBe(source`
      other: &a 2
      copied: &a1 [ 1, *a1 ]
    `)
    const alias = clone.at(1) as Alias
    expect(alias.resolve(tgt)).toBe(clone)
  })

  test('preserves tags', () => {
    const src = parseDocument<YAMLMap>('items: [!!str &x 1, *x]\n')
    const tgt = parseDocument<YAMLMap>('other: 2\n')
    const items = src.get('items') as YAMLSeq
    const clone = tgt.cloneSubtree(src, items) as YAMLSeq
    tgt.value.set('copied', clone)
    // The tag is preserved; stringification matches the source's own output.
    expect(tgt.toString()).toBe(source`
      other: 2
      copied: [ &x !!str "1", *x ]
    `)
    expect((clone.at(0) as Scalar).tag).toBe('tag:yaml.org,2002:str')
  })

  test('preserves comments', () => {
    const src = parseDocument<YAMLMap>('items: [&x 1, *x] # tail\n')
    const tgt = parseDocument<YAMLMap>('other: 2\n')
    const items = src.get('items') as YAMLSeq
    const clone = tgt.cloneSubtree(src, items) as YAMLSeq
    tgt.value.set('copied', clone)
    expect(clone.comment).toBe(' tail')
  })

  test('does not modify the source document', () => {
    const src = parseDocument<YAMLMap>('items: [&x 1, *x]\n')
    const tgt = parseDocument<YAMLMap>('other: &x 3\n')
    const before = src.toString()
    const items = src.get('items') as YAMLSeq
    tgt.cloneSubtree(src, items)
    expect(src.toString()).toBe(before)
  })

  test('works with sequence targets', () => {
    const src = parseDocument<YAMLMap>('items: [&x 1, *x]\n')
    const tgt = parseDocument<YAMLSeq>('- 0\n')
    const items = src.get('items') as YAMLSeq
    const clone = tgt.cloneSubtree(src, items) as YAMLSeq
    tgt.value.push(clone)
    expect(tgt.toString()).toBe(source`
      - 0
      - [ &x 1, *x ]
    `)
  })

  test('anchorPrefix option controls renaming', () => {
    const src = parseDocument<YAMLMap>('items: [&x 1, *x]\n')
    const tgt = parseDocument<YAMLMap>('other: &x 3\n')
    const items = src.get('items') as YAMLSeq
    const clone = tgt.cloneSubtree(src, items, {
      anchorPrefix: 'ref'
    }) as YAMLSeq
    tgt.value.set('copied', clone)
    expect((clone.at(0) as Scalar).anchor).toBe('ref1')
    expect((clone.at(1) as Alias).source).toBe('ref1')
  })
})
