import { ImageConstants } from './imageConstants';

export type LicenseInfo = {
  label: string;
  link: string;
  raw: string;
  version?: string;
};

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
