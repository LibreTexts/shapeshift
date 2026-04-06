# MathJax v4 in Node.js — Agent Reference

## Package

```
@mathjax/src@4
```

Bundle directory: `@mathjax/src/bundle` (replaces `es5` from v3)

---

## Critical Setup Rules

1. Set `global.MathJax` **before** importing any component
2. Always use promise-based APIs (v4 fonts load asynchronously)
3. Call `MathJax.done()` when finished — it terminates worker threads that otherwise prevent Node from exiting

---

## Minimal Configuration (ESM)

```js
global.MathJax = {
  loader: {
    paths: { mathjax: '@mathjax/src/bundle' },
    load: ['adaptors/liteDOM'],
    require: (file) => import(file)
  }
};

await import('@mathjax/src/bundle/tex-svg.js');  // or tex-chtml.js, tex-mml-svg.js, etc.
await MathJax.startup.promise;

// ... use MathJax ...

MathJax.done();
```

## Minimal Configuration (CJS)

```js
MathJax = {
  loader: {
    paths: { mathjax: '@mathjax/src/bundle' },
    load: ['adaptors/liteDOM'],
    require: require
  }
};

require('@mathjax/src/bundle/tex-chtml.js');
MathJax.startup.promise
  .then(() => { /* use MathJax */ })
  .catch((err) => console.error(err.message))
  .then(() => MathJax.done());
```

---

## Combined Components (drop-in loads)

| File | Input → Output |
|------|---------------|
| `tex-svg.js` | TeX → SVG |
| `tex-chtml.js` | TeX → CommonHTML |
| `tex-mml-svg.js` | TeX + MathML → SVG |

Load via: `await import('@mathjax/src/bundle/<component>.js')`

---

## Individual Components (lean server builds)

Use `startup.js` instead of a combined component to exclude menu/assistive tools:

```js
global.MathJax = {
  loader: {
    paths: { mathjax: '@mathjax/src/bundle' },
    load: ['input/tex', 'output/svg', 'adaptors/liteDOM'],
    require: (file) => import(file)
  },
  output: { font: 'mathjax-newcm' }  // required when using output/svg alone
};

await import('@mathjax/src/bundle/startup.js');
await MathJax.startup.promise;
```

Available input components: `input/tex`, `input/mathml`, `input/asciimath`  
Available output components: `output/svg`, `output/chtml`  
DOM adaptor: `adaptors/liteDOM` (lightweight, sufficient for server use)

---

## Converting Math (Promise API — always prefer in v4)

### Single expression → SVG string

```js
const EM = 16;
const EX = 8;
const WIDTH = 80 * EM;

async function typeset(math, display = true) {
  const node = await MathJax.tex2svgPromise(math, {
    display,
    em: EM,
    ex: EX,
    containerWidth: WIDTH
  });
  const adaptor = MathJax.startup.adaptor;
  return adaptor.serializeXML(adaptor.tags(node, 'svg')[0]);
}

const svg = await typeset('\\sqrt{1+x^2}');
```

### Other conversion promise methods

```js
MathJax.tex2svgPromise(math, options)    // TeX → SVG node
MathJax.tex2chtmlPromise(math, options)  // TeX → CHTML node
```

### Document-level API (full HTML with multiple expressions)

```js
const doc = MathJax.startup.getDocument(htmlString);
await doc.renderPromise();
const result = adaptor.outerHTML(adaptor.root(doc.document));
// result is a full HTML document — extract body content if needed
const bodyMatch = result.match(/<body>([\s\S]*)<\/body>/);
```

---

## Adaptor API

```js
const adaptor = MathJax.startup.adaptor;

adaptor.outerHTML(node)           // serialize node to HTML string
adaptor.serializeXML(node)        // serialize node to XML string (use for SVG)
adaptor.root(doc)                 // get root node of a document
adaptor.tags(node, 'svg')         // get all elements by tag name → array
```

---

## Full Configuration Object Reference

```js
global.MathJax = {
  loader: {
    paths: { mathjax: '@mathjax/src/bundle' },
    load: ['adaptors/liteDOM'],          // components to load
    require: (file) => import(file),     // ESM loader; use `require` for CJS
    source: source                       // optional: load from source files
  },
  options: {
    ignoreHtmlClass: 'tex2jax_ignore',
    processHtmlClass: 'tex2jax_process',
    // The settings below are for assistive features that don't translate to PDF's. We disable them to avoid unnecessary overhead and potential issues with worker threads in Node.
    enableSpeech: false,
    enableBraille: false,
    enableExplorer: false,
    enableAssistiveMml: false
  },
  output: {
    font: 'mathjax-newcm',               // required for standalone output/svg component
    scale: 0.85,
    mtextInheritFont: false,
    displayOverflow: 'linebreak',
    linebreaks: {
      width: '100%',
      inline: false
    }
  },
  tex: {
    tags: 'all',                         // equation numbering: 'none' | 'ams' | 'all'
    tagformat: {
      number: (n) => String(n)           // customize equation number format
    },
    macros: {
      myMacro: ['#1', 1]                 // custom TeX macros
    },
    packages: {
      '[+]': ['mhchem', 'color', 'cancel', 'ams', 'tagformat']
    }
  }
};
```

---

## Loading from Source (for dev/testing without repacking)

```js
import { source } from '@mathjax/src/components/js/source.js';

global.MathJax = {
  loader: {
    paths: { mathjax: '@mathjax/src/bundle' },
    load: ['adaptors/liteDOM'],
    require: (file) => import(file),
    source: source
  }
};

await import(source['tex-chtml']);
await MathJax.startup.promise;
MathJax.done();
```

---

## Gotchas

- **Worker threads**: v4 runs speech (SRE) and Braille label generation in worker threads. If speech/Braille labels are not needed, set `enableSpeech: false` and `enableBraille: false` to prevent thread startup. Always call `MathJax.done()` to clean up.
- **Stack overflows**: Deep math trees + SRE can cause `RangeError: Maximum call stack`. Disable assistive MML if rendering large documents server-side.
- **Font loading**: v4 splits fonts into chunks loaded on demand — always use promise-based methods (`tex2svgPromise`, `renderPromise`) even for simple expressions.
- **Document cleanup**: Call `doc.clear()` after `renderPromise()` to free resources and avoid "Can't find handler for document" errors on subsequent renders.
- **HTML wrapping**: `getDocument()` wraps input in a full HTML document. Extract body: `result.match(/<body>([\s\S]*)<\/body>/)[1]`.
- **Config must precede import**: Setting `global.MathJax` after importing a component has no effect.
