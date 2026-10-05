import {
  Alias,
  coordinateTagHandles,
  parseAllDocuments,
  parseDocument,
  Scalar,
  TagHandleCoordinationError
} from 'yaml'
import type { ScalarTag } from 'yaml'

const alpha = 'tag:alpha.example,2026:'
const beta = 'tag:beta.example,2026:'
const gamma = 'tag:gamma.example,2026:'

describe('coordinateTagHandles', () => {
  describe('conflicting handles across documents', () => {
    const srcA = `%TAG !app! ${alpha}\n---\n!app!thing one\n`
    const srcB = `%TAG !app! ${beta}\n---\n!app!thing two\n`

    test('deterministically assigns a new handle to the later document', () => {
      const docA = parseDocument(srcA)
      const docB = parseDocument(srcB)
      const group = coordinateTagHandles([docA, docB])

      expect(group.plans[0].renamed).toEqual({})
      expect(group.plans[1].renamed).toEqual({ '!app!': '!app2!' })

      // The real tag URIs of the nodes are not modified
      expect(docA.value).toMatchObject({ tag: `${alpha}thing`, value: 'one' })
      expect(docB.value).toMatchObject({ tag: `${beta}thing`, value: 'two' })

      expect(String(docA)).toBe(srcA)
      expect(String(docB)).toBe(`%TAG !app2! ${beta}\n---\n!app2!thing two\n`)
    })

    test('output group is unambiguous & re-parses to the same tag identities', () => {
      const docA = parseDocument(srcA)
      const docB = parseDocument(srcB)
      const group = coordinateTagHandles([docA, docB])
      const out = group.toString()

      expect(out).toBe(
        `%TAG !app! ${alpha}\n---\n!app!thing one\n...\n` +
          `%TAG !app2! ${beta}\n---\n!app2!thing two\n`
      )

      const reDocs = parseAllDocuments(out)
      expect(reDocs).toHaveLength(2)
      expect(reDocs[0].errors).toHaveLength(0)
      expect(reDocs[1].errors).toHaveLength(0)
      expect(reDocs[0].value).toMatchObject({ tag: `${alpha}thing` })
      expect(reDocs[1].value).toMatchObject({ tag: `${beta}thing` })
    })

    test('a third conflicting document gets the next counter', () => {
      const docs = [alpha, beta, gamma].map(prefix =>
        parseDocument(`%TAG !app! ${prefix}\n---\n!app!x v\n`)
      )
      const group = coordinateTagHandles(docs)
      expect(group.plans.map(p => p.renamed)).toEqual([
        {},
        { '!app!': '!app2!' },
        { '!app!': '!app3!' }
      ])
      const reDocs = parseAllDocuments(group.toString())
      expect(reDocs.map(d => (d.value as any).tag)).toEqual([
        `${alpha}x`,
        `${beta}x`,
        `${gamma}x`
      ])
    })

    test('generated handles never collide with handles used by any document', () => {
      const docA = parseDocument(`%TAG !app! ${alpha}\n---\n!app!x 1\n`)
      const docB = parseDocument(`%TAG !app! ${beta}\n---\n!app!x 2\n`)
      const docC = parseDocument(`%TAG !app2! ${gamma}\n---\n!app2!x 3\n`)
      const group = coordinateTagHandles([docA, docB, docC])
      // !app2! is reserved by docC, so docB must get !app3!
      expect(group.plans[1].renamed).toEqual({ '!app!': '!app3!' })
      expect(group.plans[2].renamed).toEqual({})
      const reDocs = parseAllDocuments(group.toString())
      expect(reDocs.map(d => (d.value as any).tag)).toEqual([
        `${alpha}x`,
        `${beta}x`,
        `${gamma}x`
      ])
    })

    test('same handle with the same prefix is shared, not renamed', () => {
      const docA = parseDocument(srcA)
      const docB = parseDocument(srcA)
      const group = coordinateTagHandles([docA, docB])
      expect(group.plans[0].renamed).toEqual({})
      expect(group.plans[1].renamed).toEqual({})
      expect(String(docB)).toBe(srcA)
    })
  })

  describe('the standard !! handle', () => {
    test('is never rebound by the coordinator', () => {
      const docA = parseDocument('!!str foo\n')
      const docB = parseDocument('!!int 42\n')
      const group = coordinateTagHandles([docA, docB])
      for (const plan of group.plans) {
        expect(plan.renamed).toEqual({})
        expect(plan.handles['!!']).toBe('tag:yaml.org,2002:')
      }
      expect(group.prefixFor(0, '!!')).toBe('tag:yaml.org,2002:')
      expect(group.prefixFor(1, '!!')).toBe('tag:yaml.org,2002:')
    })

    test('an illegal !! binding fails atomically, modifying no source document', () => {
      const srcGood = `%TAG !app! ${alpha}\n---\n!app!x v\n`
      const srcBad = '%TAG !! tag:evil.example:\n---\n!!x v\n'
      const docGood = parseDocument(srcGood)
      const docBad = parseDocument(srcBad)
      expect(docBad.errors).toHaveLength(0)

      const tagsBefore = JSON.parse(JSON.stringify(docGood.directives.tags))
      let error: unknown = null
      try {
        coordinateTagHandles([docGood, docBad])
      } catch (err) {
        error = err
      }
      expect(error).toBeInstanceOf(TagHandleCoordinationError)
      expect((error as TagHandleCoordinationError).docIndex).toBe(1)
      expect(String(error)).toMatch(/illegally rebinds the standard !! handle/)

      // No source document was modified
      expect(docGood.directives.tags).toEqual(tagsBefore)
      expect(String(docGood)).toBe(srcGood)
      expect(String(docBad)).toBe(srcBad)
    })
  })

  describe('directive order', () => {
    test('uninvolved directives keep their original order', () => {
      const docA = parseDocument(`%TAG !app! ${alpha}\n---\n!app!x 1\n`)
      const docB = parseDocument(
        `%YAML 1.2\n%TAG !app! ${beta}\n%TAG !other! ${gamma}\n` +
          `---\n- !app!x b\n- !other!y c\n`
      )
      const group = coordinateTagHandles([docA, docB])
      expect(group.plans[1].renamed).toEqual({ '!app!': '!app2!' })
      // %YAML first, then the renamed handle in its original position,
      // then the untouched !other! binding
      expect(String(docB)).toBe(
        `%YAML 1.2\n%TAG !app2! ${beta}\n%TAG !other! ${gamma}\n` +
          `---\n- !app2!x b\n- !other!y c\n`
      )
      expect(Object.keys(docB.directives.tags)).toEqual([
        '!!',
        '!app2!',
        '!other!'
      ])
    })
  })

  describe('node contents stay untouched', () => {
    test('anchors, aliases and comments keep their positions', () => {
      const srcB =
        `%TAG !app! ${beta}\n---\n` +
        `# leading comment\n` +
        `first: !app!thing &a value # trailing comment\n` +
        `second: *a\n`
      const docA = parseDocument(`%TAG !app! ${alpha}\n---\n!app!x 1\n`)
      const docB = parseDocument(srcB)
      coordinateTagHandles([docA, docB])

      const out = String(docB)
      expect(out).toBe(
        `%TAG !app2! ${beta}\n---\n` +
          `# leading comment\n` +
          `first: &a !app2!thing value # trailing comment\n` +
          `second: *a\n`
      )

      // The alias still references the very same node as the anchor
      const first = docB.get('first')
      const second = docB.get('second')
      expect(second).toBeInstanceOf(Alias)
      expect((second as Alias).resolve(docB as any)).toBe(first)
    })
  })

  describe('custom tag stringifiers', () => {
    test('are not called during coordination, and once at serialization', () => {
      let stringifyCalls = 0
      const countedTag: ScalarTag = {
        tag: `${alpha}thing`,
        identify: () => false,
        resolve: str => str,
        stringify(item) {
          stringifyCalls += 1
          return String(item.value)
        }
      }
      const docA = parseDocument(`%TAG !app! ${alpha}\n---\n!app!thing v\n`, {
        customTags: [countedTag]
      })
      const docB = parseDocument(`%TAG !app! ${beta}\n---\n!app!thing w\n`)

      const group = coordinateTagHandles([docA, docB])
      expect(stringifyCalls).toBe(0) // coordination does not serialize

      const out = group.toString()
      expect(stringifyCalls).toBe(1) // exactly once, at final serialization
      expect(out).toContain('!app!thing v\n')
      expect(out).toContain('!app2!thing w\n')
    })
  })

  describe('queryable handle mapping', () => {
    test('exposes plans, handleFor() and prefixFor()', () => {
      const docA = parseDocument(`%TAG !app! ${alpha}\n---\n!app!x 1\n`)
      const docB = parseDocument(`%TAG !app! ${beta}\n---\n!app!x 2\n`)
      const group = coordinateTagHandles([docA, docB])

      expect(group.documents[0]).toBe(docA)
      expect(group.documents[1]).toBe(docB)
      expect(group.plans[0].handles).toEqual({
        '!!': 'tag:yaml.org,2002:',
        '!app!': alpha
      })
      expect(group.plans[1].handles).toEqual({
        '!!': 'tag:yaml.org,2002:',
        '!app2!': beta
      })

      expect(group.handleFor(0, alpha)).toBe('!app!')
      expect(group.handleFor(1, beta)).toBe('!app2!')
      expect(group.handleFor(1, alpha)).toBeUndefined()
      expect(group.prefixFor(1, '!app2!')).toBe(beta)
      expect(group.prefixFor(1, '!app!')).toBeUndefined()
      expect(group.prefixFor(99, '!app!')).toBeUndefined()
    })
  })

  describe('group serialization', () => {
    test('inserts --- for documents without directives', () => {
      const docA = parseDocument(`%TAG !app! ${alpha}\n---\n!app!x a\n`)
      const docB = parseDocument('plain\n')
      const group = coordinateTagHandles([docA, docB])
      const out = group.toString()
      expect(out).toBe(`%TAG !app! ${alpha}\n---\n!app!x a\n---\nplain\n`)
      const reDocs = parseAllDocuments(out)
      expect(reDocs).toHaveLength(2)
      expect(reDocs[1].value).toBeInstanceOf(Scalar)
      expect((reDocs[1].value as Scalar).value).toBe('plain')
    })
  })
})
