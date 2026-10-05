# Parse & Stringify

```yaml
# file.yml
YAML:
  - A human-readable data serialization language
  - https://en.wikipedia.org/wiki/YAML
yaml:
  - A complete JavaScript implementation
  - https://www.npmjs.com/package/yaml
```

At its simplest, you can use `YAML.parse(str)` and `YAML.stringify(value)` just as you'd use `JSON.parse(str)` and `JSON.stringify(value)`. If that's enough for you, everything else in these docs is really just implementation details.

## YAML.parse

```js
import fs from 'fs'
import YAML from 'yaml'

YAML.parse('3.14159')
// 3.14159

YAML.parse('[ true, false, maybe, null ]\n')
// [ true, false, 'maybe', null ]

const file = fs.readFileSync('./file.yml', 'utf8')
YAML.parse(file)
// { YAML:
//   [ 'A human-readable data serialization language',
//     'https://en.wikipedia.org/wiki/YAML' ],
//   yaml:
//   [ 'A complete JavaScript implementation',
//     'https://www.npmjs.com/package/yaml' ] }
```

#### `YAML.parse(str, reviver?, options = {}): any`

`str` should be a string with YAML formatting.
If defined, the `reviver` function follows the [JSON implementation][JSON reviver],
including support for the callback's `context` argument.
See [Options](#options) for more information on the last argument,
an optional configuration object.

[JSON reviver]: https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/JSON/parse#Using_the_reviver_parameter

The returned value will match the type of the root value of the parsed YAML document,
so maps become objects, sequences arrays,
and untagged scalars result in nulls, booleans, numbers and strings.

`YAML.parse` will throw on error, and it may log warnings using `console.warn`.
It only supports input consisting of a single YAML document;
for multi-document support you should use [`YAML.parseAllDocuments`](#parsing-documents).

## YAML.stringify

```js
YAML.stringify(3.14159)
// '3.14159\n'

YAML.stringify([true, false, 'maybe', null])
// `- true
// - false
// - maybe
// - null
// `

YAML.stringify({ number: 3, plain: 'string', block: 'two\nlines\n' })
// `number: 3
// plain: string
// block: >
//   two
//
//   lines
// `
```

#### `YAML.stringify(value, replacer?, options = {}): string`

`value` can be of any type.
The returned string will always include `\n` as the last character,
as is expected of YAML documents.
If defined, the `replacer` array or function follows the [JSON implementation][JSON replacer].
See [Options](#options) for more information on the last argument,
an optional configuration object.
For JSON compatibility,
using a number or a string as the `options` value will set the `indent` option accordingly.
The serialization of [raw JSON] values is supported.

[JSON replacer]: https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/JSON/stringify#The_replacer_parameter
[raw JSON]: https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/JSON/rawJSON

As strings in particular may be represented in a number of different styles, the simplest option for the value in question will always be chosen, depending mostly on the presence of escaped or control characters and leading & trailing whitespace.

To create a stream of documents, you may call `YAML.stringify` separately for each document's `value`, and concatenate the documents with the string `...\n` as a separator.

## Coordinating tag handles across documents

When stringifying multiple documents together as a stream, each document's `%TAG` directives are independent. If two documents bind the same handle (e.g. `!app!`) to different URIs, the output is still valid YAML, but the handle is ambiguous across the group.

The **`DocumentGroup`** class provides an explicit coordination plan for multiple documents:

```js
import { Document, DocumentGroup } from 'yaml'

const doc1 = parseDocument('%TAG !app! tag:example.com,2024:app\n---\n!app!foo hello\n')
const doc2 = parseDocument('%TAG !app! tag:example.org,2024:app\n---\n!app!bar world\n')

const group = new DocumentGroup([doc1, doc2])
group.toString()
// '%TAG !app! tag:example.com,2024:app\n---\n!app!foo hello\n...\n%TAG !app2! tag:example.org,2024:app\n---\n!app2!bar world\n'
```

When a handle is bound to different URIs in different documents, the coordinator deterministically assigns new handles: the first document keeps the original handle, and subsequent documents receive `!app2!`, `!app3!`, etc. The nodes' real tag URIs are never modified; only the handle mapping used during stringification changes.

The handle-to-handle mapping is queryable per document:

```js
group.getHandleMapping(0) // {}
group.getHandleMapping(1) // { '!app!': '!app2!' }
```

The standard `!!` handle is never re-bound. If any document binds `!!` to a non-default URI, the coordinator throws an error without modifying the source documents. Aliases and comment positions are preserved, and unmentioned directives keep their original order.
