import { Alias } from '../nodes/Alias.ts'
import { Pair } from '../nodes/Pair.ts'
import { Scalar } from '../nodes/Scalar.ts'
import type { Node } from '../nodes/types.ts'
import { YAMLMap } from '../nodes/YAMLMap.ts'
import { YAMLSeq } from '../nodes/YAMLSeq.ts'
import { YAMLSet } from '../nodes/YAMLSet.ts'
import { visit } from '../visit.ts'
import { anchorNames, findNewAnchor } from './anchors.ts'
import type { Document } from './Document.ts'

/**
 * Options for {@link Document.cloneSubtree}.
 */
export interface CloneSubtreeOptions {
  /**
   * How to handle aliases that reference anchors outside the subtree.
   *
   * - `'reject'` (the default): throw a `ReferenceError` without modifying
   *   the target document at all.
   * - `'copy'`: also copy the referenced node (and its subtree) into the
   *   target document, so no dangling aliases remain. The copied nodes are
   *   attached to the target document's root collection.
   *
   * Default: `'reject'`
   */
  externalAlias?: 'reject' | 'copy'

  /**
   * Prefix used when renaming anchors that collide with the target
   * document's existing anchors. A numeric suffix is appended to make the
   * name unique.
   *
   * Default: `'a'`
   */
  anchorPrefix?: string
}

interface CloneContext {
  target: Document
  toCopy: Set<Node>
  anchorList: Node[]
  anchorMap: Map<Node, string>
  memo: Map<Node, Node>
}

/**
 * Deep-copy a subtree from `source` into `target`, preserving internal
 * anchors and aliases.
 *
 * This is the implementation backing {@link Document.cloneSubtree}. The copy
 * is built in isolation; the target document is only modified (in `'copy'`
 * mode) after the entire clone succeeds. The source document is never
 * modified.
 */
export function cloneSubtree(
  target: Document,
  source: Document,
  root: Node,
  options: CloneSubtreeOptions = {}
): Node {
  const { externalAlias = 'reject', anchorPrefix = 'a' } = options

  // All anchored nodes and aliases in the source, in document order, used to
  // resolve aliases to their targets.
  const anchorList = buildAnchorList(source)

  // The set of nodes structurally contained in the subtree (root +
  // descendants), not following aliases.
  const subtree = collectSubtree(root)

  // Discover every node that needs to be copied: the subtree itself plus, in
  // 'copy' mode, the targets of aliases that point outside the subtree (and
  // their subtrees, recursively).
  const toCopy = new Set<Node>(subtree)
  const externalTargets: Node[] = []
  let changed = true
  while (changed) {
    changed = false
    for (const node of toCopy) {
      if (node instanceof Alias) {
        const resolved = resolveAlias(node, anchorList)
        if (resolved && !toCopy.has(resolved)) {
          if (externalAlias === 'reject') {
            throw new ReferenceError(
              `Alias references anchor "${node.source}" outside the subtree; ` +
                `set externalAlias: 'copy' to copy the referenced node along`
            )
          }
          externalTargets.push(resolved)
          for (const n of collectSubtree(resolved)) {
            if (!toCopy.has(n)) {
              toCopy.add(n)
              changed = true
            }
          }
        }
      }
    }
  }

  // Assign a (possibly renamed) anchor to every anchored node being copied.
  const anchorMap = assignAnchors(toCopy, target, anchorPrefix)

  // Copy the subtree with memoization, so circular references keep their
  // graph identity instead of expanding infinitely.
  const ctx: CloneContext = {
    target,
    toCopy,
    anchorList,
    anchorMap,
    memo: new Map()
  }
  const copy = copyNode(root, ctx)

  // In 'copy' mode, attach the external targets to the target document's
  // root so the aliases resolve. This only runs after the whole clone has
  // succeeded, keeping the operation atomic.
  if (externalAlias === 'copy') {
    for (const ext of externalTargets) attachToRoot(target, copyNode(ext, ctx))
  }

  return copy
}

/** All anchored nodes and aliases in `doc`, in document order. */
function buildAnchorList(doc: Document): Node[] {
  const nodes: Node[] = []
  visit(doc, {
    Node(_key, node) {
      if (node instanceof Alias || node.anchor) nodes.push(node)
    }
  })
  return nodes
}

/**
 * Resolve `alias` to its target within the source document, finding the last
 * anchored node before the alias with a matching anchor name. Returns
 * `undefined` if the alias cannot be resolved.
 */
function resolveAlias(alias: Alias, anchorList: Node[]): Node | undefined {
  let found: Node | undefined
  for (const node of anchorList) {
    if (node === alias) break
    if (node.anchor === alias.source) found = node
  }
  return found
}

/**
 * Collect the subtree rooted at `node`: the node itself plus all of its
 * structural descendants. Aliases are treated as leaves; their targets are
 * not followed here.
 */
function collectSubtree(node: Node): Set<Node> {
  const set = new Set<Node>()
  const walk = (n: Node): void => {
    if (set.has(n)) return
    set.add(n)
    if (n instanceof Alias) return
    if (n instanceof YAMLMap) {
      for (const pair of n.values.values()) {
        walk(pair.key)
        if (pair.value) walk(pair.value)
      }
    } else if (n instanceof YAMLSeq) {
      for (const item of n) {
        if (item instanceof Pair) {
          walk(item.key)
          if (item.value) walk(item.value)
        } else {
          walk(item)
        }
      }
    } else if (n instanceof YAMLSet) {
      for (const item of n.values.values()) walk(item)
    } else if (n instanceof Pair) {
      walk(n.key)
      if (n.value) walk(n.value)
    }
  }
  walk(node)
  return set
}

/**
 * Assign a new anchor name to every anchored node in `toCopy`, renaming
 * deterministically whenever the original name collides with an anchor
 * already present in the target document (or with a name assigned earlier).
 */
function assignAnchors(
  toCopy: Set<Node>,
  target: Document,
  anchorPrefix: string
): Map<Node, string> {
  const assigned = new Set<string>(anchorNames(target))
  const anchorMap = new Map<Node, string>()
  for (const node of toCopy) {
    if (node.anchor) {
      const oldName = node.anchor
      const newName =
        oldName && !assigned.has(oldName)
          ? oldName
          : findNewAnchor(anchorPrefix, assigned)
      assigned.add(newName)
      anchorMap.set(node, newName)
    }
  }
  return anchorMap
}

/**
 * Deep-copy `node`, using `ctx.memo` to ensure each source node is copied at
 * most once (preserving graph identity for circular references).
 */
function copyNode(node: Node, ctx: CloneContext): Node {
  const cached = ctx.memo.get(node)
  if (cached) return cached

  let copy: Node
  if (node instanceof Alias) {
    copy = node.clone()
  } else if (node instanceof Scalar) {
    copy = node.clone()
  } else if (node instanceof YAMLMap) {
    copy = new YAMLMap(ctx.target.schema)
  } else if (node instanceof YAMLSeq) {
    copy = new YAMLSeq(ctx.target.schema)
  } else if (node instanceof YAMLSet) {
    copy = new YAMLSet(ctx.target.schema)
  } else {
    // istanbul ignore next
    throw new Error(`Unsupported node type: ${String(node)}`)
  }

  // Set the anchor before copying children, so self-referential aliases can
  // point at this copy.
  if (ctx.anchorMap.has(node)) copy.anchor = ctx.anchorMap.get(node)

  ctx.memo.set(node, copy)

  if (node instanceof Alias) {
    const resolved = resolveAlias(node, ctx.anchorList)
    if (resolved && ctx.toCopy.has(resolved)) {
      const copiedTarget = copyNode(resolved, ctx)
      ;(copy as Alias).source =
        ctx.anchorMap.get(resolved) ?? copiedTarget.anchor ?? ''
    } else {
      throw new ReferenceError(
        `Unresolved alias (the anchor must be set before the alias): ${node.source}`
      )
    }
  } else if (node instanceof YAMLMap) {
    for (const [key, pair] of node.values) {
      ;(copy as YAMLMap).values.set(key, copyPair(pair, ctx))
    }
  } else if (node instanceof YAMLSeq) {
    for (const item of node) {
      if (item instanceof Pair) (copy as YAMLSeq).push(copyPair(item, ctx))
      else (copy as YAMLSeq).push(copyNode(item, ctx))
    }
  } else if (node instanceof YAMLSet) {
    for (const item of node.values.values()) {
      ;(copy as YAMLSet).add(copyNode(item, ctx))
    }
  }

  copyProperties(node, copy)

  // Re-apply the (possibly renamed) anchor after copying properties, so a
  // stale original anchor name never leaks through.
  if (ctx.anchorMap.has(node)) copy.anchor = ctx.anchorMap.get(node)

  return copy
}

/** Copy a {@link Pair}, remapping its key and value through the cloner. */
function copyPair(pair: Pair, ctx: CloneContext): Pair {
  const key = copyNode(pair.key, ctx)
  const value = pair.value ? copyNode(pair.value, ctx) : null
  const copy = new Pair(key, value)
  for (const [name, prop] of Object.entries(
    Object.getOwnPropertyDescriptors(pair)
  )) {
    if (name === 'key' || name === 'value') continue
    if (!(name in copy)) Object.defineProperty(copy, name, prop)
  }
  return copy
}

/**
 * Copy the user-facing properties (comments, tags, styles, ranges, etc.)
 * from `src` to `dst`, skipping structural properties that are owned by the
 * copy. The `range` tuple is copied by value so the copy does not share the
 * source's array.
 */
function copyProperties(src: Node, dst: Node): void {
  for (const [name, prop] of Object.entries(
    Object.getOwnPropertyDescriptors(src)
  )) {
    if (name === 'values' || name === 'schema' || name === 'anchor') continue
    if (name === 'range') {
      if (src.range) dst.range = [...src.range]
      continue
    }
    if (!(name in dst)) Object.defineProperty(dst, name, prop)
  }
}

/** Attach `node` to the root collection of `doc`. */
function attachToRoot(doc: Document, node: Node): void {
  if (doc.value instanceof YAMLMap) {
    doc.value.set(anchorKey(doc, node), node)
  } else if (doc.value instanceof YAMLSeq) {
    doc.value.push(node)
  } else if (doc.value instanceof YAMLSet) {
    doc.value.add(node)
  } else {
    throw new Error('Cannot attach external target to a scalar document root')
  }
}

/** A unique map key for an external target, based on its anchor name. */
function anchorKey(doc: Document, node: Node): string {
  const base = node.anchor ?? 'a'
  if (!(doc.value instanceof YAMLMap)) return base
  let key = base
  let i = 1
  while (doc.value.has(key)) key = `${base}${i++}`
  return key
}