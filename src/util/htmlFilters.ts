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
