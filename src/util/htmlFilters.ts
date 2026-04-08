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
