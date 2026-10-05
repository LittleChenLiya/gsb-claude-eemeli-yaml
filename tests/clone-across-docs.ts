import {
  Alias,
  cloneNodeAcrossDocuments,
  Document,
  parseDocument,
  Scalar,
  YAMLMap,
  YAMLSeq
} from 'yaml'
import { source } from './_utils.ts'

describe('cloneNodeAcrossDocuments()', () => {
  describe('anchors & aliases within the subtree', () => {
    test('are cloned along, renaming on collision with target anchors', () => {
      // Two small documents; the cloned subtree holds both &x and *x,
      // while the target document already uses &x.
      const src = parseDocument(source`
        item:
          def: &x [1, 2]
          ref: *x
      `)
      const tgt = parseDocument('mine: &x old\n')
      const tgtBefore = tgt.toString()

      const cloned = cloneNodeAcrossDocuments<YAMLMap>(
        tgt,
        src,
        src.get('item') as YAMLMap
      )
      tgt.set('imported', cloned)

      // &x collides with the target's existing anchor and is renamed;
      // the cloned alias is updated to match and resolves to the copy.
      expect(tgt.toString()).toBe(source`
        mine: &x old
        imported:
          def: &x1 [ 1, 2 ]
          ref: *x1
      `)
      const def = cloned.get('def') as YAMLSeq
      const ref = cloned.get('ref') as Alias
      expect(def).toBeInstanceOf(YAMLSeq)
      expect(def.anchor).toBe('x1')
      expect(ref).toBeInstanceOf(Alias)
      expect(ref.source).toBe('x1')
      expect(ref.resolve(tgt)).toBe(def)

      // The source document is not modified.
      expect(src.toString()).toBe(source`
        item:
          def: &x [ 1, 2 ]
          ref: *x
      `)
      expect(((src.get('item') as YAMLMap).get('def') as YAMLSeq).anchor).toBe(
        'x'
      )
      // The target's pre-existing anchor keeps its node.
      expect((tgt.get('mine') as Scalar).anchor).toBe('x')
      expect(tgtBefore).toBe('mine: &x old\n')
    })

    test('keep their names when there is no collision', () => {
      const src = parseDocument('item:\n  def: &y [1]\n  ref: *y\n')
      const tgt = parseDocument('mine: &x old\n')
      const cloned = cloneNodeAcrossDocuments<YAMLMap>(
        tgt,
        src,
        src.get('item') as YAMLMap
      )
      tgt.set('imported', cloned)
      expect(tgt.toString()).toBe(source`
        mine: &x old
        imported:
          def: &y [ 1 ]
          ref: *y
      `)
    })

    test('rename deterministically, skipping used suffixes', () => {
      const src = parseDocument('item:\n  def: &x 1\n  ref: *x\n')
      const tgt = parseDocument('a: &x 0\nb: &x1 0\n')
      const cloned = cloneNodeAcrossDocuments<YAMLMap>(
        tgt,
        src,
        src.get('item') as YAMLMap
      )
      tgt.set('imported', cloned)
      expect((cloned.get('def') as Scalar).anchor).toBe('x2')
      expect((cloned.get('ref') as Alias).source).toBe('x2')
    })
  })

  describe('aliases to anchors outside the subtree', () => {
    const src = 'def: &d [1]\nthing: *d\n'

    test('are rejected by default, leaving the target completely unchanged', () => {
      const srcDoc = parseDocument(src)
      const tgt = parseDocument('a: 1\n')
      const before = tgt.toString()
      expect(() =>
        cloneNodeAcrossDocuments(tgt, srcDoc, srcDoc.get('thing') as Alias)
      ).toThrow('Alias *d refers to an anchor outside the cloned subtree')
      expect(tgt.toString()).toBe(before)
    })

    test("are rejected with externalAliases: 'error'", () => {
      const srcDoc = parseDocument(src)
      const tgt = parseDocument('a: 1\n')
      expect(() =>
        cloneNodeAcrossDocuments(tgt, srcDoc, srcDoc.get('thing') as Alias, {
          externalAliases: 'error'
        })
      ).toThrow('Alias *d refers to an anchor outside the cloned subtree')
      expect(tgt.toString()).toBe('a: 1\n')
    })

    test('throw on unresolvable aliases, leaving the target unchanged', () => {
      const srcDoc = parseDocument('thing: *nope\n')
      const tgt = parseDocument('a: 1\n')
      expect(() =>
        cloneNodeAcrossDocuments(tgt, srcDoc, srcDoc.get('thing') as Alias, {
          externalAliases: 'copy'
        })
      ).toThrow('Unresolved alias')
      expect(tgt.toString()).toBe('a: 1\n')
    })

    test("with externalAliases: 'copy', the referenced node is copied along", () => {
      const srcDoc = parseDocument('def: &d [1, 2]\nthing:\n  a: *d\n  b: *d\n')
      const tgt = parseDocument('z: 0\n')
      const cloned = cloneNodeAcrossDocuments<YAMLMap>(
        tgt,
        srcDoc,
        srcDoc.get('thing') as YAMLMap,
        { externalAliases: 'copy' }
      )
      tgt.set('t', cloned)

      // The first alias is replaced by the copied node; later aliases
      // refer to it, so no dangling references are left.
      expect(tgt.toString()).toBe(source`
        z: 0
        t:
          a: &d [ 1, 2 ]
          b: *d
      `)
      const a = cloned.get('a') as YAMLSeq
      const b = cloned.get('b') as Alias
      expect(a).toBeInstanceOf(YAMLSeq)
      expect(a.anchor).toBe('d')
      expect(b).toBeInstanceOf(Alias)
      expect(b.source).toBe('d')
      expect(b.resolve(tgt)).toBe(a)
      expect(tgt.toJS()).toEqual({ z: 0, t: { a: [1, 2], b: [1, 2] } })
    })

    test("with externalAliases: 'copy', copied anchors are renamed on collision", () => {
      const srcDoc = parseDocument('def: &d [1]\nthing: *d\n')
      const tgt = parseDocument('other: &d old\n')
      const cloned = cloneNodeAcrossDocuments(
        tgt,
        srcDoc,
        srcDoc.get('thing') as Alias,
        { externalAliases: 'copy' }
      ) as unknown as YAMLSeq
      tgt.set('t', cloned)
      expect(cloned).toBeInstanceOf(YAMLSeq)
      expect(cloned.anchor).toBe('d1')
      expect(tgt.toString()).toBe(source`
        other: &d old
        t: &d1 [ 1 ]
      `)
    })
  })

  describe('cyclic & shared references', () => {
    test('keep the graph identity of direct self-references', () => {
      const srcDoc = new Document(null)
      const seq = srcDoc.createNode([]) as YAMLSeq
      seq.anchor = 's'
      seq.push(seq) // direct self-reference
      const tgt = parseDocument('a: 1\n')
      const cloned = cloneNodeAcrossDocuments(tgt, srcDoc, seq)
      expect(cloned).toBeInstanceOf(YAMLSeq)
      expect(cloned.anchor).toBe('s')
      expect(cloned[0]).toBe(cloned) // identity kept, not expanded
      expect(cloned).not.toBe(seq)
    })

    test('keep the graph identity of alias-based self-references', () => {
      const srcDoc = parseDocument('root: &a\n  self: *a\n')
      const tgt = parseDocument('b: 2\n')
      const cloned = cloneNodeAcrossDocuments<YAMLMap>(
        tgt,
        srcDoc,
        srcDoc.get('root') as YAMLMap
      )
      tgt.set('r', cloned)
      const self = cloned.get('self') as Alias
      expect(self).toBeInstanceOf(Alias)
      expect(self.source).toBe('a')
      expect(self.resolve(tgt)).toBe(cloned)
      expect(tgt.toString()).toBe(source`
        b: 2
        r: &a
          self: *a
      `)
    })

    test('keep the identity of nodes shared between positions', () => {
      const srcDoc = new Document(null)
      const shared = srcDoc.createNode({ v: 1 })
      const seq = srcDoc.createNode([]) as YAMLSeq
      seq.push(shared, shared)
      const tgt = parseDocument('a: 1\n')
      const cloned = cloneNodeAcrossDocuments(tgt, srcDoc, seq)
      expect(cloned[0]).toBe(cloned[1])
      expect(cloned[0]).not.toBe(shared)
    })
  })

  describe('node properties', () => {
    test('preserve comments and tags', () => {
      const src = parseDocument(
        'item:\n  # before comment\n  !!str 42 # after comment\n'
      )
      const tgt = parseDocument('k: v\n')
      const cloned = cloneNodeAcrossDocuments<Scalar>(
        tgt,
        src,
        src.get('item') as Scalar
      )
      expect(cloned.tag).toBe('tag:yaml.org,2002:str')
      expect(cloned.comment).toBe(' after comment')
      expect(cloned.commentBefore).toBe(' before comment')
      tgt.set('it', cloned)
      expect(tgt.toString()).toBe(source`
        k: v
        it:
          # before comment
          !!str "42" # after comment
      `)
    })

    test('clone is independent of the original', () => {
      const src = parseDocument('item:\n  def: &x [1, 2]\n  ref: *x\n')
      const tgt = parseDocument('other: 1\n')
      const cloned = cloneNodeAcrossDocuments<YAMLMap>(
        tgt,
        src,
        src.get('item') as YAMLMap
      )
      cloned.set('extra', 'new')
      ;(cloned.get('def') as YAMLSeq).push(3)
      expect(src.toString()).toBe(source`
        item:
          def: &x [ 1, 2 ]
          ref: *x
      `)
    })
  })

  test('throws a TypeError for non-node subtrees', () => {
    const src = parseDocument('a: 1\n')
    const tgt = parseDocument('b: 2\n')
    expect(() =>
      cloneNodeAcrossDocuments(tgt, src, 42 as unknown as Scalar)
    ).toThrow(TypeError)
    expect(tgt.toString()).toBe('b: 2\n')
  })
})
