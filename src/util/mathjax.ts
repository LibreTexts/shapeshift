import * as cheerio from 'cheerio';

// Lazy-loaded MathJax instance — expensive to initialize (~200-500ms), cached thereafter.
// We store the promise (not the result) so concurrent callers share the same init.
let initPromise: Promise<MathJaxInstance> | null = null;

interface MathJaxInstance {
  startup: {
    adaptor: {
      outerHTML(node: unknown): string;
      root(doc: unknown): unknown;
    };
    getDocument(html: string): {
      renderPromise(): Promise<unknown>;
      document: unknown;
    };
  };
}

async function initMathJax(): Promise<MathJaxInstance> {
  // Dynamic import to avoid loading MathJax at module evaluation time
  const MathJax = (await import('@mathjax/src')).default;

  return MathJax.init({
    loader: { load: ['input/tex', 'output/svg'] },
    tex: {
      packages: ['base', 'ams', 'newcommand', 'noundefined'],
      inlineMath: [['\\(', '\\)']],
      displayMath: [
        ['$$', '$$'],
        ['\\[', '\\]'],
      ],
    },
    svg: { fontCache: 'global' },
  }) as Promise<MathJaxInstance>;
}

function getOrInitMathJax(): Promise<MathJaxInstance> {
  if (!initPromise) initPromise = initMathJax();
  return initPromise;
}

/**
 * Pre-renders all TeX math in an HTML string to inline SVG using MathJax v4.
 * Returns the HTML with math replaced by `<mjx-container>` elements containing SVG.
 * On error, returns the original HTML unchanged (raw LaTeX is better than a failed page).
 */
export async function prerenderMath(html: string): Promise<string> {
  try {
    const mj = await getOrInitMathJax();
    const adaptor = mj.startup.adaptor;

    const doc = mj.startup.getDocument(html);
    await doc.renderPromise();

    const result = adaptor.outerHTML(adaptor.root(doc.document));

    // MathJax wraps the input in a full HTML document. Extract just the body content
    // since the caller provides (and expects back) a body fragment.
    const bodyMatch = result.match(/<body>([\s\S]*)<\/body>/);
    return bodyMatch ? bodyMatch[1] : result;
  } catch {
    // Graceful degradation: return original HTML with raw LaTeX
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
