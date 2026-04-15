import {
  DetailedLicenseReportTextInfo,
  DetailedLicenseReportTextInfoEntry,
  DetailedLicensingReport,
} from '../types/licensing';

function recurseLicensingEntry(page: DetailedLicenseReportTextInfo | DetailedLicenseReportTextInfoEntry): string {
  if (!page) return '';
  let newString = `<li><a href="${page.url}" target="_blank">${page.title}</a>`;
  if (page.license) {
    newString = `
      ${newString} - <a href="${page.license?.link}" target="_blank" rel="noreferrer">
        <em>${page.license?.label} ${page.license?.version || ''}</em>
      </a>
    `;
  }
  if (page.children?.length) {
    newString = `${newString}<ul>`;
    for (let i = 0, n = page.children.length; i < n; i += 1) {
      newString = `${newString}${recurseLicensingEntry(page.children[i])}`;
    }
    newString = `${newString}</ul>`;
  }
  newString = `${newString}</li>`;
  return newString;
}

export function generateDetailedLicensingHTML(licensingReport: DetailedLicensingReport): string {
  if (!licensingReport) {
    return `<p>Detailed licensing information for this resource is not available at this time.</p>`;
  }

  const specialRestrictions = licensingReport.meta.specialRestrictions
    .map((item) => {
      switch (item) {
        case 'noncommercial':
          return 'Noncommercial';
        case 'noderivatives':
          return 'No Derivatives';
        case 'fairuse':
          return 'Fair Use';
        default:
          return null;
      }
    })
    .filter((r) => r);
  const specialRestrictionsText =
    specialRestrictions.length > 0
      ? `<p><strong>Applicable Restrictions:</strong> ${specialRestrictions.join(', ')}</p>`
      : '';
  const licensesList = licensingReport?.meta?.licenses?.reduce((acc, item) => {
    const pagesModifier = item.count > 1 ? 'pages' : 'page';
    const entry = `
      <li>
        <a href="${item.link}" target="_blank" rel="noreferrer">${item.label}${item.version ? ` ${item.version}` : ''}</a>: ${item.percent}% (${item.count} ${pagesModifier})
      </li>
    `;
    return `${acc}${entry}`;
  }, '');

  return `
    <h2>Overview</h2>
    <p><strong>Title:</strong> <a href="${licensingReport.text.url}" target="_blank" rel="noreferrer">${licensingReport.text.title}</a></p>
    <p><strong>Webpages:</strong> ${licensingReport.text.totalPages}</p>
    ${specialRestrictionsText}
    <p><strong>All licenses found:</strong></p>
    <ul>${licensesList}</ul>
    <h2>By Page</h2>
    <div id="libre-licensing-by-page-container">
      <ul>
        ${recurseLicensingEntry(licensingReport.text)}
      </ul>
    </div>
  `;
}
