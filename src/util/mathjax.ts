/**
 * MathJax v4 integration for Node.js server-side rendering.
 *
 * This module initializes MathJax v4 with proper configuration for Node.js environments,
 * following the official documentation pattern at:
 * https://docs.mathjax.org/en/latest/server/components.html#node-components
 *
 * Key features:
 * - Lazy initialization with promise caching for expensive startup (~200-500ms)
 * - Uses liteDOM adaptor for lightweight DOM operations
 * - Promise-based APIs for async font/extension loading
 * - Proper cleanup via MathJax.done() to terminate worker threads
 */

import * as cheerio from 'cheerio';
import type { BookPageInfo } from '../types/book';

// ============================================================================
// Type Definitions for Better Type Inference
// ============================================================================

/**
 * MathJax configuration object structure
 */
//interface MathJaxConfig {
//  loader: {
//    paths: { mathjax: string };
//    load: string[];
//    require: (file: string) => Promise<unknown>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
//    [key: string]: any; // Allow extension-specific configs like '[tex]/mhchem'
//   };
//   options?: {
//     ignoreHtmlClass?: string;
//     processHtmlClass?: string;
//   };
//   output?: {
//     scale?: number;
//     mtextInheritFont?: boolean;
//     displayOverflow?: string;
//     linebreaks?: {
//       width?: string;
//     };
//   };
//   chtml?: {
//     matchFontHeight?: boolean;
//   };
//   tex?: {
//     tags?: string;
//     // eslint-disable-next-line @typescript-eslint/no-explicit-any
//     macros?: Record<string, any>;
//     packages?: {
//       '[+]'?: string[];
//     };
//   };
// }

/**
 * DOM adaptor interface for manipulating MathJax output
 */
interface DOMAdaptor {
  outerHTML(node: unknown): string;
  root(doc: unknown): unknown;
  tags(node: unknown, tag: string): unknown[];
  serializeXML(node: unknown): string;
}

/**
 * MathJax document object returned by getDocument()
 */
interface MathDocument {
  renderPromise(): Promise<void>;
  document: unknown;
}

/**
 * MathJax startup object with initialization promise and adaptor
 */
interface MathJaxStartup {
  adaptor: DOMAdaptor;
  promise: Promise<void>;
  getDocument(html: string): MathDocument;
}

/**
 * Global MathJax object available after initialization
 */
interface MathJaxGlobal {
  startup: MathJaxStartup;
  tex2chtmlPromise(math: string): Promise<unknown>;
  tex2svgPromise(math: string): Promise<unknown>;
  done(): void;
  // Internal API for customization (type-unsafe)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  _?: any;
}

/**
 * Extend global namespace to include MathJax
 */
declare global {
  // eslint-disable-next-line no-var
  var MathJax: MathJaxGlobal;
}

// ============================================================================
// Initialization Logic
// ============================================================================

/**
 * Lazy-initialized MathJax instance — expensive to init (~200-500ms), cached thereafter.
 * We store the promise (not the result) so concurrent callers share the same init.
 */
let initPromise: Promise<MathJaxGlobal> | null = null;

/**
 * Current page number prefix for equation numbering (e.g., "4.2.").
 * This variable is read by MathJax's tagformat.number function to prefix equation numbers.
 * Updated before each page render via extractPageNumberPrefix().
 */
let currentPageNumberPrefix = '';

/**
 * Initializes MathJax v4 with proper configuration for Node.js environments.
 *
 * Configuration follows the official v4 pattern:
 * 1. Set global.MathJax BEFORE importing any components
 * 2. Configure loader with liteDOM adaptor for Node.js
 * 3. Use promise-based require for async loading
 * 4. Import tex-mml-svg component (or individual components)
 * 5. Wait for startup.promise to complete
 *
 * @returns Promise that resolves to the initialized MathJax global object
 */
async function initMathJax(): Promise<MathJaxGlobal> {
  // Configure MathJax BEFORE importing components (required by v4)
  // We configure it as a partial object that will be populated by the component
  global.MathJax = {
    loader: {
      paths: {
        mathjax: '@mathjax/src/bundle',
      },
      load: ['adaptors/liteDOM'],
      require: (file: string) => import(file),
      // Extension-specific configuration for mhchem chemistry notation
      '[tex]/mhchem': {
        ready() {
          // Customize mhchem arrow characters for better rendering
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const { MapHandler } = (MathJax as any)._.input.tex.MapHandler;
          const mhchem = MapHandler.getMap('mhchem-chars');
          mhchem.lookup('mhchemrightarrow')._char = '\uE42D';
          mhchem.lookup('mhchemleftarrow')._char = '\uE42C';
        },
      },
    },
    options: {
      ignoreHtmlClass: 'tex2jax_ignore',
      processHtmlClass: 'tex2jax_process',
    },
    output: {
      scale: 0.85,
      mtextInheritFont: false,
      displayOverflow: 'linebreak',
      linebreaks: {
        width: '100%',
      },
    },
    chtml: {
      matchFontHeight: true,
    },
    tex: {
      tags: 'all',
      tagformat: {
        // Prefix equation numbers with current page number (e.g., "4.2.1", "4.2.2", etc.)
        // The currentPageNumberPrefix variable is set before each render
        number: (n: number) => currentPageNumberPrefix + n,
      },
      macros: {
        eatSpaces: ['#1', 2, ['', ' ', '\\endSpaces']],
        // PageIndex macro - placeholder that will be updated dynamically per page
        PageIndex: ['{#1}', 1], // Default: just output the argument
        mhchemrightleftharpoons: '{\\unicode{x21CC}\\,}',
        xrightleftharpoons: ['\\mhchemxrightleftharpoons[#1]{#2}', 2, ''],
      },
      packages: {
        '[+]': ['mhchem', 'color', 'cancel', 'ams', 'tagformat'],
      },
    },
  } as unknown as MathJaxGlobal;

  // Load the tex-mml-svg combined component
  await import('@mathjax/src/bundle/tex-mml-svg.js');

  // Wait for MathJax to complete initialization
  await MathJax.startup.promise;

  return MathJax;
}

/**
 * Gets or initializes the MathJax instance.
 * Uses promise caching to ensure only one initialization occurs even with concurrent calls.
 *
 * @returns Promise that resolves to the MathJax global object
 */
function getOrInitMathJax(): Promise<MathJaxGlobal> {
  if (!initPromise) {
    initPromise = initMathJax();
  }
  return initPromise;
}

// ============================================================================
// Process Cleanup
// ============================================================================

/**
 * Clean up MathJax worker threads when process exits.
 *
 * In MathJax v4, speech generation uses worker-threads that must be explicitly
 * shut down to allow the Node process to exit gracefully.
 */
process.on('exit', () => {
  if (global.MathJax) {
    MathJax.done();
  }
});

// ============================================================================
// Page Number Prefix Extraction
// ============================================================================

/**
 * Extracts the page number prefix from a page title for equation numbering.
 * Replicates the browser-side logic that computes the "front" value from window.PageName.
 *
 * Browser-side logic:
 * 1. If PageName contains ":", take the part before the first ":"
 * 2. If that part contains ".", split by ".", parse each numeric part to remove leading zeros, rejoin
 * 3. Append "." to the end
 * 4. Otherwise, return empty string
 *
 * Examples:
 * - "4.2.1: Some Section" → "4.2.1."
 * - "3: Introduction" → "3."
 * - "01.02: Chapter" → "1.2." (leading zeros removed)
 * - "No Colon Here" → ""
 *
 * @param title - The page title to extract numbering from
 * @returns The page number prefix with trailing period, or empty string if no prefix
 */
export function extractPageNumberPrefix(title: string): string {
  if (!title) return '';

  const trimmed = title.trim();

  // Check if title contains a colon (standard format: "1.2.3: Title")
  if (trimmed.includes(':')) {
    let front = trimmed.split(':')[0].trim();

    // If the prefix contains dots, normalize by removing leading zeros from numeric parts
    // This matches browser-side logic: int.includes("0")?parseInt(int,10):int
    if (front.includes('.')) {
      front = front
        .split('.')
        .map((part) => {
          // If the part contains '0', parse as integer to remove leading zeros
          return part.includes('0') ? String(parseInt(part, 10)) : part;
        })
        .join('.');
    }

    // Append period to the end
    return front + '.';
  }

  // No colon found, no prefix
  return '';
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Pre-renders all TeX math in an HTML string to CHTML using MathJax v4.
 *
 * This function finds and processes all math delimiters in the HTML string,
 * replacing them with `<mjx-container>` elements containing rendered CommonHTML output.
 *
 * Uses the document-level API which handles:
 * - Finding math delimiters ($...$, $$...$$, \(...\), \[...\])
 * - Processing TeX macros and extensions
 * - Async loading of fonts and data as needed
 * - Maintaining document structure with proper accessibility markup
 *
 * If pageInfo is provided, extracts the page number prefix from the title and configures
 * equation numbering accordingly (e.g., equations in section 4.2 are numbered 4.2.1, 4.2.2, etc.).
 *
 * @param html - HTML string containing TeX math to render
 * @param pageInfo - Optional page metadata containing title for equation numbering
 * @returns Promise resolving to HTML with rendered math, or original HTML on error (graceful degradation)
 */
export async function prerenderMath(html: string, pageInfo?: BookPageInfo): Promise<string> {
  try {
    const mj = await getOrInitMathJax();
    const adaptor = mj.startup.adaptor;

    // Extract page number prefix from title and configure equation numbering
    let prefix = '';
    if (pageInfo?.title) {
      prefix = extractPageNumberPrefix(pageInfo.title);
      currentPageNumberPrefix = prefix;
    } else {
      // No page info provided, use default sequential numbering
      currentPageNumberPrefix = '';
    }

    // Preprocess HTML to expand PageIndex macros before MathJax processing
    // This is more reliable than trying to update macros dynamically in MathJax
    // Replace \PageIndex{n} with the expanded value (e.g., "4.2.n")
    let preprocessedHTML = html;
    if (prefix) {
      // Match \PageIndex{...} patterns and replace with prefix + content
      // Need to handle both inline and display math contexts
      preprocessedHTML = html.replace(/\\PageIndex\{([^}]+)\}/g, (match, content) => {
        // Wrap dots in braces for proper TeX rendering: "4.2." → "{4}{.}{2}{.}"
        const prefixWithBraces = prefix.replace(/\./g, '{.}');
        // Use eatSpaces macro to handle spacing
        return `{${prefixWithBraces}\\eatSpaces${content} \\endSpaces}`;
      });
    }

    // Use MathJax's document API to find and render all math in the HTML
    // getDocument is dynamically added by MathJax during initialization
    const doc = mj.startup.getDocument(preprocessedHTML);

    // renderPromise handles async font loading in v4's split font architecture
    await doc.renderPromise();

    // Get the fully rendered HTML document
    const result = adaptor.outerHTML(adaptor.root(doc.document));

    // Clear the document to free resources and prevent state pollution
    // This helps avoid "Can't find handler for document" errors on subsequent renders
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (doc as any).clear();
    } catch {
      // clear() might not exist or might fail, that's okay
    }

    // MathJax wraps the input in a full HTML document. Extract just the body content
    // since the caller provides (and expects back) a body fragment.
    const bodyMatch = result.match(/<body>([\s\S]*)<\/body>/);
    return bodyMatch ? bodyMatch[1] : result;
  } catch (err) {
    // Graceful degradation: return original HTML with raw LaTeX
    // This is better than failing completely - raw math is still readable
    console.error('MathJax rendering error:', err);
    return html;
  }
}

/**
 * Removes MathJax `<script>` tags from head HTML to prevent double-processing.
 * After server-side pre-rendering, CMS-provided MathJax scripts are unnecessary
 * and could conflict with the already-rendered SVG output.
 */
export function stripMathJaxScripts(headHTML: string): string {
  if (!headHTML) return headHTML;

  const $ = cheerio.load(headHTML, null, false);
  // Remove <script> tags that load MathJax or configure it
  $('script').each(function () {
    const src = $(this).attr('src') || '';
    const content = $(this).html() || '';
    if (/mathjax/i.test(src) || /MathJax/i.test(content)) {
      $(this).remove();
    }
  });

  return $.html();
}
