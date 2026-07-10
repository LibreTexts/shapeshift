import * as cheerio from 'cheerio';
import { BookPageInfo } from '../types/book';

export function isCoverpage(pageInfo: BookPageInfo): boolean;
export function isCoverpage(tags: string[]): boolean;
export function isCoverpage(input: BookPageInfo | string[]) {
  const tags = Array.isArray(input) ? input : input.tags;
  return tags?.includes('coverpage:yes') || tags?.includes('coverpage:nocommons');
}

export async function generateSubpageListing(pageInfo: BookPageInfo, level = 2, isSubTOC?: boolean): Promise<string> {
  if (!pageInfo.subpages?.length) return '';
  let resolvedIsSubTOC = isSubTOC;
  const pages: BookPageInfo[] = [];
  for (const child of pageInfo.subpages) {
    if ((child.title === 'Front Matter' || child.title === 'Back Matter') && !child.subpages?.length) {
      // skip since empty
      continue;
    }
    if (child.title === 'Front Matter') {
      const tempChildren = child.subpages?.filter(
        (subpage) => !['TitlePage', 'InfoPage', 'Table of Contents'].includes(subpage.title),
      );
      pages.push(...(tempChildren ?? []));
    } else if (child.title === 'Back Matter') {
      pages.push(...(child.subpages ?? []));
    } else {
      pages.push(child);
    }
  }

  if (level === 2 && pageInfo.tags.includes('article:topic-guide')) {
    resolvedIsSubTOC = true;
    level = 3;
  }
  const twoColumn = pageInfo.tags?.includes('columns:two') && isCoverpage(pageInfo) && level === 2;
  const prefix = level === 2 ? 'h2' : 'span';
  // Get subtitles
  const innerRaw = await Promise.all(
    pages.map(async (elem) => {
      // if (elem.modified === 'restricted') return ''; // private page - FIXME
      const isSubtopic = level > 2 ? `indent${level - 2}` : null;
      const subPageDir = await generateSubpageListing(elem, level + 1, resolvedIsSubTOC);
      const subListSpacing = subPageDir?.length > 0 ? `libre-print-sublisting${level - 2}` : '';
      if (!elem.url || !elem.title) return '';
      return `<li><div class="nobreak ${isSubtopic} ${subListSpacing}"><${prefix}><a href="#page-${elem.pageID}" title="${elem.title}">${elem.title}</a></${prefix}></div>${subPageDir}</li>`;
    }),
  );
  const inner = innerRaw.join('');
  return `<ul class='libre-print-list' ${twoColumn ? 'style="column-count: 2;"' : ''}>${inner}</ul>`;
}

/**
 * Injects a generated subpage listing into a page's `.mt-guide-content` /
 * `.mt-category-container` element. Returns null when the page has
 * no such container or when the listing is empty.
 */
export function injectDirectoryListing({
  html,
  listing,
  tags,
  title,
}: {
  html: string;
  listing: string;
  tags: string[];
  title: string;
}): string | null {
  // Never replace a container with an empty listing
  if (!listing || !listing.trim()) return null;

  const $ = cheerio.load(html);

  const directory = $('.mt-guide-content, .mt-category-container');
  if (!directory.length) return null;

  // Create a new directory element with the listing HTML and replace the existing directory content
  const newDirectory = $('<div></div>');
  newDirectory.html(listing);
  newDirectory.addClass('libre-print-directory');
  directory.replaceWith(newDirectory);

  if (!tags?.length) return null;
  const pageType =
    isCoverpage(tags) || title?.includes('Table of Contents')
      ? 'Table of Contents' // server-side TOC generation (deprecated)
      : tags.includes('article:topic-guide')
        ? 'Chapter Overview'
        : 'Section Overview';

  const pageTitle = $('#title');

  const pageTitleParent = pageTitle?.parent();
  if (!pageTitle || !pageTitleParent) return null;
  pageTitle.attr('style', 'border-bottom: none !important');

  const newTitle = $('<h1></h1>')
    .text(pageType === 'Table of Contents' ? pageType : title)
    .attr('id', 'libre-print-directory-header');

  const typeContainer = $('<div></div>').attr('id', 'libre-print-directory-header-container');
  typeContainer.append(newTitle);
  pageTitle.before(typeContainer);
  pageTitle.remove();

  const textElems = $('p, span').toArray();
  for (const elem of textElems) {
    const e = $(elem);
    if (e.text()?.trim().toLowerCase().startsWith('thumbnail:')) {
      e.remove();
    }
  }

  // return the updated HTML
  return $.html();
}
