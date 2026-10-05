import { Alias } from '../nodes/Alias.ts'
import { isCollection, isNode } from '../nodes/identity.ts'
import { Pair } from '../nodes/Pair.ts'
import { Scalar } from '../nodes/Scalar.ts'
import type { Collection, Node } from '../nodes/types.ts'
import { YAMLMap } from '../nodes/YAMLMap.ts'
import { YAMLSeq } from '../nodes/YAMLSeq.ts'
import { YAMLSet } from '../nodes/YAMLSet.ts'
import type { Document } from './Document.ts'

/**
 * A path through a document's node tree. Map keys are represented by their
 * primitive value (string/number/bigint/boolean), sequence entries by index.
 */
export type DiffPath = (string | number)[]

export type DiffCategory = 'value' | 'style' | 'ref' | 'unknown'

/** A real semantic difference: a scalar value, node type, or collection membership differs. */
export interface ValueChange {
  category: 'value'
  path: DiffPath
  kind: 'scalar' | 'type' | 'key-added' | 'key-removed' | 'element-added' | 'element-removed' | 'missing'
  left?: unknown
  right?: unknown
  message: string
}

/** A style-only difference: the value is the same, but its presentation differs. */
export interface StyleChange {
  category: 'style'
  path: DiffPath
  fields: { field: string; left: unknown; right: unknown }[]
}

export type RefKind = 'alias' | 'target' | 'copy'

export interface RefStatus {
  kind: RefKind
  anchor?: string
}

/** A difference in how nodes are shared (alias reuse vs. independent copies). */
export interface RefChange {
  category: 'ref'
  path: DiffPath
  left: RefStatus
  right: RefStatus
  message: string
}

/** A node carrying a custom tag that cannot be safely interpreted. */
export interface UnknownChange {
  category: 'unknown'
  path: DiffPath
  side: 'left' | 'right' | 'both'
  tag: string
  message: string
}

export type DiffChange = ValueChange | StyleChange | RefChange | UnknownChange

/** A node that is anchored and referenced by at least one alias. */
export interface SharedNode {
  anchor: string
  targetPath: DiffPath
  aliasPaths: DiffPath[]
}

export interface CompareOptions {
  /** Include document-level metadata (leading/trailing comments, directives). Default: true. */
  includeMetadata?: boolean
}

/**
 * The result of explicitly comparing two documents side by side.
 *
 * Value differences (`valueChanges`) and unknown custom tags (`unknownChanges`)
 * determine `equal`. Style differences (`styleChanges`) are reported separately
 * and never affect `equal`. Reference-sharing differences (`refChanges`) are
 * also reported separately: the values may be equal even when one side reuses
 * an aliased node while the other keeps independent copies.
 */
export class DocumentDiff {
  equal: boolean
  styleEqual: boolean
  valueChanges: ValueChange[]
  styleChanges: StyleChange[]
  refChanges: RefChange[]
  unknownChanges: UnknownChange[]
  references: { left: SharedNode[]; right: SharedNode[] }

  /** All changes in traversal order. */
  changes: DiffChange[]

  constructor(
    changes: DiffChange[],
    references: { left: SharedNode[]; right: SharedNode[] }
  ) {
    this.changes = changes
    this.references = references
    this.valueChanges = changes.filter(
      (c): c is ValueChange => c.category === 'value'
    )
    this.styleChanges = changes.filter(
      (c): c is StyleChange => c.category === 'style'
    )
    this.refChanges = changes.filter((c): c is RefChange => c.category === 'ref')
    this.unknownChanges = changes.filter(
      (c): c is UnknownChange => c.category === 'unknown'
    )
    this.equal = this.valueChanges.length === 0 && this.unknownChanges.length === 0
    this.styleEqual = this.styleChanges.length === 0
  }

  /** A human-readable, line-oriented summary of the diff. */
  toString(): string {
    const lines: string[] = []
    const fmtPath = (p: DiffPath) => (p.length ? p.map(String).join('.') : '<root>')
    for (const c of this.changes) {
      const at = fmtPath(c.path)
      switch (c.category) {
        case 'value':
          lines.push(`value   at ${at}: ${c.message}`)
          break
        case 'style':
          lines.push(
            `style   at ${at}: ${c.fields.map(f => `${f.field} ${fmtVal(f.left)} -> ${fmtVal(f.right)}`).join(', ')}`
          )
          break
        case 'ref':
          lines.push(`ref     at ${at}: ${c.message}`)
          break
        case 'unknown':
          lines.push(`unknown at ${at} (${c.side}): ${c.message}`)
          break
      }
    }
    if (this.references.left.length || this.references.right.length) {
      const fmtShared = (s: SharedNode) =>
        `&${s.anchor} at ${fmtPath(s.targetPath)} -> aliases at ${s.aliasPaths.map(fmtPath).join(', ')}`
      lines.push('references left:')
      for (const s of this.references.left) lines.push(`  ${fmtShared(s)}`)
      lines.push('references right:')
      for (const s of this.references.right) lines.push(`  ${fmtShared(s)}`)
    }
    lines.push(
      `equal=${this.equal} styleEqual=${this.styleEqual} value=${this.valueChanges.length} style=${this.styleChanges.length} ref=${this.refChanges.length} unknown=${this.unknownChanges.length}`
    )
    return lines.join('\n')
  }

  /** A plain, JSON-serializable representation of the diff. */
  toJSON(): {
    equal: boolean
    styleEqual: boolean
    valueChanges: ValueChange[]
    styleChanges: StyleChange[]
    refChanges: RefChange[]
    unknownChanges: UnknownChange[]
    references: { left: SharedNode[]; right: SharedNode[] }
  } {
    return {
      equal: this.equal,
      styleEqual: this.styleEqual,
      valueChanges: this.valueChanges.map(c => ({
        ...c,
        left: serVal(c.left),
        right: serVal(c.right)
      })),
      styleChanges: this.styleChanges,
      refChanges: this.refChanges,
      unknownChanges: this.unknownChanges,
      references: this.references
    }
  }
}

interface SideState {
  doc: Document
  anchors: Map<string, { node: Node; path: DiffPath }>
  aliases: { node: Alias; path: DiffPath; source: string }[]
  referenced: Set<string>
  shared: SharedNode[]
  /** Collections currently on the recursion stack, keyed by identity. */
  active: Set<Node>
}

interface CompareContext {
  left: SideState
  right: SideState
  changes: DiffChange[]
  options: Required<CompareOptions>
}

/** The well-known YAML core tags. Anything else is treated as a custom, un-interpretable tag. */
const CORE_TAGS = new Set<string>([
  'tag:yaml.org,2002:map',
  'tag:yaml.org,2002:seq',
  'tag:yaml.org,2002:set',
  'tag:yaml.org,2002:omap',
  'tag:yaml.org,2002:pairs',
  'tag:yaml.org,2002:str',
  'tag:yaml.org,2002:int',
  'tag:yaml.org,2002:float',
  'tag:yaml.org,2002:bool',
  'tag:yaml.org,2002:null',
  'tag:yaml.org,2002:binary',
  'tag:yaml.org,2002:timestamp',
  'tag:yaml.org,2002:merge'
])

/**
 * Explicitly compare two documents side by side.
 *
 * The comparison works on the parsed AST nodes (not on `toString()` output), so
 * quote style, comments and indentation/flow layout are reported as style
 * changes while the resolved values are compared directly. Maps are paired by
 * actual key identity, sequences by position. Alias targets are resolved but
 * shared nodes are only entered once, so cyclic references are never expanded
 * into infinite trees. Custom tags that cannot be safely interpreted are
 * marked `unknown` (and never count as equal); custom `toJSON` is never called.
 */
export function compareDocuments(
  left: Document,
  right: Document,
  options: CompareOptions = {}
): DocumentDiff {
  const ctx: CompareContext = {
    left: createSideState(left),
    right: createSideState(right),
    changes: [],
    options: { includeMetadata: options.includeMetadata ?? true }
  }

  if (ctx.options.includeMetadata) compareMetadata(left, right, ctx)

  const lv = left.value as Node | null | undefined
  const rv = right.value as Node | null | undefined
  if (lv == null && rv == null) {
    // both empty: equal
  } else if (lv == null || rv == null) {
    ctx.changes.push({
      category: 'value',
      path: [],
      kind: 'missing',
      left: lv ?? null,
      right: rv ?? null,
      message: lv == null ? 'Left document is empty' : 'Right document is empty'
    })
  } else {
    compareNodes(lv, rv, [], ctx)
  }

  return new DocumentDiff(ctx.changes, {
    left: ctx.left.shared,
    right: ctx.right.shared
  })
}

function createSideState(doc: Document): SideState {
  const anchors = new Map<string, { node: Node; path: DiffPath }>()
  const aliases: { node: Alias; path: DiffPath; source: string }[] = []
  const walkSeen = new Set<Node>()

  const visit = (node: Node | Pair, path: DiffPath): void => {
    if (node instanceof Pair) {
      visit(node.key, [...path, 'key'])
      if (node.value) visit(node.value, [...path, 'value'])
      return
    }
    if (node instanceof Alias) {
      aliases.push({ node, path, source: node.source })
      return
    }
    if (node.anchor) anchors.set(node.anchor, { node, path })
    if (isCollection(node)) {
      if (walkSeen.has(node)) return
      walkSeen.add(node)
      if (node instanceof YAMLMap) {
        for (const pair of node.values.values()) {
          const kp = keyPath(pair.key)
          visit(pair.key, [...path, kp])
          if (pair.value) visit(pair.value, [...path, kp])
        }
      } else if (node instanceof YAMLSeq) {
        node.forEach((item, i) => visit(item, [...path, i]))
      } else if (node instanceof YAMLSet) {
        let i = 0
        for (const item of node.values.values()) visit(item, [...path, i++])
      }
    }
  }

  const root = doc.value as Node | null | undefined
  if (root != null) visit(root, [])

  const referenced = new Set(aliases.map(a => a.source))
  const shared: SharedNode[] = []
  for (const [anchor, { path }] of anchors) {
    if (referenced.has(anchor)) {
      shared.push({
        anchor,
        targetPath: path,
        aliasPaths: aliases.filter(a => a.source === anchor).map(a => a.path)
      })
    }
  }

  return { doc, anchors, aliases, referenced, shared, active: new Set() }
}

function compareMetadata(left: Document, right: Document, ctx: CompareContext): void {
  const fields: StyleChange['fields'] = []
  if (left.commentBefore !== right.commentBefore)
    fields.push({ field: 'commentBefore', left: left.commentBefore, right: right.commentBefore })
  if (left.comment !== right.comment)
    fields.push({ field: 'comment', left: left.comment, right: right.comment })
  const lYaml = left.directives?.yaml.version ?? null
  const rYaml = right.directives?.yaml.version ?? null
  if (lYaml !== rYaml) fields.push({ field: 'yaml-version', left: lYaml, right: rYaml })
  if (fields.length) ctx.changes.push({ category: 'style', path: [], fields })
}

function compareNodes(l: Node, r: Node, path: DiffPath, ctx: CompareContext): void {
  const lIsAlias = l instanceof Alias
  const rIsAlias = r instanceof Alias
  // Resolve aliases via the preprocessed anchors map. This is cycle-safe: it
  // never walks the document, so cyclic references are not expanded.
  const lEff = lIsAlias ? resolveAlias(l, ctx.left) : l
  const rEff = rIsAlias ? resolveAlias(r, ctx.right) : r

  // Reference-sharing status at this position.
  const lRef = refStatus(l, lEff, ctx.left)
  const rRef = refStatus(r, rEff, ctx.right)

  // A position reached via an alias on one side but as an independent node on
  // the other is a sharing difference, even when the values are equal.
  if (lIsAlias !== rIsAlias) {
    ctx.changes.push({
      category: 'ref',
      path: [...path],
      left: lRef,
      right: rRef,
      message: lIsAlias
        ? 'Left reuses an aliased node; right has a separate copy'
        : 'Right reuses an aliased node; left has a separate copy'
    })
  }

  // Custom tags that cannot be safely interpreted: report as unknown and do
  // not attempt to compare their values (and never call custom toJSON).
  const lTag = unknownTag(lEff)
  const rTag = unknownTag(rEff)
  if (lTag || rTag) {
    ctx.changes.push({
      category: 'unknown',
      path: [...path],
      side: lTag && rTag ? 'both' : lTag ? 'left' : 'right',
      tag: lTag ?? rTag!,
      message: `Custom tag ${lTag ?? rTag} cannot be safely interpreted`
    })
    return
  }

  // Cycle guard: if an alias resolves to a collection that is already on the
  // recursion stack (an ancestor), comparing it again would loop forever.
  const lCycle = isCollection(lEff) && ctx.left.active.has(lEff)
  const rCycle = isCollection(rEff) && ctx.right.active.has(rEff)
  if (lCycle || rCycle) return

  // Node type mismatch.
  if (nodeKind(lEff) !== nodeKind(rEff)) {
    ctx.changes.push({
      category: 'value',
      path: [...path],
      kind: 'type',
      left: nodeKind(lEff),
      right: nodeKind(rEff),
      message: `Node type differs: ${nodeKind(lEff)} vs ${nodeKind(rEff)}`
    })
    return
  }

  if (lEff instanceof Scalar) {
    compareScalars(lEff, rEff as Scalar, path, ctx)
  } else {
    const lColl = lEff as Collection
    const rColl = rEff as Collection
    ctx.left.active.add(lColl)
    ctx.right.active.add(rColl)
    try {
      if (lEff instanceof YAMLMap) compareMaps(lEff, rEff as YAMLMap, path, ctx)
      else if (lEff instanceof YAMLSeq) compareSeqs(lEff, rEff as YAMLSeq, path, ctx)
      else if (lEff instanceof YAMLSet) compareSets(lEff, rEff as YAMLSet, path, ctx)
    } finally {
      ctx.left.active.delete(lColl)
      ctx.right.active.delete(rColl)
    }
  }
}

function compareNullable(
  l: Node | Pair | null,
  r: Node | Pair | null,
  path: DiffPath,
  ctx: CompareContext
): void {
  if (l == null && r == null) return
  if (l == null || r == null) {
    ctx.changes.push({
      category: 'value',
      path: [...path],
      kind: 'missing',
      left: l,
      right: r,
      message: l == null ? 'Left value is null' : 'Right value is null'
    })
    return
  }
  if (l instanceof Pair && r instanceof Pair) {
    comparePair(l, r, path, ctx)
  } else if (l instanceof Pair || r instanceof Pair) {
    ctx.changes.push({
      category: 'value',
      path: [...path],
      kind: 'type',
      left: 'pair',
      right: 'node',
      message: 'Node type differs: pair vs node'
    })
  } else {
    compareNodes(l, r, path, ctx)
  }
}

/** Compare two key-value pairs (used for sequences of pairs, e.g. YAML 1.1 omap/pairs). */
function comparePair(l: Pair, r: Pair, path: DiffPath, ctx: CompareContext): void {
  if (!keyEqual(l.key, r.key)) {
    ctx.changes.push({
      category: 'value',
      path: [...path, 'key'],
      kind: 'scalar',
      left: keyValue(l.key),
      right: keyValue(r.key),
      message: `Pair key differs: ${fmtVal(keyValue(l.key))} -> ${fmtVal(keyValue(r.key))}`
    })
  }
  compareNullable(l.value, r.value, [...path, 'value'], ctx)
}

function compareScalars(l: Scalar, r: Scalar, path: DiffPath, ctx: CompareContext): void {
  if (!valueEqual(l.value, r.value)) {
    ctx.changes.push({
      category: 'value',
      path: [...path],
      kind: 'scalar',
      left: l.value,
      right: r.value,
      message: `Scalar value differs: ${fmtVal(l.value)} -> ${fmtVal(r.value)}`
    })
  }
  compareScalarStyle(l, r, path, ctx)
}

function compareScalarStyle(
  l: Scalar,
  r: Scalar,
  path: DiffPath,
  ctx: CompareContext
): void {
  const fields: StyleChange['fields'] = []
  if ((l.type ?? null) !== (r.type ?? null))
    fields.push({ field: 'type', left: l.type ?? null, right: r.type ?? null })
  if ((l.format ?? null) !== (r.format ?? null))
    fields.push({ field: 'format', left: l.format ?? null, right: r.format ?? null })
  if ((l.comment ?? null) !== (r.comment ?? null))
    fields.push({ field: 'comment', left: l.comment ?? null, right: r.comment ?? null })
  if ((l.commentBefore ?? null) !== (r.commentBefore ?? null))
    fields.push({
      field: 'commentBefore',
      left: l.commentBefore ?? null,
      right: r.commentBefore ?? null
    })
  if (!!l.spaceBefore !== !!r.spaceBefore)
    fields.push({ field: 'spaceBefore', left: !!l.spaceBefore, right: !!r.spaceBefore })
  if (fields.length) ctx.changes.push({ category: 'style', path: [...path], fields })
}

function compareCollectionStyle(
  l: Collection,
  r: Collection,
  path: DiffPath,
  ctx: CompareContext
): void {
  const fields: StyleChange['fields'] = []
  if (!!l.flow !== !!r.flow)
    fields.push({ field: 'flow', left: !!l.flow, right: !!r.flow })
  if ((l.comment ?? null) !== (r.comment ?? null))
    fields.push({ field: 'comment', left: l.comment ?? null, right: r.comment ?? null })
  if ((l.commentBefore ?? null) !== (r.commentBefore ?? null))
    fields.push({
      field: 'commentBefore',
      left: l.commentBefore ?? null,
      right: r.commentBefore ?? null
    })
  if (!!l.spaceBefore !== !!r.spaceBefore)
    fields.push({ field: 'spaceBefore', left: !!l.spaceBefore, right: !!r.spaceBefore })
  if (fields.length) ctx.changes.push({ category: 'style', path: [...path], fields })
}

function compareMaps(l: YAMLMap, r: YAMLMap, path: DiffPath, ctx: CompareContext): void {
  const lPairs = Array.from(l.values.values())
  const rPairs = Array.from(r.values.values())
  const rMatched = new Set<number>()

  for (const lp of lPairs) {
    let ri = -1
    for (let j = 0; j < rPairs.length; j++) {
      if (rMatched.has(j)) continue
      if (keyEqual(lp.key, rPairs[j].key)) {
        ri = j
        break
      }
    }
    const kp = keyPath(lp.key)
    if (ri === -1) {
      ctx.changes.push({
        category: 'value',
        path: [...path, kp],
        kind: 'key-removed',
        left: keyValue(lp.key),
        right: undefined,
        message: `Key ${fmtVal(keyValue(lp.key))} removed`
      })
    } else {
      rMatched.add(ri)
      compareNullable(lp.value, rPairs[ri].value, [...path, kp], ctx)
      compareNodeStyle(lp.key, rPairs[ri].key, [...path, kp], ctx)
    }
  }

  for (let j = 0; j < rPairs.length; j++) {
    if (rMatched.has(j)) continue
    const kp = keyPath(rPairs[j].key)
    ctx.changes.push({
      category: 'value',
      path: [...path, kp],
      kind: 'key-added',
      left: undefined,
      right: keyValue(rPairs[j].key),
      message: `Key ${fmtVal(keyValue(rPairs[j].key))} added`
    })
  }

  compareCollectionStyle(l, r, path, ctx)
}

function compareSeqs(l: YAMLSeq, r: YAMLSeq, path: DiffPath, ctx: CompareContext): void {
  const len = Math.max(l.length, r.length)
  for (let i = 0; i < len; i++) {
    if (i >= l.length) {
      ctx.changes.push({
        category: 'value',
        path: [...path, i],
        kind: 'element-added',
        left: undefined,
        right: r[i],
        message: `Element ${i} added`
      })
    } else if (i >= r.length) {
      ctx.changes.push({
        category: 'value',
        path: [...path, i],
        kind: 'element-removed',
        left: l[i],
        right: undefined,
        message: `Element ${i} removed`
      })
    } else {
      compareNullable(l[i], r[i], [...path, i], ctx)
    }
  }
  compareCollectionStyle(l, r, path, ctx)
}

function compareSets(l: YAMLSet, r: YAMLSet, path: DiffPath, ctx: CompareContext): void {
  const lItems = Array.from(l.values.values())
  const rItems = Array.from(r.values.values())
  const rMatched = new Set<number>()

  for (const li of lItems) {
    let ri = -1
    for (let j = 0; j < rItems.length; j++) {
      if (rMatched.has(j)) continue
      if (keyEqual(li, rItems[j])) {
        ri = j
        break
      }
    }
    const kp = keyPath(li)
    if (ri === -1) {
      ctx.changes.push({
        category: 'value',
        path: [...path, kp],
        kind: 'key-removed',
        left: li,
        right: undefined,
        message: 'Set element removed'
      })
    } else {
      rMatched.add(ri)
      compareNodeStyle(li, rItems[ri], [...path, kp], ctx)
    }
  }

  for (let j = 0; j < rItems.length; j++) {
    if (rMatched.has(j)) continue
    ctx.changes.push({
      category: 'value',
      path: [...path, keyPath(rItems[j])],
      kind: 'key-added',
      left: undefined,
      right: rItems[j],
      message: 'Set element added'
    })
  }

  compareCollectionStyle(l, r, path, ctx)
}

/** Compare the presentation of two nodes whose values are already known to be equal. */
function compareNodeStyle(l: Node, r: Node, path: DiffPath, ctx: CompareContext): void {
  if (l instanceof Scalar && r instanceof Scalar) {
    compareScalarStyle(l, r, path, ctx)
  } else if (isCollection(l) && isCollection(r)) {
    compareCollectionStyle(l, r, path, ctx)
  }
}

function refStatus(node: Node, eff: Node, state: SideState): RefStatus {
  if (node instanceof Alias) return { kind: 'alias', anchor: node.source }
  if (eff.anchor && state.anchors.has(eff.anchor) && state.referenced.has(eff.anchor))
    return { kind: 'target', anchor: eff.anchor }
  return { kind: 'copy' }
}

/** Resolve an alias to its anchored target using the preprocessed anchors map. */
function resolveAlias(alias: Alias, state: SideState): Node {
  const found = state.anchors.get(alias.source)
  return found?.node ?? alias
}

function unknownTag(node: Node): string | null {
  const tag = (node as { tag?: string }).tag
  if (!tag) return null
  if (CORE_TAGS.has(tag)) return null
  return tag
}

function nodeKind(node: Node): string {
  if (node instanceof Scalar) return 'scalar'
  if (node instanceof YAMLMap) return 'map'
  if (node instanceof YAMLSeq) return 'seq'
  if (node instanceof YAMLSet) return 'set'
  if (node instanceof Alias) return 'alias'
  return 'unknown'
}

function keyPath(key: Node): string | number {
  if (key instanceof Scalar) {
    const v = key.value
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'bigint')
      return v as string | number
    if (typeof v === 'boolean') return v ? 'true' : 'false'
    if (v === null) return 'null'
  }
  return '<?>'
}

function keyValue(key: Node): unknown {
  if (key instanceof Scalar) return key.value
  return key.toString()
}

function keyEqual(a: Node, b: Node): boolean {
  if (a instanceof Scalar && b instanceof Scalar) return valueEqual(a.value, b.value)
  return nodeDeepEqual(a, b, new Set(), new Set())
}

/** Structural equality for collection keys (rare), with a cycle guard. */
function nodeDeepEqual(
  a: Node | Pair,
  b: Node | Pair,
  seenA: Set<Node>,
  seenB: Set<Node>
): boolean {
  if (a instanceof Pair && b instanceof Pair) {
    if (!keyEqual(a.key, b.key)) return false
    if (a.value == null && b.value == null) return true
    if (a.value == null || b.value == null) return false
    return nodeDeepEqual(a.value, b.value, seenA, seenB)
  }
  if (a instanceof Alias || b instanceof Alias) {
    // Aliases as keys are not supported; fall back to identity.
    return a === b
  }
  if (a instanceof Scalar && b instanceof Scalar) return valueEqual(a.value, b.value)
  if (isCollection(a) && isCollection(b)) {
    if (seenA.has(a) || seenB.has(b)) return true
    seenA.add(a)
    seenB.add(b)
    if (a instanceof YAMLMap && b instanceof YAMLMap) {
      const ap = Array.from(a.values.values())
      const bp = Array.from(b.values.values())
      if (ap.length !== bp.length) return false
      return ap.every(
        (p, i) =>
          keyEqual(p.key, bp[i].key) &&
          nodeDeepEqual(p.value as Node, bp[i].value as Node, seenA, seenB)
      )
    }
    if (a instanceof YAMLSeq && b instanceof YAMLSeq) {
      if (a.length !== b.length) return false
      return a.every((item, i) => nodeDeepEqual(item, b[i], seenA, seenB))
    }
    if (a instanceof YAMLSet && b instanceof YAMLSet) {
      const ai = Array.from(a.values.values())
      const bi = Array.from(b.values.values())
      if (ai.length !== bi.length) return false
      return ai.every(item => bi.some(o => keyEqual(item, o)))
    }
  }
  return false
}

function valueEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (a == null || b == null) return a == null && b == null
  if (typeof a === 'number' && typeof b === 'number')
    return a === b || (Number.isNaN(a) && Number.isNaN(b))
  if (typeof a === 'bigint' && typeof b === 'bigint') return a === b
  if (a instanceof Uint8Array && b instanceof Uint8Array) {
    if (a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
    return true
  }
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime()
  return false
}

function fmtVal(v: unknown): string {
  if (v === undefined) return 'undef'
  if (typeof v === 'string') return JSON.stringify(v)
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint')
    return String(v)
  if (v === null) return 'null'
  if (v instanceof Uint8Array) return `Uint8Array(${v.length})`
  if (v instanceof Date) return v.toISOString()
  if (isNode(v)) return v.toString()
  try {
    return JSON.stringify(v)
  } catch {
    return '[unserializable]'
  }
}

/** Convert a change's left/right value into a JSON-serializable form. */
function serVal(v: unknown): unknown {
  if (v === undefined) return null
  if (isNode(v)) return v.toString()
  if (v instanceof Uint8Array) return `Uint8Array(${v.length})`
  if (v instanceof Date) return v.toISOString()
  return v
}
