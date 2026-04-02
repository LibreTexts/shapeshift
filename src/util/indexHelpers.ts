import { BookPageInfo } from '../types/book';

/**
 * Case-insensitive substrings that disqualify a tag from appearing in the index.
 * Mirrors the legacy `indexExclusions` array in DynamicIndex.old.js.
 *
 * "@" removes lulu@ print tags and other system tags.
 * "-" removes article:topic-guide, article:topic-category, printoptions:*, etc.
 * "lulu" is belt-and-suspenders for lulu print tags.
 * "source" removes source-material provenance tags.
 */
const INDEX_TAG_EXCLUSIONS = ['source', 'lulu', '@', '-'] as const;

/**
 * Leading articles stripped from term names before sorting so that e.g.
 * "The Cell Membrane" sorts under C, not T.
 * Checked longest-first so "the " is not shadowed by "a ".
 */
const LEADING_ARTICLES = ['the ', 'an ', 'a '] as const;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface IndexPage {
  pageName: string;
  pageLink: string;
}

export interface IndexTerm {
  /** Display name after leading-article trimming */
  name: string;
  pages: IndexPage[];
}

export interface IndexLetter {
  letter: string;
  terms: IndexTerm[];
}

export interface IndexData {
  byLetter: IndexLetter[];
}

// ---------------------------------------------------------------------------
// Pure helper functions
// ---------------------------------------------------------------------------

/**
 * Returns true when a tag qualifies as a human-readable index term.
 * Applies the same case-insensitive substring exclusions as the legacy code.
 */
export function isIndexTag(tag: string): boolean {
  if (!tag.trim()) return false;
  const lower = tag.toLowerCase();
  return !INDEX_TAG_EXCLUSIONS.some((excl) => lower.includes(excl));
}

/**
 * Strips a leading article ("a ", "an ", "the ") from a term name so the term
 * sorts by its principal word.  The comparison is case-insensitive but the
 * original casing of the remainder is preserved.
 *
 * Fixes a bug in the legacy trimTermTag() which called
 * `name.replace(articleString.length, "")` — passing a number as the first
 * argument to String.prototype.replace() coerces it to a string and tries to
 * replace that literal digit sequence, so it silently did nothing.
 */
export function trimLeadingArticle(name: string): string {
  const lower = name.toLowerCase();
  for (const article of LEADING_ARTICLES) {
    if (lower.startsWith(article)) {
      return name.slice(article.length);
    }
  }
  return name;
}

// ---------------------------------------------------------------------------
// Index building
// ---------------------------------------------------------------------------

/**
 * Builds an alphabetised IndexData structure from the flat page list.
 *
 * Only content pages contribute — front/back matter infrastructure pages
 * (identified by `matterType` or container titles) are excluded because they
 * carry system/metadata tags rather than human-assigned index terms.
 *
 * Tag filtering mirrors the legacy DynamicIndex exclusion logic.
 * Pages within each term are sorted alphabetically by title.
 */
export function buildTagIndex(pages: BookPageInfo[]): IndexData {
  const termMap = new Map<string, IndexPage[]>();

  for (const page of pages) {
    // Skip front/back matter infrastructure pages
    if (page.matterType === 'Front' || page.matterType === 'Back') continue;
    // Skip container pages whose title is literally "Front Matter" / "Back Matter"
    if (['Front Matter', 'Back Matter'].some((t) => page.title.includes(t))) continue;

    for (const tag of page.tags) {
      if (!isIndexTag(tag)) continue;

      const displayName = trimLeadingArticle(tag);
      if (!termMap.has(displayName)) {
        termMap.set(displayName, []);
      }
      termMap.get(displayName)!.push({ pageName: page.title, pageLink: page.url });
    }
  }

  // Sort pages within each term alphabetically
  const sortedTerms: IndexTerm[] = Array.from(termMap.entries())
    .map(([name, termPages]) => ({
      name,
      pages: termPages.slice().sort((a, b) => a.pageName.localeCompare(b.pageName)),
    }))
    .sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));

  // Group by first letter A–Z; terms starting with non-letter characters are
  // skipped, matching the legacy behaviour.
  const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
  const byLetter: IndexLetter[] = [];

  // Advance past any leading non-letter terms
  let termPos = 0;
  while (termPos < sortedTerms.length && !/^[A-Z]/i.test(sortedTerms[termPos].name.charAt(0))) {
    termPos++;
  }

  for (const letter of ALPHABET) {
    const terms: IndexTerm[] = [];
    while (termPos < sortedTerms.length && sortedTerms[termPos].name.toUpperCase().startsWith(letter)) {
      terms.push(sortedTerms[termPos]);
      termPos++;
    }
    if (terms.length > 0) {
      byLetter.push({ letter, terms });
    }
  }

  return { byLetter };
}

// ---------------------------------------------------------------------------
// HTML generation
// ---------------------------------------------------------------------------

/**
 * Renders an IndexData structure to static HTML for Prince XML.
 * Produces:
 *   1. A letter-jump navigation bar (A • B • C …)
 *   2. Letter-grouped term sections, each with anchor IDs
 *   3. Under each term: its display name and a list of linked pages
 *
 * All user-supplied strings are HTML-escaped.
 * Returns a single empty-state message when the index has no terms.
 */
export function generateIndexHTML(data: IndexData): string {
  if (data.byLetter.length === 0) {
    return '<p class="libre-index-empty">No index terms found.</p>';
  }

  const navLinks = data.byLetter
    .map((g, i) => `${i > 0 ? ' &bull; ' : ''}<a href="#libre-index-${g.letter}">${g.letter}</a>`)
    .join('');

  const letterGroups = data.byLetter
    .map((group) => {
      const terms = group.terms
        .map((term) => {
          const pageLinks = term.pages
            .map(
              (p) => `<a href="${escapeAttr(p.pageLink)}" class="libre-index-page-link">${escapeHTML(p.pageName)}</a>`,
            )
            .join('<br/>');
          return `
        <div class="libre-index-term">
          <p class="libre-index-term-name">${escapeHTML(term.name)}</p>
          <div class="libre-index-term-pages">${pageLinks}</div>
        </div>`;
        })
        .join('');

      return `
      <div class="libre-index-letter-group" id="libre-index-${group.letter}">
        <h2 class="libre-index-letter">${group.letter}</h2>${terms}
      </div>`;
    })
    .join('');

  return `<nav id="libre-index-nav">${navLinks}</nav>
    <div id="libre-index-table">${letterGroups}
    </div>`;
}

// ---------------------------------------------------------------------------
// Internal utilities
// ---------------------------------------------------------------------------

function escapeHTML(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Escape a value destined for an HTML attribute (href). */
function escapeAttr(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
