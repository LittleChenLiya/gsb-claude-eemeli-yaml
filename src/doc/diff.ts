/**
 * Explicit two-sided structural comparison of YAML {@link Document}s.
 *
 * Unlike a plain `toString()` comparison, `diffDocuments()` walks both
 * document trees and classifies each difference as a real value change or
 * a mere formatting change (quote style, comments, indentation, flow
 * style, ...). Mappings are paired by actual key identity rather than by
 * position, while sequences are compared by position. Reference sharing
 * (anchors & aliases) is reported separately in `refs`, and aliases are
 * never expanded into their targets recursively, so cyclic documents are
 * compared in finite time.
 *
 * Nodes carrying custom tags that cannot be safely interpreted are marked
 * as `unknown`, and an `unknown` result never counts as equal. Custom
 * `toJSON()` methods are never executed, and the source documents are
 * not modified.
 *
 * Indentation-style differences are detected when both documents were
 * parsed with `keepSourceTokens: true`.
 *
 * @module
 */

import { Alias } from '../nodes/Alias.ts'
import { Pair } from '../nodes/Pair.ts'
import { Scalar } from '../nodes/Scalar.ts'
import type { Node } from '../nodes/types.ts'
import { YAMLMap } from '../nodes/YAMLMap.ts'
import { YAMLSeq } from '../nodes/YAMLSeq.ts'
import { YAMLSet } from '../nodes/YAMLSet.ts'
import type { Document } from './Document.ts'

/** Classification of a single detected difference. */
export type DiffKind =
  /** The actual value differs. */
  | 'value'
  /** Only the presentation differs: quotes, comments, indent, flow style, ... */
  | 'format'
  /** A custom tag cannot be safely interpreted; equality is undecidable. */
  | 'unknown'

/** Overall comparison result. An `unknown` status never counts as equal. */
export type DiffStatus = 'equal' | 'format' | 'value' | 'unknown'

export type DiffPathSegment = string | number

/** A single value, format or unknown difference between two documents. */
export interface DiffChange {
  kind: DiffKind
  /** Path from the document root: map keys as strings, seq indices as numbers. */
  path: DiffPathSegment[]
  message: string
  /** Representation of the left-hand side, if applicable. */
  a?: string
  /** Representation of the right-hand side, if applicable. */
  b?: string
}

/**
 * A difference in reference sharing (anchors & aliases), reported
 * separately from value/format changes. Alias reuse and copied nodes are
 * marked as distinct sides here.
 */
export interface RefChange {
  /** Path at which the sharing difference was detected ([] for doc-level). */
  path: DiffPathSegment[]
  /** The anchor name involved, if any. */
  anchor?: string
  /** Sharing on the left-hand side, e.g. `alias *x`, `copy`, `absent`. */
  a: string
  /** Sharing on the right-hand side. */
  b: string
  message: string
}

export interface DocumentDiff {
  /**
   * `'value'` if any real value differs, else `'unknown'` if any node
   * could not be safely compared, else `'format'` if only presentation
   * differs, else `'equal'`.
   */
  status: DiffStatus
  /** True only if status is `'equal'` and reference sharing also matches. */
  equal: boolean
  /** True if no value differences and no unknown nodes were found. */
  valueEqual: boolean
  /** True if anchors, aliases and node sharing match on both sides. */
  refsEqual: boolean
  /** All detected value/format/unknown differences. */
  changes: DiffChange[]
  /** All detected reference-sharing differences. */
  refs: RefChange[]
}

/** Tags of the YAML core schema & friends whose values we can compare safely. */
const knownTags = new Set([
  'tag:yaml.org,2002:binary',
  'tag:yaml.org,2002:bool',
  'tag:yaml.org,2002:float',
  'tag:yaml.org,2002:int',
  'tag:yaml.org,2002:map',
  'tag:yaml.org,2002:merge',
  'tag:yaml.org,2002:null',
  'tag:yaml.org,2002:omap',
  'tag:yaml.org,2002:pairs',
  'tag:yaml.org,2002:seq',
  'tag:yaml.org,2002:set',
  'tag:yaml.org,2002:str',
  'tag:yaml.org,2002:timestamp',
  'tag:yaml.org,2002:value',
  'tag:yaml.org,2002:yaml'
])

/** The node's explicitly set tag if it is not a safely interpretable one. */
function unsafeTag(node: unknown): string | null {
  const tag = (node as { tag?: unknown } | null | undefined)?.tag
  if (typeof tag === 'string' && !knownTags.has(tag)) return tag
  return null
}

function scalarValuesEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime()
  if (a instanceof Uint8Array && b instanceof Uint8Array) {
    if (a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
    return true
  }
  return false
}

function repr(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value)
  if (value instanceof Date) return value.toISOString()
  if (value instanceof Uint8Array) return `<binary ${value.length}B>`
  try {
    return String(value)
  } catch {
    return '<unprintable>'
  }
}

function describeNode(node: unknown): string {
  if (node == null) return 'null'
  if (node instanceof Alias) return `*${node.source}`
  if (node instanceof Scalar) return repr(node.value)
  if (node instanceof YAMLMap) return 'map'
  if (node instanceof YAMLSeq) return 'seq'
  if (node instanceof YAMLSet) return 'set'
  if (node instanceof Pair) return 'pair'
  switch (typeof node) {
    case 'string':
      return node
    case 'number':
    case 'boolean':
    case 'bigint':
      return String(node)
    default:
      return 'node'
  }
}

interface AnchorInfo {
  anchored: boolean
  aliases: number
}

interface DocRefs {
  anchors: Map<string, AnchorInfo>
  /** Number of occurrences of each node object within the document. */
  counts: Map<unknown, number>
}

/** Collect anchor/alias usage and node sharing without expanding aliases. */
function collectRefs(doc: Document): DocRefs {
  const anchors = new Map<string, AnchorInfo>()
  const counts = new Map<unknown, number>()
  const expanded = new Set<unknown>()
  const walk = (node: unknown): void => {
    if (node == null) return
    if (
      !(node instanceof Scalar) &&
      !(node instanceof Alias) &&
      !(node instanceof YAMLMap) &&
      !(node instanceof YAMLSeq) &&
      !(node instanceof YAMLSet) &&
      !(node instanceof Pair)
    )
      return
    counts.set(node, (counts.get(node) ?? 0) + 1)
    if (expanded.has(node)) return
    expanded.add(node)
    if (node instanceof Alias) {
      const info = anchors.get(node.source) ?? { anchored: false, aliases: 0 }
      info.aliases += 1
      anchors.set(node.source, info)
      return
    }
    const anchor = (node as Scalar | YAMLMap | YAMLSeq | YAMLSet).anchor
    if (anchor) {
      const info = anchors.get(anchor) ?? { anchored: false, aliases: 0 }
      info.anchored = true
      anchors.set(anchor, info)
    }
    if (node instanceof Pair) {
      walk(node.key)
      walk(node.value)
    } else if (node instanceof YAMLSeq) {
      for (const item of node) walk(item)
    } else if (node instanceof YAMLMap) {
      for (const pair of node.values.values()) {
        walk(pair.key)
        walk(pair.value)
      }
    } else if (node instanceof YAMLSet) {
      for (const key of node.values.values()) walk(key)
    }
  }
  walk(doc.value)
  return { anchors, counts }
}

interface MapItem {
  key: unknown
  value: unknown
  index: number
}

function mapItems(map: YAMLMap | YAMLSet): MapItem[] {
  if (map instanceof YAMLSet)
    return Array.from(map.values.values(), (key, index) => ({
      key,
      value: null,
      index
    }))
  return Array.from(map.values.values(), (pair, index) => ({
    key: pair.key,
    value: pair.value,
    index
  }))
}

function keySegment(key: unknown, index: number): string | number {
  if (key instanceof Scalar) {
    const v = key.value
    if (v == null || typeof v !== 'object') return String(v)
  }
  return `#${index}`
}

class Differ {
  readonly changes: DiffChange[] = []
  readonly refs: RefChange[] = []

  /** Pairs of nodes already compared; doubles as a cycle guard. */
  private readonly compared = new Map<unknown, Set<unknown>>()
  private readonly sharedReported = new Set<unknown>()
  private readonly aRefs: DocRefs
  private readonly bRefs: DocRefs
  private readonly aDoc: Document
  private readonly bDoc: Document

  constructor(aDoc: Document, bDoc: Document) {
    this.aDoc = aDoc
    this.bDoc = bDoc
    this.aRefs = collectRefs(aDoc)
    this.bRefs = collectRefs(bDoc)
  }

  run(): DocumentDiff {
    this.compareDocumentProps()
    this.compareNode(this.aDoc.value, this.bDoc.value, [], false)
    this.compareAnchorTables()
    const hasValue = this.changes.some(c => c.kind === 'value')
    const hasUnknown = this.changes.some(c => c.kind === 'unknown')
    const hasFormat = this.changes.some(c => c.kind === 'format')
    const status: DiffStatus = hasValue
      ? 'value'
      : hasUnknown
        ? 'unknown'
        : hasFormat
          ? 'format'
          : 'equal'
    const refsEqual = this.refs.length === 0
    return {
      status,
      equal: status === 'equal' && refsEqual,
      valueEqual: !hasValue && !hasUnknown,
      refsEqual,
      changes: this.changes,
      refs: this.refs
    }
  }

  private compareDocumentProps(): void {
    this.cmpFormat(
      [],
      'document commentBefore',
      this.aDoc.commentBefore ?? null,
      this.bDoc.commentBefore ?? null
    )
    this.cmpFormat(
      [],
      'document comment',
      this.aDoc.comment ?? null,
      this.bDoc.comment ?? null
    )
    this.cmpFormat(
      [],
      'YAML version',
      this.aDoc.directives?.yaml?.version ?? null,
      this.bDoc.directives?.yaml?.version ?? null
    )
  }

  private compareAnchorTables(): void {
    const names = new Set([
      ...this.aRefs.anchors.keys(),
      ...this.bRefs.anchors.keys()
    ])
    for (const name of names) {
      const ai = this.aRefs.anchors.get(name)
      const bi = this.bRefs.anchors.get(name)
      const same = ai?.anchored === bi?.anchored && ai?.aliases === bi?.aliases
      if (!same) {
        const desc = (info: AnchorInfo | undefined) =>
          info
            ? `&${name} (${info.aliases} ${info.aliases === 1 ? 'alias' : 'aliases'})`
            : 'absent'
        this.refs.push({
          path: [],
          anchor: name,
          a: desc(ai),
          b: desc(bi),
          message: `anchor &${name} usage differs`
        })
      }
    }
  }

  private cmpFormat(
    path: DiffPathSegment[],
    label: string,
    av: unknown,
    bv: unknown
  ): void {
    const a2 = av ?? null
    const b2 = bv ?? null
    if (a2 === b2) return
    const str = (v: unknown) =>
      typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v)
    this.changes.push({
      kind: 'format',
      path,
      message: `${label} differs`,
      a: str(a2),
      b: str(b2)
    })
  }

  private compareNode(
    a: unknown,
    b: unknown,
    path: DiffPathSegment[],
    viaAlias: boolean
  ): void {
    if (a == null && b == null) return
    if (a == null || b == null) {
      this.changes.push({
        kind: 'value',
        path,
        message: 'node present on only one side',
        a: describeNode(a),
        b: describeNode(b)
      })
      return
    }

    // Skip pairs already compared; this also keeps cyclic graphs finite.
    let set = this.compared.get(a)
    if (set?.has(b)) return
    if (!set) {
      set = new Set()
      this.compared.set(a, set)
    }
    set.add(b)

    // Custom tags cannot be safely interpreted; never counts as equal.
    const aTag = unsafeTag(a)
    const bTag = unsafeTag(b)
    if (aTag != null || bTag != null) {
      this.changes.push({
        kind: 'unknown',
        path,
        message:
          aTag != null && aTag === bTag
            ? `custom tag ${aTag} cannot be safely compared`
            : 'custom tags cannot be safely compared',
        a: aTag ?? undefined,
        b: bTag ?? undefined
      })
      return
    }

    if (a instanceof Alias || b instanceof Alias) {
      this.compareAlias(a, b, path)
      return
    }

    if (!viaAlias) {
      this.compareAnchorAt(a, b, path)
      this.compareSharingAt(a, b, path)
    }

    if (a instanceof Pair && b instanceof Pair) {
      this.compareNode(a.key, b.key, path, viaAlias)
      this.compareNode(a.value, b.value, path, viaAlias)
      return
    }

    if ((a as Node).constructor !== (b as Node).constructor) {
      this.changes.push({
        kind: 'value',
        path,
        message: 'node type differs',
        a: describeNode(a),
        b: describeNode(b)
      })
      return
    }

    if (a instanceof Scalar && b instanceof Scalar)
      this.compareScalar(a, b, path)
    else if (a instanceof YAMLSeq && b instanceof YAMLSeq)
      this.compareSeq(a, b, path)
    else if (
      (a instanceof YAMLMap || a instanceof YAMLSet) &&
      (b instanceof YAMLMap || b instanceof YAMLSet)
    )
      this.compareMap(a, b, path)
  }

  private compareAlias(a: unknown, b: unknown, path: DiffPathSegment[]): void {
    if (a instanceof Alias && b instanceof Alias) {
      if (a.source !== b.source)
        this.refs.push({
          path,
          anchor: a.source,
          a: `alias *${a.source}`,
          b: `alias *${b.source}`,
          message: 'alias targets differ'
        })
      return
    }
    const alias = (a instanceof Alias ? a : b) as Alias
    const doc = a instanceof Alias ? this.aDoc : this.bDoc
    // Alias reuse on one side, copied node on the other: mark separately.
    this.refs.push({
      path,
      anchor: alias.source,
      a: a instanceof Alias ? `alias *${alias.source}` : 'copy',
      b: b instanceof Alias ? `alias *${alias.source}` : 'copy',
      message: 'alias reuse on one side, copied node on the other'
    })
    const resolved = alias.resolve(doc)
    if (resolved) {
      // Compare the alias target against the copy once, without following
      // any further aliases, so cycles cannot expand into infinite trees.
      this.compareNode(
        a instanceof Alias ? resolved : a,
        b instanceof Alias ? resolved : b,
        path,
        true
      )
    } else {
      this.changes.push({
        kind: 'unknown',
        path,
        message: `alias *${alias.source} cannot be resolved`
      })
    }
  }

  private compareAnchorAt(a: unknown, b: unknown, path: DiffPathSegment[]) {
    const aa = (a as { anchor?: string }).anchor ?? null
    const ba = (b as { anchor?: string }).anchor ?? null
    if (aa !== ba)
      this.refs.push({
        path,
        anchor: aa ?? ba ?? undefined,
        a: aa ? `anchor &${aa}` : 'no anchor',
        b: ba ? `anchor &${ba}` : 'no anchor',
        message: 'anchor presence differs'
      })
  }

  private compareSharingAt(a: unknown, b: unknown, path: DiffPathSegment[]) {
    const ac = this.aRefs.counts.get(a) ?? 0
    const bc = this.bRefs.counts.get(b) ?? 0
    if (
      ac > 1 !== bc > 1 &&
      !this.sharedReported.has(a) &&
      !this.sharedReported.has(b)
    ) {
      this.sharedReported.add(a)
      this.sharedReported.add(b)
      const desc = (n: number) =>
        n > 1 ? `shared node (×${n})` : 'single copy'
      this.refs.push({
        path,
        a: desc(ac),
        b: desc(bc),
        message: 'reference sharing differs'
      })
    }
  }

  private compareCommonFormat(a: Node, b: Node, path: DiffPathSegment[]) {
    this.cmpFormat(path, 'comment', a.comment ?? null, b.comment ?? null)
    this.cmpFormat(
      path,
      'commentBefore',
      a.commentBefore ?? null,
      b.commentBefore ?? null
    )
    this.cmpFormat(path, 'spaceBefore', !!a.spaceBefore, !!b.spaceBefore)
    const ai = a.srcToken && 'indent' in a.srcToken ? a.srcToken.indent : null
    const bi = b.srcToken && 'indent' in b.srcToken ? b.srcToken.indent : null
    if (ai != null && bi != null && ai !== bi)
      this.changes.push({
        kind: 'format',
        path,
        message: 'indentation differs',
        a: String(ai),
        b: String(bi)
      })
  }

  private compareScalar(a: Scalar, b: Scalar, path: DiffPathSegment[]) {
    if (!scalarValuesEqual(a.value, b.value)) {
      this.changes.push({
        kind: 'value',
        path,
        message: 'scalar value differs',
        a: repr(a.value),
        b: repr(b.value)
      })
      return
    }
    this.cmpFormat(path, 'quote style', a.type ?? null, b.type ?? null)
    this.cmpFormat(path, 'scalar source', a.source ?? null, b.source ?? null)
    this.cmpFormat(path, 'number format', a.format ?? null, b.format ?? null)
    this.cmpFormat(
      path,
      'minFractionDigits',
      a.minFractionDigits ?? null,
      b.minFractionDigits ?? null
    )
    this.cmpFormat(path, 'tag', a.tag ?? null, b.tag ?? null)
    this.compareCommonFormat(a, b, path)
  }

  private compareCollectionFormat(
    a: YAMLMap | YAMLSeq | YAMLSet,
    b: YAMLMap | YAMLSeq | YAMLSet,
    path: DiffPathSegment[]
  ) {
    this.cmpFormat(path, 'flow style', !!a.flow, !!b.flow)
    this.cmpFormat(path, 'tag', a.tag ?? null, b.tag ?? null)
    this.compareCommonFormat(a, b, path)
  }

  private compareSeq(a: YAMLSeq, b: YAMLSeq, path: DiffPathSegment[]) {
    this.compareCollectionFormat(a, b, path)
    // Sequences are compared by position.
    const len = Math.max(a.length, b.length)
    for (let i = 0; i < len; i++) {
      if (i >= a.length)
        this.changes.push({
          kind: 'value',
          path: [...path, i],
          message: 'seq item added',
          b: describeNode(b[i])
        })
      else if (i >= b.length)
        this.changes.push({
          kind: 'value',
          path: [...path, i],
          message: 'seq item removed',
          a: describeNode(a[i])
        })
      else this.compareNode(a[i], b[i], [...path, i], false)
    }
  }

  private compareMap(
    a: YAMLMap | YAMLSet,
    b: YAMLMap | YAMLSet,
    path: DiffPathSegment[]
  ) {
    this.compareCollectionFormat(a, b, path)
    const aItems = mapItems(a)
    const bItems = mapItems(b)
    const matchedB = new Map<number, number>() // a index -> b index
    const bTaken = new Set<number>()

    // First pair up keys with custom tags by tag name; their values are
    // not safely interpretable, so mark them unknown rather than recursing.
    for (const ai of aItems) {
      const tag = unsafeTag(ai.key)
      if (tag == null) continue
      const j = bItems.findIndex(
        (bi, k) => !bTaken.has(k) && unsafeTag(bi.key) === tag
      )
      if (j !== -1) {
        matchedB.set(ai.index, j)
        bTaken.add(j)
        this.changes.push({
          kind: 'unknown',
          path: [...path, keySegment(ai.key, ai.index)],
          message: `map key with custom tag ${tag} cannot be safely compared`
        })
      }
    }

    // Then pair remaining entries by actual key identity.
    for (const ai of aItems) {
      if (matchedB.has(ai.index)) continue
      const j = bItems.findIndex(
        (bi, k) => !bTaken.has(k) && this.keysIdentical(ai.key, bi.key)
      )
      if (j !== -1) {
        matchedB.set(ai.index, j)
        bTaken.add(j)
      }
    }

    for (const ai of aItems) {
      const seg = keySegment(ai.key, ai.index)
      const j = matchedB.get(ai.index)
      if (j === undefined) {
        const tag = unsafeTag(ai.key)
        this.changes.push({
          kind: tag != null ? 'unknown' : 'value',
          path: [...path, seg],
          message:
            tag != null
              ? `map key with custom tag ${tag} has no match`
              : 'map key removed',
          a: describeNode(ai.key)
        })
        continue
      }
      const bi = bItems[j]
      // Key format differences (e.g. quoted vs plain key) are format-only.
      const before = this.changes.length
      this.compareNode(ai.key, bi.key, [...path, seg], false)
      for (let k = before; k < this.changes.length; k++)
        this.changes[k].message = `key ${this.changes[k].message}`
      this.compareNode(ai.value, bi.value, [...path, seg], false)
    }

    for (const bi of bItems) {
      if (bTaken.has(bi.index)) continue
      const tag = unsafeTag(bi.key)
      this.changes.push({
        kind: tag != null ? 'unknown' : 'value',
        path: [...path, keySegment(bi.key, bi.index)],
        message:
          tag != null
            ? `map key with custom tag ${tag} has no match`
            : 'map key added',
        b: describeNode(bi.key)
      })
    }
  }

  private keysIdentical(a: unknown, b: unknown): boolean {
    if (a == null || b == null) return a == null && b == null
    if (unsafeTag(a) != null || unsafeTag(b) != null) return false
    return this.nodesEqual(a, b, [])
  }

  /** Structural equality, used for matching map keys by identity. */
  private nodesEqual(
    a: unknown,
    b: unknown,
    seen: Array<[unknown, unknown]>
  ): boolean {
    if (a == null || b == null) return a == null && b == null
    for (const [x, y] of seen) if (x === a && y === b) return true
    seen.push([a, b])
    if (a instanceof Scalar && b instanceof Scalar)
      return scalarValuesEqual(a.value, b.value)
    if (a instanceof Alias && b instanceof Alias) return a.source === b.source
    if (a instanceof Pair && b instanceof Pair)
      return (
        this.nodesEqual(a.key, b.key, seen) &&
        this.nodesEqual(a.value, b.value, seen)
      )
    if (a instanceof YAMLSeq && b instanceof YAMLSeq) {
      if (a.length !== b.length) return false
      for (let i = 0; i < a.length; i++)
        if (!this.nodesEqual(a[i], b[i], seen)) return false
      return true
    }
    const aIsMap = a instanceof YAMLMap || a instanceof YAMLSet
    const bIsMap = b instanceof YAMLMap || b instanceof YAMLSet
    if (
      aIsMap &&
      bIsMap &&
      (a as Node).constructor === (b as Node).constructor
    ) {
      const ai = mapItems(a as YAMLMap | YAMLSet)
      const bi = mapItems(b as YAMLMap | YAMLSet)
      if (ai.length !== bi.length) return false
      const used = new Set<number>()
      outer: for (const x of ai) {
        for (let j = 0; j < bi.length; j++) {
          if (used.has(j)) continue
          if (
            this.nodesEqual(x.key, bi[j].key, seen) &&
            this.nodesEqual(x.value, bi[j].value, seen)
          ) {
            used.add(j)
            continue outer
          }
        }
        return false
      }
      return true
    }
    return false
  }
}

/**
 * Compare two documents explicitly, telling real value changes apart from
 * mere formatting changes (quote style, comments, indentation, flow style).
 *
 * - Mappings are paired by actual key identity; sequences by position.
 * - Reference sharing (anchors, aliases, shared vs copied nodes) is
 *   reported separately in `refs`; aliases are never expanded recursively,
 *   so cyclic documents terminate.
 * - Nodes with custom tags that cannot be safely interpreted are marked
 *   `unknown`, and an `unknown` result never counts as equal.
 * - Custom `toJSON()` methods are never executed.
 * - Neither document is modified.
 */
export function diffDocuments(a: Document, b: Document): DocumentDiff {
  if (a === b)
    return {
      status: 'equal',
      equal: true,
      valueEqual: true,
      refsEqual: true,
      changes: [],
      refs: []
    }
  return new Differ(a, b).run()
}
