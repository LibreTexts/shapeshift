import * as cheerio from 'cheerio';

/**
 * Patterns matched against <script src="..."> attributes and inline script content.
 * Scripts matching any of these strings will be removed before HTML is passed to
 * PrinceXML, preventing unnecessary analytics/tracking network requests during conversion.
 */
export const SCRIPT_BLOCKLIST: string[] = [
  'google-analytics.com',
  'googletagmanager.com',
  'analytics.js',
  'gtag/js',
  'traffic.libretexts.org',
];

/**
 * Removes <script> tags whose src attribute or inline content matches any entry
 * in SCRIPT_BLOCKLIST. Safe to call on head or tail HTML fragments.
 */
export function stripBlocklistedScripts(html: string): string {
  if (!html) return html;

  const $ = cheerio.load(html, null, false);
  $('script').each(function () {
    const src = $(this).attr('src') || '';
    const content = $(this).html() || '';
    const combined = src + content;
    if (SCRIPT_BLOCKLIST.some((pattern) => combined.includes(pattern))) {
      $(this).remove();
    }
  });

  return $.html();
}

/** Elements that make a paragraph "non-empty" even when it has no visible text. */
const MEANINGFUL_CHILD_TAGS = new Set(['img', 'svg', 'math', 'mjx-container', 'input', 'select', 'textarea', 'video']);

/**
 * Removes empty paragraph elements that contain no meaningful content — only whitespace,
 * nbsp, or line break tags. Paragraphs that contain images, math, or other meaningful
 * child elements are preserved.
 */
export function removeEmptyParagraphs(html: string): string {
  if (!html) return html;

  const $ = cheerio.load(html, null, false);
  $('p').each((_, el) => {
    const $el = $(el);
    const hasMeaningfulChild = $el
      .find('*')
      .toArray()
      .some((child) => MEANINGFUL_CHILD_TAGS.has((child as any).tagName));
    if (hasMeaningfulChild) return;

    const text = $el
      .text()
      .replace(/\u00a0/g, '')
      .trim();
    if (text === '') {
      $el.remove();
    }
  });

  return $.html();
}

const DECORATIVE_HEADING_BOX_CLASSES = new Set([
  'box-definition',
  'box-emphasis',
  'box-example',
  'box-exercise',
  'box-interactive',
  'box-note',
  'box-objectives',
  'box-query',
  'box-structure',
  'box-theorem',
  'box-warning',
]);

/**
 * Converts heading elements (h1–h6) inside component containers (box-note,
 * box-example, etc.) to <p class="box-heading"> elements.
 */
export function demoteDecorativeHeadings($: cheerio.CheerioAPI): void;
export function demoteDecorativeHeadings(html: string): string;
export function demoteDecorativeHeadings(input: string | cheerio.CheerioAPI): string | void {
  const isString = typeof input === 'string';
  if (isString && !input) return input;

  const $ = isString ? cheerio.load(input, null, false) : input;

  $('h1, h2, h3, h4, h5, h6').each((_, el) => {
    const $el = $(el);
    const isInsideBox = $el
      .parents()
      .toArray()
      .some((parent) => {
        const classes = $(parent).attr('class')?.split(/\s+/) ?? [];
        return classes.some((c) => DECORATIVE_HEADING_BOX_CLASSES.has(c));
      });

    if (!isInsideBox) return;

    const $replacement = $('<p></p>');
    const attribs = (el as any).attribs ?? {};
    for (const [key, val] of Object.entries(attribs)) {
      $replacement.attr(key, val as string);
    }
    $replacement.addClass('box-heading');
    $replacement.html($el.html()!);
    $el.replaceWith($replacement);
  });

  if (isString) return $.html();
}

/** Line count is clamped to this range; the CXOne template offers 1-12, with headroom. */
const FIXED_SPACE_MIN_LINES = 1;
const FIXED_SPACE_MAX_LINES = 20;

/** Vertical space, in em, that one requested blank line occupies in the export. */
const FIXED_SPACE_EM_PER_LINE = 1.5;

/**
 * Marker class emitted by `Template:FixedSpace/Activity`. `lt-` rather than `mt-` because this is a
 * LibreTexts convention, not native MindTouch markup. Safe alongside the `lt-<subdomain>-<pageID>`
 * transclusion classes read in book.ts, whose pattern requires a trailing numeric segment.
 */
const FIXED_SPACE_SELECTOR = 'div.lt-fixed-space';

/**
 * Replaces `Template:FixedSpace/Activity` output with a single decorative spacer.
 *
 * The template wraps its `<p>&nbsp;</p>` runs in `<div class="lt-fixed-space">` so the live library
 * page keeps rendering unchanged while exports get a machine-readable marker. Here the whole wrapper
 * collapses to one empty block sized to N * 1.5em, hidden from assistive tech: the gap is visual
 * padding and announcing it, or leaving N empty paragraphs in the structure tree, only adds noise.
 *
 * The line count comes from an explicit `data-fixed-space-lines` attribute when the template
 * supplies one, and otherwise from counting the wrapped paragraphs — the wrapper already holds
 * exactly one per requested line, so the attribute is optional.
 *
 * Height is inlined rather than driven by a CSS lookup table so any line count works and so EPUB
 * readers that never see `.fixed-space` still honor the box. The spacer holds a zero-width space so
 * it never serializes as `<div/>` in the EPUB's XML-mode pass (`epub.ts`), which readers that fall
 * back to an HTML parser would read as an opening tag and swallow the rest of the document with.
 *
 * Must run before removeEmptyParagraphs, which would otherwise delete the wrapper's contents.
 *
 * Not implemented: treating any run of 2+ consecutive empty `<p>` as intentional spacing, which
 * would cover libraries whose template has not been updated yet. Page content arrives from CXOne in
 * `mode=view` with DekiScript fully expanded, so authored spacing is indistinguishable from stray
 * empty paragraphs, and false positives would inject gaps into ordinary prose. If we ever want it,
 * the hook is a pre-pass in removeEmptyParagraphs that groups adjacent empty siblings before
 * deleting them.
 */
export function collapseFixedSpace(html: string): string {
  if (!html) return html;

  const $ = cheerio.load(html, null, false);
  $(FIXED_SPACE_SELECTOR).each((_, el) => {
    const $el = $(el);

    const declared = parseInt($el.attr('data-fixed-space-lines') ?? '', 10);
    const counted = $el.children('p').length;
    const requested = Number.isFinite(declared) ? declared : counted;
    const lines = Math.min(Math.max(requested || FIXED_SPACE_MIN_LINES, FIXED_SPACE_MIN_LINES), FIXED_SPACE_MAX_LINES);

    const $spacer = $('<div></div>')
      .addClass('fixed-space')
      .attr('role', 'presentation')
      .attr('aria-hidden', 'true')
      .attr('data-fixed-space-lines', String(lines))
      .attr('style', `height: ${lines * FIXED_SPACE_EM_PER_LINE}em`)
      .text('\u200b');

    $el.replaceWith($spacer);
  });

  return $.html();
}
