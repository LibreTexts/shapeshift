import { BookPageInfo } from '../types/book';
import { ImageConstants } from './imageConstants';
import { LicenseInfo } from '../types/licensing';

/**
 * Builds an HTML string with the specified Creative Commons license's icon(s).
 * @param {string[]} clauses - Array of clause identifiers, starting with 'cc'.
 * @returns {string} HTML string with license's icon(s) as image/svg.
 */
export function ccIconsSVGs(clauses: string[]): string {
  if (Array.isArray(clauses) && clauses.length > 0) {
    let iconString = '';
    clauses.forEach((item) => {
      iconString = `${iconString}<img src="data:image/svg+xml;base64,${ImageConstants.cc[`${item}-clause` as keyof typeof ImageConstants.cc]}"/>`;
    });
    return iconString;
  }
  return '';
}

const LICENSE_DISPLAY_TITLES: Record<string, string> = {
  arr: 'All Rights Reserved',
  ccby: 'CC BY',
  ccbync: 'CC BY-NC',
  ccbyncnd: 'CC BY-NC-ND',
  ccbyncsa: 'CC BY-NC-SA',
  ccbynd: 'CC BY-ND',
  ccbysa: 'CC BY-SA',
  ck12: 'CK-12',
  gnu: 'GPL',
  gnudsl: 'GNU DSL',
  gnufdl: 'GNU FDL',
  gnugpl: 'GNU GPL',
  multiple: 'Multiple Licenses',
  publicdomain: 'Public Domain',
};

export function getLicenseDisplayTitle(license: LicenseInfo | null): string {
  if (!license) return '';
  const title = LICENSE_DISPLAY_TITLES[license.raw] ?? license.raw;
  return license.version ? `${title} ${license.version}` : title;
}

export function getLicense(pageTags: string[]): LicenseInfo | null {
  if (!pageTags?.length) return null;

  const { license, licenseVersion } = pageTags.reduce(
    (acc, curr) => {
      if (curr.includes('license')) {
        const tagRaw = curr.split(':');
        if (Array.isArray(tagRaw) && tagRaw.length > 1) {
          const [tagName, tagVal] = tagRaw;
          if (tagName === 'license') {
            acc.license = tagVal;
          } else if (tagName === 'licenseversion' && tagVal.length === 2) {
            acc.licenseVersion = `${tagVal.slice(0, 1)}.${tagVal.slice(1)}`; // raw version has no separator
          }
        }
      }
      return acc;
    },
    { license: '', licenseVersion: '4.0' },
  );
  if (!license) return null;

  switch (license) {
    case 'publicdomain':
      return {
        label: ccIconsSVGs(['pd']),
        link: 'https://en.wikipedia.org/wiki/Public_domain',
        raw: 'publicdomain',
      };
    case 'ccby':
      return {
        label: ccIconsSVGs(['cc', 'by']),
        link: `https://creativecommons.org/licenses/by/${licenseVersion}/`,
        version: licenseVersion,
        raw: 'ccby',
      };
    case 'ccbysa':
      return {
        label: ccIconsSVGs(['cc', 'by', 'sa']),
        link: `https://creativecommons.org/licenses/by-sa/${licenseVersion}/`,
        version: licenseVersion,
        raw: 'ccbysa',
      };
    case 'ccbyncsa':
      return {
        label: ccIconsSVGs(['cc', 'by', 'nc', 'sa']),
        link: `https://creativecommons.org/licenses/by-nc-sa/${licenseVersion}/`,
        version: licenseVersion,
        raw: 'ccbyncsa',
      };
    case 'ccbync':
      return {
        label: ccIconsSVGs(['cc', 'by', 'nc']),
        link: `https://creativecommons.org/licenses/by-nc/${licenseVersion}/`,
        version: licenseVersion,
        raw: 'ccbync',
      };
    case 'ccbynd':
      return {
        label: ccIconsSVGs(['cc', 'by', 'nd']),
        link: `https://creativecommons.org/licenses/by-nd/${licenseVersion}/`,
        version: licenseVersion,
        raw: 'ccbynd',
      };
    case 'ccbyncnd':
      return {
        label: ccIconsSVGs(['cc', 'by', 'nc', 'nd']),
        link: `https://creativecommons.org/licenses/by-nc-nd/${licenseVersion}/`,
        version: licenseVersion,
        raw: 'ccbyncnd',
      };
    case 'gnu':
      return {
        label: 'GPL',
        link: 'https://www.gnu.org/licenses/gpl-3.0.en.html',
        raw: 'gnu',
      };
    case 'gnudsl':
      return {
        label: 'GNU Design Science License',
        link: 'https://www.gnu.org/licenses/dsl.html',
        raw: 'gnudsl',
      };
    case 'gnufdl':
      return {
        label: 'GNU Free Documentation License',
        link: 'https://www.gnu.org/licenses/fdl-1.3.en.html',
        raw: 'gnufdl',
      };
    case 'arr':
      return {
        label: '© All Rights Reserved',
        link: 'https://en.wikipedia.org/wiki/All_rights_reserved',
        raw: 'arr',
      };
    case 'ck12':
      return {
        label: `<img src="data:image/png;base64,${ImageConstants.cc.ck12}"/>`,
        link: 'https://www.ck12info.org/curriculum-materials-license',
        raw: 'ck12',
      };
    default:
      break;
  }
  return null; // not found
}

// TODO: non-English support
export function renderAutoAttribution(page: BookPageInfo): string {
  const { tags, printInfo, license, title, url, authorTag } = page;

  // Parse tag-based overrides
  const authorNames: string[] = [];
  let sectionAuthorURL = '';
  let sectionSource = '';

  for (const tag of tags) {
    if (tag.startsWith('author@')) {
      authorNames.push(tag.replace('author@', ''));
    } else if (tag.startsWith('authorURL@')) {
      sectionAuthorURL = tag.replace('authorURL@', '');
    } else if (tag.startsWith('source@')) {
      sectionSource = tag.replace('source@', '');
    }
  }

  // Join multiple author@ names: "A", "A & B", "A, B, & C"
  let sectionAuthorTitle = '';
  if (authorNames.length === 1) {
    sectionAuthorTitle = authorNames[0];
  } else if (authorNames.length === 2) {
    sectionAuthorTitle = `${authorNames[0]} & ${authorNames[1]}`;
  } else if (authorNames.length > 2) {
    const allButLast = authorNames.slice(0, -1).join(', ');
    sectionAuthorTitle = `${allButLast}, & ${authorNames[authorNames.length - 1]}`;
  }

  // License display
  const licenseName = getLicenseDisplayTitle(license);
  const licenseURL = license?.link ?? '';

  // Source clause
  let sourceClause: string;
  if (sectionSource && sectionSource !== 'native') {
    sourceClause = ` via <a rel="nofollow" href="${sectionSource}" target="_blank">source content</a> that was edited to the style and standards of the LibreTexts platform.`;
  } else if (sectionSource === 'native') {
    sourceClause = ' directly on the LibreTexts platform.';
  } else {
    sourceClause = '.';
  }

  if (authorTag) {
    // Resolve author display name and URL with priority cascade
    let authorDisplay = printInfo.authorName;
    if (sectionAuthorTitle) authorDisplay = sectionAuthorTitle;

    let authorDisplayURL = printInfo.authorURL;
    if (sectionAuthorURL) authorDisplayURL = sectionAuthorURL;

    // Author fragment
    let authorFragment = '';
    if (authorDisplay && authorDisplayURL) {
      authorFragment = `<a rel="nofollow" target="_blank" href="${authorDisplayURL}">${authorDisplay}</a>`;
    } else if (authorDisplay) {
      authorFragment = authorDisplay;
    }

    // Program/publisher fragment (skip if same as author display name)
    let programFragment = '';
    if (printInfo.programName && printInfo.programName !== authorDisplay) {
      if (printInfo.programURL) {
        programFragment = ` (<a rel="nofollow" target="_blank" href="${printInfo.programURL}">${printInfo.programName}</a>)`;
      } else {
        programFragment = ` (${printInfo.programName})`;
      }
    }

    return `
      <hr class="autoattribution-divider" />
      <div class="autoattribution">
        <p>This page titled <a href="${url}" target="_blank">${title}</a> is shared under a <a rel="nofollow" href="${licenseURL}" target="_blank">${licenseName}</a> license and was authored, remixed, and/or curated by ${authorFragment}${programFragment}${sourceClause}</p>
      </div>
    `;
  }

  // Fallback: no authorTag
  const fallbackAuthor = sectionAuthorTitle || 'LibreTexts';
  return `
    <hr class="autoattribution-divider" />
    <div class="autoattribution">
      <p><a href="${url}" target="_blank">${title}</a> is shared under a <a rel="nofollow" href="${licenseURL}" target="_blank">${licenseName}</a> license and was authored, remixed, and/or curated by ${fallbackAuthor}.</p>
    </div>
  `;
}
