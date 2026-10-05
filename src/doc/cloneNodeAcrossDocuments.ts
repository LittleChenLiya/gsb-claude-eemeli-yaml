import { Alias } from '../nodes/Alias.ts'
import { isNode } from '../nodes/identity.ts'
import { Pair } from '../nodes/Pair.ts'
import type { Node } from '../nodes/types.ts'
import { YAMLMap } from '../nodes/YAMLMap.ts'
import { YAMLSeq } from '../nodes/YAMLSeq.ts'
import { YAMLSet } from '../nodes/YAMLSet.ts'
import type { Schema } from '../schema/Schema.ts'
import { anchorNames, findNewAnchor } from './anchors.ts'
import type { Document } from './Document.ts'

export interface CloneNodeAcrossDocumentsOptions {
  /**
   * How to handle aliases in the cloned subtree that refer to anchors defined
   * outside of it:
   *
   * - `'error'` (default): Throw an error. Neither document is modified.
   * - `'copy'`: Copy the referenced node along with the subtree. The first
   *   alias to each external anchor (in document order) is replaced by the
   *   copied node, and any later aliases to the same anchor are updated to
   *   refer to the copy, so no dangling references are left behind.
   */
  externalAliases?: 'error' | 'copy'
}

/**
 * Deep-clone `node`, a subtree of the `source` document, so that the clone
 * may be added to `target`, a different document.
 *
 * Anchors and aliases within the subtree are cloned along with it. If an
 * anchor name is already in use in `target`, the cloned anchor is
 * deterministically renamed (`x` -> `x1`, `x2`, ...) and all aliases within
 * the cloned subtree are updated to match. Aliases that refer to anchors
 * outside the subtree are handled according to `options.externalAliases`.
 *
 * Cyclic and shared node references are preserved as-is: the clone keeps
 * the graph identity of the original subtree rather than expanding it.
 * Comments, tags, anchors and other node properties are preserved.
 *
 * Neither `source` nor `target` is modified by this function, so the
 * target document can only gain the new node after the complete clone has
 * succeeded. If cloning fails (e.g. on a rejected external alias), both
 * documents are left exactly as they were.
 *
 * @example
 * ```js
 * import { cloneNodeAcrossDocuments, parseDocument } from 'yaml'
 *
 * const src = parseDocument('item:\n  def: &x [1, 2]\n  ref: *x\n')
 * const tgt = parseDocument('mine: &x old\n')
 *
 * const cloned = cloneNodeAcrossDocuments(tgt, src, src.get('item'))
 * tgt.set('imported', cloned) // only runs if the clone fully succeeded
 *
 * String(tgt)
 * // 'mine: &x old\nimported:\n  def: &x1 [ 1, 2 ]\n  ref: *x1\n'
 * ```
 */
export function cloneNodeAcrossDocuments<N extends Node>(
  target: Document,
  source: Document,
  node: N,
  options?: CloneNodeAcrossDocumentsOptions
): N {
  if (!isNode(node)) {
    throw new TypeError('The cloned subtree root must be a YAML node')
  }
  const externalMode = options?.externalAliases ?? 'error'

  // Phase 1: Collect all nodes of the cloned subtree(s), resolving each
  // alias to its target node. External references may add further roots
  // whose subtrees are cloned along. Traversal uses an explicit visited
  // set, so cyclic graphs terminate.
  const visited = new Set<Node>()
  const anchored: Node[] = [] // anchored nodes, in document order
  const aliasTarget = new Map<Alias, Node>() // resolved target of each alias
  const inlineOf = new Map<Alias, Node>() // alias replaced by its external target
  const inlineAt = new Map<Node, Alias>() // external node -> alias it replaces
  const roots: Node[] = [node]

  const walkPair = (pair: Pair, anchors: Map<string, Node>): void => {
    if (isNode(pair.key)) walk(pair.key, anchors)
    if (isNode(pair.value)) walk(pair.value, anchors)
  }

  const walk = (n: Node, anchors: Map<string, Node>): void => {
    if (visited.has(n)) return
    visited.add(n)
    if (n instanceof Alias) {
      let t = anchors.get(n.source)
      if (!t) {
        // The alias refers to an anchor outside the cloned subtree.
        t = n.resolve(source)
        if (!t) {
          const msg = `Unresolved alias (the anchor must be set before the alias): ${n.source}`
          throw new ReferenceError(msg)
        }
        if (externalMode === 'error') {
          const msg = `Alias *${n.source} refers to an anchor outside the cloned subtree`
          throw new Error(msg)
        }
        if (!visited.has(t)) {
          // Genuinely external node: copy it along, inlined at the first
          // alias that refers to it.
          if (!inlineAt.has(t)) {
            inlineAt.set(t, n)
            inlineOf.set(n, t)
          }
          if (!roots.includes(t)) roots.push(t)
        }
      }
      aliasTarget.set(n, t)
      return
    }
    if (n.anchor) {
      anchored.push(n)
      anchors.set(n.anchor, n)
    }
    if (n instanceof YAMLSeq) {
      for (const it of n) {
        if (it instanceof Pair) walkPair(it, anchors)
        else if (isNode(it)) walk(it, anchors)
      }
    } else if (n instanceof YAMLMap || n instanceof YAMLSet) {
      for (const v of n.values.values()) {
        if (v instanceof Pair) walkPair(v, anchors)
        else if (isNode(v)) walk(v, anchors)
      }
    }
  }
  for (let i = 0; i < roots.length; ++i) walk(roots[i], new Map())

  // Phase 2: Assign anchor names for the clones, deterministically
  // renaming any that collide with anchors already used in `target`.
  const taken = anchorNames(target)
  const rename = new Map<Node, string>()
  for (const n of anchored) {
    const prev = n.anchor as string
    const name = taken.has(prev) ? findNewAnchor(prev, taken) : prev
    taken.add(name)
    rename.set(n, name)
  }

  // Phase 3: Clone, memoizing each node so that shared and cyclic
  // references keep their graph identity.
  const memo = new Map<Node, Node>()

  const copyOwnProps = (
    src: object,
    dst: object,
    skip: (key: string) => boolean
  ): void => {
    for (const [key, desc] of Object.entries(
      Object.getOwnPropertyDescriptors(src)
    )) {
      if (!skip(key)) Object.defineProperty(dst, key, desc)
    }
  }

  const cloneValue = (value: unknown): unknown => {
    if (value instanceof Pair) return clonePair(value)
    if (isNode(value)) return cloneNode(value)
    return value
  }

  const clonePair = (pair: Pair): Pair => {
    const copy: Pair = Object.create(Object.getPrototypeOf(pair))
    copyOwnProps(pair, copy, key => key === 'key' || key === 'value')
    copy.key = cloneValue(pair.key) as Pair['key']
    copy.value = cloneValue(pair.value) as Pair['value']
    return copy
  }

  // Own property keys of collections that must not be copied as-is:
  // `schema` & `values` are set by the constructor / filled with clones,
  // `length` and array indices are filled by pushing cloned items.
  const collSkip = (key: string): boolean =>
    key === 'schema' ||
    key === 'values' ||
    key === 'length' ||
    String(Number(key)) === key

  const cloneNode = (n: Node): Node => {
    const prev = memo.get(n)
    if (prev) return prev
    let copy: Node
    if (n instanceof Alias) {
      const inline = inlineOf.get(n)
      if (inline) return cloneNode(inline)
      const c = n.clone()
      memo.set(n, c)
      const t = aliasTarget.get(n)
      if (t) c.source = rename.get(t) ?? (t.anchor as string)
      copy = c
    } else if (n instanceof YAMLSeq) {
      const c = new (n.constructor as new (schema: Schema) => YAMLSeq)(n.schema)
      memo.set(n, c)
      copyOwnProps(n, c, collSkip)
      if (n.range) c.range = [...n.range]
      for (const it of n) c.push(cloneValue(it) as never)
      copy = c
    } else if (n instanceof YAMLMap || n instanceof YAMLSet) {
      const c = new (
        n.constructor as new (schema: Schema) => YAMLMap | YAMLSet
      )(n.schema)
      memo.set(n, c)
      copyOwnProps(n, c, collSkip)
      if (n.range) c.range = [...n.range]
      for (const [k, v] of n.values) c.values.set(k, cloneValue(v) as never)
      copy = c
    } else {
      copy = n.clone()
      memo.set(n, copy)
    }
    const name = rename.get(n)
    if (name !== undefined) copy.anchor = name
    return copy
  }

  return cloneNode(node) as N
}
