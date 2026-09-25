import { trimLeadingArticle } from './indexHelpers';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GlossaryEntry {
  /** Plain-text sort key: first term only, HTML stripped, leading article trimmed, lowercased. */
  sortKey: string;
  /** Display term: first comma-separated value from the "Word(s)" cell, inner HTML preserved. */
  term: string;
  /** Full definition HTML, optionally suffixed with " [license; source]". */
  definition: string;
  /** href for linking the definition (from the "Link" cell), or null if absent. */
  link: string | null;
}

export interface GlossaryLetter {
  letter: string;
  entries: GlossaryEntry[];
}

export interface GlossaryData {
  byLetter: GlossaryLetter[];
}

// ---------------------------------------------------------------------------
// Regex patterns (dotall via [\s\S], mirroring legacy getTermCols)
// ---------------------------------------------------------------------------

const WORD_RE = /<td[^>]*?data-th="Word\(s\)"[^>]*?>([\s\S]*?)(?=<\/td>)/;
const DEFINITION_RE = /<td[^>]*?data-th="Definition"[^>]*?>([\s\S]*?)(?=<\/td>)/;
const LINK_RE = /<td[^>]*?data-th="Link"[^>]*?>([\s\S]*?)(?=<\/td>)/;
const SOURCE_RE = /<td[^>]*?data-th="Source"[^>]*?>([\s\S]*?)(?=<\/td>)/;
const LICENSE_RE = /<td[^>]*?data-th="Source License"[^>]*?>([\s\S]*?)(?=<\/td>)/;
const LINK_HREF_RE = /<a[^>]+href="([^"]+)"/;

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/**
 * Parses a CXOne glossary table from the rendered page body HTML.
 *
 * Extracts entries from rows with `data-th` column attributes matching the
 * standard LibreTexts glossary table format (Word(s), Definition, Link,
 * Source, Source License).  Only the first comma-separated term is used as
 * the display term, matching legacy buildBackMatter() behaviour.
 *
 * Returns `null` when no valid entries are found, signalling the caller
 * (PDFService.generateGlossary) to fall back to raw page rendering.
 */
export function parseGlossaryTable(bodyHTML: string): GlossaryEntry[] | null {
  if (!bodyHTML.trim()) return null;

  // Split on <tr to process one row at a time — avoids cross-row false matches.
  const rowFragments = bodyHTML.split('<tr');

  const entries: GlossaryEntry[] = [];

  for (const fragment of rowFragments) {
    const wordMatch = WORD_RE.exec(fragment);
    const defMatch = DEFINITION_RE.exec(fragment);
    if (!wordMatch || !defMatch) continue;

    const wordRaw = wordMatch[1].replace(/&nbsp;/g, ' ').trim();
    const defRaw = defMatch[1].replace(/&nbsp;/g, ' ').trim();

    // Take only the first comma-separated term (mirrors legacy split(',')[0])
    const firstTerm = wordRaw.split(',')[0].trim();
    const termText = stripHTMLTags(firstTerm).trim();
    if (!termText || !stripHTMLTags(defRaw).trim()) continue;

    // Build definition string, appending [license; source] if present
    let definition = defRaw.replace(/<p>/g, ' ').replace(/<\/p>/g, ' ').trim();
    const licenseMatch = LICENSE_RE.exec(fragment);
    const sourceMatch = SOURCE_RE.exec(fragment);
    const license = licenseMatch
      ? stripHTMLTags(licenseMatch[1])
          .replace(/&nbsp;/g, ' ')
          .replace(/\xa0/g, ' ')
          .replace(/<p>/g, ' ')
          .replace(/<\/p>/g, ' ')
          .trim()
      : '';
    const source = sourceMatch
      ? stripHTMLTags(sourceMatch[1])
          .replace(/&nbsp;/g, ' ')
          .replace(/\xa0/g, ' ')
          .replace(/<p>/g, ' ')
          .replace(/<\/p>/g, ' ')
          .trim()
      : '';

    const sourceParts = [license, source].filter(Boolean);
    if (sourceParts.length > 0) {
      definition = definition + ` [${sourceParts.map(escapeHTML).join('; ')}]`;
    }

    // Extract link href from the Link cell
    let link: string | null = null;
    const linkMatch = LINK_RE.exec(fragment);
    if (linkMatch) {
      const linkCell = linkMatch[1]
        .replace(/&nbsp;/g, ' ')
        .replace(/\xa0/g, ' ')
        .trim();
      if (linkCell) {
        const hrefMatch = LINK_HREF_RE.exec(linkCell);
        if (hrefMatch) {
          link =
            hrefMatch[1]
              .replace(/&nbsp;/g, '')
              .replace(/\xa0/g, '')
              .trim() || null;
        } else {
          // Fallback: use stripped cell text as URL
          const rawURL = stripHTMLTags(linkCell)
            .replace(/&nbsp;/g, '')
            .replace(/\xa0/g, '')
            .trim();
          link = rawURL || null;
        }
      }
    }

    const sortKey = glossarySortKey(termText);

    entries.push({
      sortKey,
      term: firstTerm, // preserve inner HTML (e.g. italic/bold markup in term)
      definition,
      link,
    });
  }

  return entries.length > 0 ? entries : null;
}

// ---------------------------------------------------------------------------
// Data building
// ---------------------------------------------------------------------------

// Group heading for entries that begin with a digit or symbol rather than a letter.
export const GLOSSARY_OTHER_GROUP = '#';

/**
 * Builds the sort key for a glossary term: HTML stripped, wrapping punctuation removed, leading
 * article trimmed, lowercased.
 */
export function glossarySortKey(term: string): string {
  const bare = stripHTMLTags(term)
    .replace(/&nbsp;/g, ' ')
    .replace(/\xa0/g, ' ')
    // Unicode and ASCII quotes, brackets, and dashes authors wrap terms in.
    .replace(/^[^\p{L}\p{N}]+/u, '')
    .trim()
    .toLowerCase();
  return trimLeadingArticle(bare);
}

/**
 * Sorts entries alphabetically and groups them by first letter A–Z. Entries starting with a digit
 * or symbol collect into a leading "#" group.
 */
export function buildGlossaryData(entries: GlossaryEntry[]): GlossaryData {
  const sorted = entries.slice().sort((a, b) => a.sortKey.localeCompare(b.sortKey));

  const groups = new Map<string, GlossaryEntry[]>();
  for (const entry of sorted) {
    const first = entry.sortKey.charAt(0).toUpperCase();
    const letter = /^[A-Z]$/.test(first) ? first : GLOSSARY_OTHER_GROUP;
    const group = groups.get(letter);
    if (group) {
      group.push(entry);
      continue;
    }
    groups.set(letter, [entry]);
  }

  const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
  const byLetter: GlossaryLetter[] = [GLOSSARY_OTHER_GROUP, ...ALPHABET]
    .filter((letter) => groups.has(letter))
    .map((letter) => ({ letter, entries: groups.get(letter)! }));

  return { byLetter };
}

// ---------------------------------------------------------------------------
// HTML generation
// ---------------------------------------------------------------------------

/**
 * Renders a GlossaryData structure to static HTML for Prince XML.
 *
 * Produces:
 *   1. A letter-jump navigation bar (A • B • C …)
 *   2. Letter-grouped entry sections, each with an anchor ID
 *   3. Under each letter: entries formatted as "Term | Definition"
 *
 * All user-supplied strings are HTML-escaped.
 * Returns a single empty-state message when the glossary has no entries.
 */
export function generateGlossaryHTML(data: GlossaryData): string {
  if (data.byLetter.length === 0) {
    return '<p class="libre-glossary-empty">No glossary terms found.</p>';
  }

  const letterGroups = data.byLetter
    .map((group) => {
      const entryItems = group.entries
        .map((entry) => {
          const definitionHTML = entry.link
            ? `<a href="${escapeAttr(entry.link)}" class="libre-glossary-definition-link">${entry.definition}</a>`
            : entry.definition;

          return `
        <div class="libre-glossary-entry">
          <span class="libre-glossary-term">${entry.term}</span><span class="libre-glossary-separator"> | </span><span class="libre-glossary-definition">${definitionHTML}</span>
        </div>`;
        })
        .join('');

      const anchor = group.letter === GLOSSARY_OTHER_GROUP ? 'other' : group.letter;
      return `
      <div class="libre-glossary-letter-group" id="libre-glossary-${anchor}">
        <h2 class="libre-glossary-letter">${group.letter}</h2>${entryItems}
      </div>`;
    })
    .join('');

  return `
    <div id="libre-glossary-table">
      ${letterGroups}
    </div>
  `;
}

// ---------------------------------------------------------------------------
// Internal utilities
// ---------------------------------------------------------------------------

function stripHTMLTags(html: string): string {
  return html.replace(/<[^>]+>/g, '');
}

export function escapeHTML(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function escapeAttr(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
