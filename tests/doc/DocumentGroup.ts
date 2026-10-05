import { Document, DocumentGroup, parseAllDocuments, parseDocument } from 'yaml'
import type { Scalar } from 'yaml'
import { source } from '../_utils.ts'

describe('DocumentGroup', () => {
  test('coordinates conflicting !app! handles', () => {
    const doc1 = parseDocument(source`
      %TAG !app! tag:example.com,2024:app
      ---
      !app!foo hello
    `)
    const doc2 = parseDocument(source`
      %TAG !app! tag:example.org,2024:app
      ---
      !app!bar world
    `)

    const group = new DocumentGroup([doc1, doc2])
    expect(group.getHandleMapping(0)).toEqual({})
    expect(group.getHandleMapping(1)).toEqual({ '!app!': '!app2!' })

    const out = group.toString()
    expect(out).toBe(source`
      %TAG !app! tag:example.com,2024:app
      ---
      !app!foo hello
      ...
      %TAG !app2! tag:example.org,2024:app
      ---
      !app2!bar world
    `)

    // Re-parse and verify tag identities are consistent
    const reparsed = parseAllDocuments(out)
    expect(reparsed[0].value.tag).toBe('tag:example.com,2024:appfoo')
    expect(reparsed[1].value.tag).toBe('tag:example.org,2024:appbar')

    // Node's real tag URI is unchanged
    expect(doc1.value.tag).toBe('tag:example.com,2024:appfoo')
    expect(doc2.value.tag).toBe('tag:example.org,2024:appbar')
  })

  test('does not coordinate handles that agree', () => {
    const doc1 = parseDocument(source`
      %TAG !app! tag:example.com,2024:app
      ---
      !app!foo hello
    `)
    const doc2 = parseDocument(source`
      %TAG !app! tag:example.com,2024:app
      ---
      !app!bar world
    `)

    const group = new DocumentGroup([doc1, doc2])
    expect(group.getHandleMapping(0)).toEqual({})
    expect(group.getHandleMapping(1)).toEqual({})

    const out = group.toString()
    expect(out).toBe(source`
      %TAG !app! tag:example.com,2024:app
      ---
      !app!foo hello
      ...
      %TAG !app! tag:example.com,2024:app
      ---
      !app!bar world
    `)
  })

  test('throws on illegal !! binding without modifying sources', () => {
    const doc = parseDocument(source`
      %TAG !! tag:example.com,2024:
      ---
      !!str hello
    `)
    const originalTags = { ...doc.directives.tags }

    expect(() => new DocumentGroup([doc])).toThrow(
      /the standard !! handle must not be re-bound/
    )

    // Source document is unchanged
    expect(doc.directives.tags).toEqual(originalTags)
    expect(doc.directives.tags['!!']).toBe('tag:example.com,2024:')
  })

  test('preserves aliases and comments', () => {
    const doc1 = parseDocument(source`
      %TAG !app! tag:example.com,2024:app
      ---
      # comment before
      !app!foo &anchor hello
    `)
    const doc2 = parseDocument(source`
      %TAG !app! tag:example.org,2024:app
      ---
      !app!bar world
    `)

    const group = new DocumentGroup([doc1, doc2])
    const out = group.toString()

    const reparsed = parseAllDocuments(out)
    expect(reparsed[0].value.anchor).toBe('anchor')
    expect(reparsed[0].value.commentBefore).toBe(' comment before')
    expect(reparsed[0].value.tag).toBe('tag:example.com,2024:appfoo')
    expect(reparsed[1].value.tag).toBe('tag:example.org,2024:appbar')
  })

  test('calls custom stringifier only once', () => {
    let callCount = 0
    const customTag = {
      tag: 'tag:example.com,2024:appfoo',
      resolve(str: string) {
        return str
      },
      stringify(item: Scalar) {
        callCount++
        return `custom:${item.value}`
      }
    }
    const doc1 = new Document('hello', { customTags: [customTag] })
    doc1.directives.tags['!app!'] = 'tag:example.com,2024:app'
    doc1.value.tag = 'tag:example.com,2024:appfoo'

    const doc2 = new Document('world', { customTags: [customTag] })
    doc2.directives.tags['!app!'] = 'tag:example.org,2024:app'
    doc2.value.tag = 'tag:example.org,2024:appbar'

    const group = new DocumentGroup([doc1, doc2])
    callCount = 0
    const out = group.toString()
    expect(callCount).toBe(1)
    expect(out).toContain('!app!foo custom:hello')
    expect(out).toContain('!app2!bar world')
  })

  test('preserves order of unmentioned directives', () => {
    const doc1 = parseDocument(source`
      %TAG !app! tag:example.com,2024:app
      %TAG !baz! tag:example.com,2024:baz
      ---
      app: !app!foo hello
      baz: !baz!qux value
    `)
    const doc2 = parseDocument(source`
      %TAG !app! tag:example.org,2024:app
      %TAG !baz! tag:example.com,2024:baz
      ---
      app: !app!bar world
      baz: !baz!qux value
    `)

    const group = new DocumentGroup([doc1, doc2])
    const out = group.toString()
    expect(out).toBe(source`
      %TAG !app! tag:example.com,2024:app
      %TAG !baz! tag:example.com,2024:baz
      ---
      app: !app!foo hello
      baz: !baz!qux value
      ...
      %TAG !app2! tag:example.org,2024:app
      %TAG !baz! tag:example.com,2024:baz
      ---
      app: !app2!bar world
      baz: !baz!qux value
    `)

    const reparsed = parseAllDocuments(out)
    expect(reparsed[0].get('app').tag).toBe('tag:example.com,2024:appfoo')
    expect(reparsed[0].get('baz').tag).toBe('tag:example.com,2024:bazqux')
    expect(reparsed[1].get('app').tag).toBe('tag:example.org,2024:appbar')
    expect(reparsed[1].get('baz').tag).toBe('tag:example.com,2024:bazqux')
  })

  test('deterministic assignment across multiple documents', () => {
    const docs = [
      parseDocument(source`
        %TAG !app! tag:a.com,2024:app
        ---
        !app!x 1
      `),
      parseDocument(source`
        %TAG !app! tag:b.com,2024:app
        ---
        !app!y 2
      `),
      parseDocument(source`
        %TAG !app! tag:c.com,2024:app
        ---
        !app!z 3
      `)
    ]

    const group = new DocumentGroup(docs)
    expect(group.getHandleMapping(0)).toEqual({})
    expect(group.getHandleMapping(1)).toEqual({ '!app!': '!app2!' })
    expect(group.getHandleMapping(2)).toEqual({ '!app!': '!app3!' })

    const out = group.toString()
    const reparsed = parseAllDocuments(out)
    expect(reparsed[0].value.tag).toBe('tag:a.com,2024:appx')
    expect(reparsed[1].value.tag).toBe('tag:b.com,2024:appy')
    expect(reparsed[2].value.tag).toBe('tag:c.com,2024:appz')
  })

  test('empty group', () => {
    const group = new DocumentGroup([])
    expect(group.toString()).toBe('')
  })

  test('single document group', () => {
    const doc = parseDocument(source`
      %TAG !app! tag:example.com,2024:app
      ---
      !app!foo hello
    `)
    const group = new DocumentGroup([doc])
    expect(group.getHandleMapping(0)).toEqual({})
    expect(group.toString()).toBe(doc.toString())
  })
})
