import type { ToStringOptions } from '../options.ts'
import { stringifyDocument } from '../stringify/stringifyDocument.ts'
import { Directives } from './directives.ts'
import { Document } from './Document.ts'

/**
 * A group of documents whose tag handles are coordinated so that the
 * stringified output is unambiguous.
 *
 * When multiple documents share a tag handle but bind it to different URIs,
 * the coordinator deterministically assigns new handles to the conflicting
 * documents. The nodes' real tag URIs are never modified; only the handle
 * mapping used during stringification changes.
 *
 * The standard `!!` handle is never re-bound.
 */
export class DocumentGroup {
  /** The documents in the group. */
  readonly docs: Document[]

  /** docIndex -> (originalHandle -> coordinatedHandle) */
  readonly #plan: Map<number, Map<string, string>>

  constructor(docs: Document[]) {
    this.docs = docs
    this.#plan = buildPlan(docs)
  }

  /**
   * Returns a copy of the handle coordination mapping for the document at
   * `docIndex`. The mapping maps each original handle to its coordinated
   * handle.
   */
  getHandleMapping(docIndex: number): Record<string, string> {
    const mapping = this.#plan.get(docIndex)
    return mapping ? Object.fromEntries(mapping) : {}
  }

  /**
   * Stringifies all documents in the group, coordinating their tag handles
   * so that the output is unambiguous.
   */
  toString(options: ToStringOptions = {}): string {
    return this.docs
      .map((doc, i) => {
        const directives = coordinatedDirectives(doc, this.#plan.get(i)!)
        const copy = copyDocWithDirectives(doc, directives)
        return stringifyDocument(copy, options)
      })
      .join('...\n')
  }
}

/**
 * Builds the coordination plan for the given documents.
 *
 * For each handle that is bound to a URI in more than one document, if the
 * URIs differ, the first document keeps the original handle and subsequent
 * documents are assigned new, unique handles.
 *
 * The standard `!!` handle is never re-bound; an error is thrown if any
 * document binds `!!` to a non-default URI.
 */
function buildPlan(docs: Document[]): Map<number, Map<string, string>> {
  const plan = new Map<number, Map<string, string>>()

  // handle -> URI -> list of docIndex
  const handleUris = new Map<string, Map<string, number[]>>()

  for (let i = 0; i < docs.length; i++) {
    const doc = docs[i]
    if (!doc.directives) {
      plan.set(i, new Map())
      continue
    }
    for (const [handle, uri] of Object.entries(doc.directives.tags)) {
      if (handle === '!!') {
        if (uri !== Directives.defaultTags['!!']) {
          throw new Error(
            `Illegal ${handle} binding to ${uri} in document ${i}; ` +
              `the standard !! handle must not be re-bound`
          )
        }
        continue
      }
      if (uri.startsWith('!')) continue // local tag prefix, not a URI
      let uris = handleUris.get(handle)
      if (!uris) {
        uris = new Map()
        handleUris.set(handle, uris)
      }
      let indices = uris.get(uri)
      if (!indices) {
        indices = []
        uris.set(uri, indices)
      }
      indices.push(i)
    }
    plan.set(i, new Map())
  }

  for (const [handle, uris] of handleUris) {
    if (uris.size <= 1) continue // all documents agree, no coordination needed
    const indices = new Set<number>()
    for (const list of uris.values()) for (const i of list) indices.add(i)
    const sorted = [...indices].sort((a, b) => a - b)
    const first = sorted[0]
    const base = handle.slice(0, -1) // remove trailing '!'
    for (const i of sorted) {
      if (i === first) continue // keep original handle
      const doc = docs[i]
      const existing = new Set(Object.keys(doc.directives!.tags))
      const newHandle = uniqueHandle(base, existing, i + 1)
      plan.get(i)!.set(handle, newHandle)
    }
  }

  return plan
}

/**
 * Returns a new `Directives` instance with the coordinated handles applied,
 * preserving the original order of unmentioned directives.
 */
function coordinatedDirectives(
  doc: Document,
  mapping: Map<string, string>
): Directives {
  const original = doc.directives!
  const tags: Record<string, string> = {}
  for (const [handle, uri] of Object.entries(original.tags)) {
    const newHandle = mapping.get(handle) ?? handle
    tags[newHandle] = uri
  }
  const result = new Directives(original.yaml, {})
  result.tags = tags
  result.docStart = original.docStart
  result.docEnd = original.docEnd
  return result
}

/**
 * Returns a shallow copy of `doc` with its directives replaced by
 * `directives`. The document's value (and thus its aliases and comments) is
 * shared, not cloned.
 */
function copyDocWithDirectives(
  doc: Document,
  directives: Directives
): Document {
  const copy = Object.create(Document.prototype) as Document
  copy.commentBefore = doc.commentBefore
  copy.comment = doc.comment
  copy.errors = doc.errors
  copy.warnings = doc.warnings
  copy.options = doc.options
  copy.directives = directives
  copy.schema = doc.schema
  copy.value = doc.value
  copy.range = doc.range
  return copy
}

/**
 * Returns a unique handle based on `base` (a handle without its trailing
 * `!`), incrementing a counter from `start` until a handle not in `existing`
 * is found.
 */
function uniqueHandle(base: string, existing: Set<string>, start = 2): string {
  let counter = start
  let handle = `${base}${counter}!`
  while (existing.has(handle)) {
    counter++
    handle = `${base}${counter}!`
  }
  return handle
}
