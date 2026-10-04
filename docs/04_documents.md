# Documents

In order to work with YAML features not directly supported by native JavaScript data types, such as comments, anchors and aliases, `yaml` provides the `Document` API.

## Parsing Documents

```js
import fs from 'fs'
import { parseAllDocuments, parseDocument } from 'yaml'

const file = fs.readFileSync('./file.yml', 'utf8')
const doc = parseDocument(file)
doc.value

// Eliding the .range, .source, and .type attributes:
//
// YAMLMap {
//   values: Map(2) {
//     'YAML' => Pair {
//       key: Scalar { value: 'YAML' },
//       value: YAMLSeq(2) [
//         Scalar { value: 'A human-readable data serialization language' },
//         Scalar { value: 'https://en.wikipedia.org/wiki/YAML' }
//       ]
//     },
//     'yaml' => Pair {
//       key: Scalar { value: 'yaml' },
//       value: YAMLSeq(2) [
//         Scalar { value: 'A complete JavaScript implementation' },
//         Scalar { value: 'https://www.npmjs.com/package/yaml' }
//       ]
//     }
//   }
// }
```

These functions should not throw,
provided that `str` is a reasonable string and the `options` are valid.
Specially crafted inputs may still result in errors due to resource exhaustion,
such as stack overflows.
Errors and warnings are included in the documents' `errors` and `warnings` arrays.
In particular, if `errors` is not empty
it's likely that the document's parsed `value` are not entirely correct.

The `value` of a parsed document will always consist of `Scalar`, `Map`, or `Seq` values.

#### `parseDocument(str, options = {}): Document`

Parses a single `Document` from the input `str`; used internally by `parse`.
Will include an error if `str` contains more than one document.
See [Options](#options) for more information on the second parameter.

<br/>

#### `parseAllDocuments(str, options = {}): Document[]`

When parsing YAML, the input string `str` may consist of a stream of documents separated from each other by `...` document end marker lines.
`parseAllDocuments` will return an array of `Document` objects that allow these documents to be parsed and manipulated with more control.
See [Options](#options) for more information on the second parameter.

<br/>

## Creating Documents

#### `new Document(value, replacer?, options = {})`

Creates a new document.
The document `value` is initialised with `value`, wrapped recursively in appropriate [content nodes](#content-nodes).
If defined, a `replacer` may filter or modify the initial document value,
following the same algorithm as the [JSON implementation](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/JSON/stringify#The_replacer_parameter).
See [Options](#options) for more information on the last argument.

| Member        | Type                               | Description                                                                                                                                                         |
| ------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| commentBefore | `string?`                          | A comment at the very beginning of the document. If not empty, separated from the rest of the document by a blank line or the doc-start indicator when stringified. |
| comment       | `string?`                          | A comment at the end of the document. If not empty, separated from the rest of the document by a blank line when stringified.                                       |
| value         | [`Node`](#content-nodes) `⎮ any`   | The document value.                                                                                                                                                 |
| directives    | [`Directives`](#stream-directives) | Controls for the `%YAML` and `%TAG` directives, as well as the doc-start marker `---`.                                                                              |
| errors        | [`Error[]`](#errors)               | Errors encountered during parsing.                                                                                                                                  |
| schema        | `Schema`                           | The schema used with the document.                                                                                                                                  |
| warnings      | [`Error[]`](#errors)               | Warnings encountered during parsing.                                                                                                                                |

```js
import { Document } from 'yaml'

const doc = new Document(['some', 'values', { balloons: 99 }])
doc.commentBefore = ' A commented document'

String(doc)
// # A commented document
//
// - some
// - values
// - balloons: 99
```

The Document members are all modifiable, though it's unlikely that you'll have reason to change `errors`, `schema` or `warnings`.
In particular you may be interested in both reading and writing **`value`**,
which is expected to always contain a `YAMLMap`, `YAMLSeq`, or `Scalar` value.

## Document Methods

| Method                                     | Returns       | Description                                                                                                                               |
| ------------------------------------------ | ------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| clone()                                    | `Document`    | Create a deep copy of this Document and its value. Custom Node values that inherit from `Object` still refer to their original instances. |
| cloneSubtree(source,&nbsp;root,&nbsp;options?) | `Node`   | Deep-copy a subtree from `source` into this document, preserving internal anchors and aliases. See [Cloning Subtrees](#cloning-subtrees) for more information. |
| createAlias(node: Node, name?: string)     | `Alias`       | Create a new `Alias` node, adding the required anchor for `node`. If `name` is empty, a new anchor name will be generated.                |
| createNode(value,&nbsp;options?)           | `Node`        | Recursively wrap any input with appropriate `Node` containers. See [Creating Nodes](#creating-nodes) for more information.                |
| createPair(key,&nbsp;value,&nbsp;options?) | `Pair`        | Recursively wrap `key` and `value` into a `Pair` object. See [Creating Nodes](#creating-nodes) for more information.                      |
| createMergePair(value,&nbsp;options?)      | `Pair`        | Create a YAML 1.1 `<<` merge `Pair` object. See [Creating Nodes](#creating-nodes) for more information.                                   |
| get(key)                                   | `Node ⎮ Pair` | Returns top-level collection item at `key`, or `undefined` if not found.                                                                  |
| getPair(key)                               | `Pair`        | Returns top-level collection pair at `key`, or `undefined` if not found.                                                                  |
| set(key)                                   | `void`        | Sets a value in this document's top-level collection. For `!!set`, `value` is ignored.                                                    |
| setSchema(version,&nbsp;options?)          | `void`        | Change the YAML version and schema used by the document. `version` must be either `'1.1'` or `'1.2'`; accepts all Schema options.         |
| toJS(options?)                             | `any`         | A plain JavaScript representation of the document `value`.                                                                                |
| toJSON()                                   | `any`         | A JSON representation of the document `value`.                                                                                            |
| toString(options?)                         | `string`      | A YAML representation of the document.                                                                                                    |

```js
const doc = parseDocument('a: 1\nb: [2, 3]\n')
doc.get('a') // Scalar { value: 1 }
doc.getPair('a') // Pair { key: Scalar { value: 'a' }, value: Scalar { value: 1 } }
doc.get('b')[0] // Scalar { value: 2 }
doc.get('b').push(4) // 3
doc.get('b').splice(1, 1) // YAMLSeq(1) [ Scalar { value: 3 } ]
doc.get('b').at(1) // 4
```

In addition to the above, the document object also provides the following **accessor methods**:
`delete`, `get`, `has`, and `set`.

#### Cloning Subtrees

`doc.cloneSubtree(source, root, options?)` deep-copies a subtree from another document into `doc`, preserving the subtree's internal anchors and aliases. The copy is built in isolation and returned; the source document is never modified, and the target document is only modified (when `externalAlias: 'copy'`) after the entire clone succeeds.

- Internal anchors and aliases are copied together. If an anchor collides with one already present in the target document, it is renamed deterministically (using the `anchorPrefix`, default `'a'`), and aliases are remapped to point at the copied nodes.
- Aliases that reference anchors outside the subtree are handled according to the `externalAlias` option: `'reject'` (the default) throws a `ReferenceError` without modifying the target; `'copy'` also copies the referenced node into the target document's root collection so no dangling aliases remain.
- Circular references keep their graph identity: a node that refers to itself is copied once, with the alias pointing at the copy, without infinite expansion.

```js
import { parseDocument } from 'yaml'

const src = parseDocument('items: [&x 1, *x]\n')
const tgt = parseDocument('other: &x 3\n')

// Clone the `items` subtree from src into tgt. The &x anchor collides with
// tgt's existing &x, so it is renamed to &a1; the alias *x becomes *a1.
const items = src.get('items')
const clone = tgt.cloneSubtree(src, items)
tgt.set('copied', clone)

tgt.toString()
// other: &x 3
// copied: [ &a1 1, *a1 ]

// The alias still resolves to the copied node.
clone.at(1).resolve(tgt) === clone.at(0) // true
```

When a subtree contains an alias to an anchor outside the subtree, use `externalAlias: 'copy'` to bring the referenced node along:

```js
const src = parseDocument('a: &x 1\nb: *x\n')
const tgt = parseDocument('c: 2\n')

const clone = tgt.cloneSubtree(src, src.get('b'), { externalAlias: 'copy' })
tgt.set('d', clone)

tgt.toString()
// c: 2
// x: &x 1
// d: *x
```

#### `Document#toJS()`, `Document#toJSON()` and `Document#toString()`

```js
const src = '1969-07-21T02:56:15Z'
const doc = parseDocument(src, { customTags: ['timestamp'] })

doc.toJS()
// Date { 1969-07-21T02:56:15.000Z }

doc.toJSON()
// '1969-07-21T02:56:15.000Z'

String(doc)
// '1969-07-21T02:56:15\n'
```

For a plain JavaScript representation of the document, **`toJS(options = {})`** is your friend.
Its output may include `Map` and `Set` collections (e.g. if the `mapAsMap` option is true) and complex scalar values like `Date` for `!!timestamp`, but all YAML nodes will be resolved.
See [Options](#options) for more information on the optional parameter.

For a representation consisting only of JSON values, use **`toJSON()`**.

To stringify a document as YAML, use **`toString(options = {})`**.
This will also be called by `String(doc)` (with no options).
This method will throw if the `errors` array is not empty.
See [Options](#options) for more information on the optional parameter.

## Stream Directives

<!-- prettier-ignore -->
```js
const doc = new Document()
doc.directives
> {
    docStart: null, // set true to force the doc-start marker
    docEnd: false, // set true to force the doc-end marker
    tags: { '!!': 'tag:yaml.org,2002:' }, // Record<handle, prefix>
    yaml: { explicit: false, version: '1.2' }
  }
```

A YAML document may be preceded by `%YAML` and `%TAG` directives; their state is accessible via the `directives` member of a `Document`.
After parsing or other creation, the contents of `doc.directives` are mutable, and will influence the YAML string representation of the document.

The contents of `doc.directives.tags` are used both for the `%TAG` directives and when stringifying tags within the document.
Each of the handles must start and end with a `!` character; `!` is by default the local tag and `!!` is used for default tags.
See the section on [custom tags](#writing-custom-tags) for more on this topic.

`doc.directives.yaml` determines if an explicit `%YAML` directive should be included in the output, and what version it should use.
If changing the version after the document's creation, you'll probably want to use `doc.setSchema()` as it will also update the schema accordingly.
