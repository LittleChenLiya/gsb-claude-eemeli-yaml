import type { ToStringOptions } from '../options.ts'
import type { Document, DocValue } from './Document.ts'

/**
 * The prefix bound to the secondary handle `!!` by default.
 * The coordinator never rebinds `!!`, and rejects any document that does.
 */
export const defaultSecondaryPrefix = 'tag:yaml.org,2002:'

/**
 * Thrown by {@link coordinateTagHandles} when the documents cannot be
 * coordinated into a single unambiguous stream. When this is thrown, none of
 * the input documents have been modified.
 */
export class TagHandleCoordinationError extends Error {
  /** Index of the document that caused the failure, if applicable. */
  docIndex?: number

  constructor(message: string, docIndex?: number) {
    super(message)
    this.name = 'TagHandleCoordinationError'
    if (docIndex !== undefined) this.docIndex = docIndex
  }
}

/**
 * The coordination plan for a single document.
 */
export interface TagHandlePlan {
  /** Index of the document in the input array. */
  docIndex: number

  /**
   * The complete handle -> prefix map of the document after coordination,
   * in the original directive order. Renamed handles appear at the same
   * position as the handle they replace.
   */
  handles: Record<string, string>

  /**
   * Original handle -> coordinated handle, including only the handles that
   * were actually renamed. Empty if the document required no changes.
   */
  renamed: Record<string, string>
}

/**
 * A group of documents whose tag handle directives have been coordinated so
 * that the documents may be emitted together in one stream without ambiguity.
 * The resolved tag URIs of the nodes themselves are never modified.
 */
export interface CoordinatedDocumentGroup {
  /** The coordinated documents, in input order. */
  documents: Document[]

  /** The coordination plan of each document, in input order. */
  plans: TagHandlePlan[]

  /**
   * Get the handle bound to `prefix` in the coordinated output of the
   * document at `docIndex`, or `undefined` if there is no such binding.
   */
  handleFor(docIndex: number, prefix: string): string | undefined

  /**
   * Get the prefix bound to `handle` in the coordinated output of the
   * document at `docIndex`, or `undefined` if there is no such binding.
   */
  prefixFor(docIndex: number, handle: string): string | undefined

  /**
   * Serialize the whole group as a single YAML stream. A `---` document
   * start marker is inserted for documents that would not otherwise emit
   * one, and a `...` document end marker is inserted before any document
   * that emits directive lines. Custom tag stringifiers are invoked only
   * here, once per node.
   */
  toString(options?: ToStringOptions): string
}

/**
 * Compute a deterministic replacement handle for `handle`, which is already
 * bound to a different prefix elsewhere in the stream. The counter is
 * inserted before the trailing `!` of named handles: `!app!` -> `!app2!`,
 * `!app3!`, ...; the primary handle `!` becomes `!2!`, `!3!`, ...
 *
 * Candidates colliding with any handle used by any input document
 * (`reserved`) or already assigned (`assigned`) are skipped.
 */
function nextHandle(
  handle: string,
  counters: Map<string, number>,
  reserved: ReadonlySet<string>,
  assigned: ReadonlySet<string>
): string {
  let base = handle.endsWith('!') ? handle.slice(0, -1) : handle
  if (base === '') base = '!'
  let n = counters.get(handle) ?? 1
  let candidate: string
  do {
    n += 1
    candidate = `${base}${n}!`
  } while (reserved.has(candidate) || assigned.has(candidate))
  counters.set(handle, n)
  return candidate
}

function emitsDocStart(doc: Document, options: ToStringOptions): boolean {
  if (options.directives === true) return true
  if (options.directives === false) return false
  const dir = doc.directives
  return !!dir && (dir.docStart != null || dir.toString(doc) !== '')
}

function emitsDirectiveLines(doc: Document, options: ToStringOptions): boolean {
  if (options.directives === false) return false
  const dir = doc.directives
  return !!dir && dir.toString(doc) !== ''
}

/**
 * Coordinate the `%TAG` handle directives of multiple documents so that they
 * may be emitted together in a single YAML stream without ambiguity.
 *
 * Documents are inspected in input order. A handle bound to the same prefix
 * in every document is kept as-is. When different documents bind the same
 * handle to different prefixes, the first binding (in input order) keeps the
 * handle and each conflicting document is assigned a fresh deterministic
 * handle (`!app!` -> `!app2!`, `!app3!`, ...). Only the directives are
 * rewritten; the resolved tag URIs of the nodes, as well as all anchors,
 * aliases and comments, are left untouched, so re-parsing the coordinated
 * output yields the same tag identities.
 *
 * The standard `!!` handle is never rebound by the coordinator, and any
 * document binding `!!` to a non-default prefix makes the whole coordination
 * fail. Planning is fully atomic: all plans are validated and computed
 * before anything is applied, so if a `TagHandleCoordinationError` is
 * thrown, none of the input documents have been modified. Directives not
 * involved in a conflict keep their original order, and no serialization
 * (including custom tag stringifiers) is performed until the returned
 * group's `toString()` is called.
 *
 * @returns A queryable group of the coordinated documents.
 * @throws TagHandleCoordinationError if any document illegally rebinds `!!`.
 */
export function coordinateTagHandles(
  docs: ReadonlyArray<Document<DocValue>>
): CoordinatedDocumentGroup {
  // Phase 1: validate. Nothing has been mutated yet, so throwing here
  // leaves all source documents untouched.
  docs.forEach((doc, i) => {
    const prefix = doc.directives?.tags?.['!!']
    if (prefix !== undefined && prefix !== defaultSecondaryPrefix) {
      throw new TagHandleCoordinationError(
        `Document ${i} illegally rebinds the standard !! handle to ${prefix}`,
        i
      )
    }
  })

  // Phase 2: compute the plans. This is pure; no document is touched.
  const reserved = new Set<string>()
  for (const doc of docs) {
    for (const handle of Object.keys(doc.directives?.tags ?? {})) {
      reserved.add(handle)
    }
  }

  const assigned = new Map<string, string>() // handle -> prefix, stream-wide
  const counters = new Map<string, number>()
  const plans: TagHandlePlan[] = docs.map((doc, docIndex) => {
    const tags = doc.directives?.tags ?? {}
    const handles: Record<string, string> = {}
    const renamed: Record<string, string> = {}
    for (const [handle, prefix] of Object.entries(tags)) {
      let out = handle
      if (handle !== '!!') {
        const bound = assigned.get(handle)
        if (bound === undefined) {
          assigned.set(handle, prefix)
        } else if (bound !== prefix) {
          out = nextHandle(handle, counters, reserved, new Set(assigned.keys()))
          assigned.set(out, prefix)
          renamed[handle] = out
        }
      }
      handles[out] = prefix
    }
    return { docIndex, handles, renamed }
  })

  // Phase 3: apply. All plans are valid, so this cannot fail partway.
  // Only documents with actual renames are modified; their tags map is
  // rebuilt in the original entry order so that uninvolved directives
  // keep their positions.
  for (const plan of plans) {
    if (Object.keys(plan.renamed).length === 0) continue
    const dir = docs[plan.docIndex].directives
    if (!dir) continue
    const tags: Record<string, string> = {}
    for (const [handle, prefix] of Object.entries(dir.tags)) {
      tags[plan.renamed[handle] ?? handle] = prefix
    }
    dir.tags = tags
  }

  return {
    documents: docs.slice(),
    plans,

    handleFor(docIndex, prefix) {
      const plan = plans[docIndex]
      if (!plan) return undefined
      for (const [handle, p] of Object.entries(plan.handles)) {
        if (p === prefix) return handle
      }
      return undefined
    },

    prefixFor(docIndex, handle) {
      return plans[docIndex]?.handles[handle]
    },

    toString(options: ToStringOptions = {}) {
      let out = ''
      docs.forEach((doc, i) => {
        let str = doc.toString(options)
        if (i > 0 && !emitsDocStart(doc, options)) str = '---\n' + str
        out += str
        // A document followed by directive lines needs an explicit end
        // marker for the stream to remain parseable.
        const next = docs[i + 1]
        if (
          next &&
          emitsDirectiveLines(next, options) &&
          !str.endsWith('...\n')
        )
          out += '...\n'
      })
      return out
    }
  }
}
