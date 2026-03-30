import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
import { LicenseInfo } from './licensing';
import { BookPageInfo } from '../types/book';
import { PDFCoverOpts, PDFCoverType, PDFCoverDimensions } from '../types/pdf';

export const PDF_COVER_TYPES = ['Amazon', 'CaseWrap', 'CoilBound', 'Main', 'PerfectBound'] as const;

/**
 * Generates @font-face CSS for Atkinson Hyperlegible using absolute file:// URLs.
 * Required because CSS is inlined into HTML with no base URL, so Prince cannot
 * resolve relative paths from within an inline <style> block.
 */
export function generateFontCSS(): string {
  const fontsDir = join(__dirname, '../styles/fonts');
  const toURL = (file: string) => pathToFileURL(join(fontsDir, file)).href;
  return `
    @font-face {
      font-family: 'Atkinson Hyperlegible';
      font-style: normal;
      font-weight: 400;
      src: url('${toURL('atkinson-hyperlegible-400.ttf')}') format('truetype');
    }
    @font-face {
      font-family: 'Atkinson Hyperlegible';
      font-style: normal;
      font-weight: 700;
      src: url('${toURL('atkinson-hyperlegible-700.ttf')}') format('truetype');
    }
    @font-face {
      font-family: 'Atkinson Hyperlegible';
      font-style: italic;
      font-weight: 400;
      src: url('${toURL('atkinson-hyperlegible-400i.ttf')}') format('truetype');
    }
    @font-face {
      font-family: 'Atkinson Hyperlegible';
      font-style: italic;
      font-weight: 700;
      src: url('${toURL('atkinson-hyperlegible-700i.ttf')}') format('truetype');
    }
  `;
}

// CSS loaded at module init and inlined into HTML sent to Prince.
// Note: changes to these files require a server restart in development.
export const pdfHeaderCSS = readFileSync(join(__dirname, '../styles/pdf-header.css'), 'utf-8');
export const pdfFooterCSS = readFileSync(join(__dirname, '../styles/pdf-footer.css'), 'utf-8');
const pdfCoverCSS = readFileSync(join(__dirname, '../styles/pdf-cover.css'), 'utf-8');
const pdfCoverExtraPaddingCSS = readFileSync(join(__dirname, '../styles/pdf-cover-extra-padding.css'), 'utf-8');
export const pdfTOCStyles = readFileSync(join(__dirname, '../styles/pdf-toc.css'), 'utf-8');

// --- Page dimension constants (letter size) ---
export const PDF_PAGE_WIDTH_IN = 8.5;
export const PDF_PAGE_HEIGHT_IN = 11;
export const PDF_PAGE_MARGIN_TOP_IN = 0.75;
export const PDF_PAGE_MARGIN_HORIZONTAL_IN = 0.625;
export const PDF_PAGE_MARGIN_BOTTOM_IN = 0.9;

// --- Cover sizing constants ---
/** Amazon KDP black-and-white paper thickness per page, in inches */
const AMAZON_PAGE_THICKNESS_IN = 0.002252;
/** Amazon binding and bleed allowance added to spine and panels, in inches */
const AMAZON_BINDING_ALLOWANCE_IN = 0.375;
/** Combined front + back panel width for standard (non-hardcover) covers, in inches */
const STANDARD_COVER_PANELS_WIDTH_IN = 17;
/** Combined front + back panel width for hardcover/CaseWrap covers, in inches */
const CASEWRAP_COVER_PANELS_WIDTH_IN = 18.75;
/** Total cover width for thin/CoilBound covers (independent of page count), in inches */
const COILBOUND_TOTAL_COVER_WIDTH_IN = 17.25;
/** Pages-per-inch divisor used for PerfectBound spine width calculation */
const PERFECTBOUND_PAGES_PER_INCH = 444;
/** Minimum spine padding for PerfectBound covers, in inches */
const PERFECTBOUND_MIN_SPINE_IN = 0.06;
/** Standard paperback cover height including bleed, in inches */
const COVER_PAPERBACK_HEIGHT_IN = 11.25;
/** Hardcover/CaseWrap cover height including bleed, in inches */
const COVER_HARDCOVER_HEIGHT_IN = 12.75;
/**  */
const PDF_COVER_WIDTHS: Record<string, number | null> = {
  '0': null,
  '24': 0.25,
  '84': 0.5,
  '140': 0.625,
  '169': 0.6875,
  '195': 0.75,
  '223': 0.8125,
  '251': 0.875,
  '279': 0.9375,
  '307': 1,
  '335': 1.0625,
  '361': 1.125,
  '389': 1.1875,
  '417': 1.25,
  '445': 1.3125,
  '473': 1.375,
  '501': 1.4375,
  '529': 1.5,
  '557': 1.5625,
  '582': 1.625,
  '611': 1.6875,
  '639': 1.75,
  '667': 1.8125,
  '695': 1.875,
  '723': 1.9375,
  '751': 2,
  '779': 2.0625,
  '800': 2.125,
};

export const pdfPageMargins = `${PDF_PAGE_MARGIN_TOP_IN}in ${PDF_PAGE_MARGIN_HORIZONTAL_IN}in ${PDF_PAGE_MARGIN_BOTTOM_IN}in`; // top, left/right, bottom

/**
 * Returns the physical dimensions for a given cover type and page count.
 * All values are in inches. This is the single source of truth for cover sizing logic.
 */
export function getCoverDimensions(coverType: PDFCoverType, numPages: number | null): PDFCoverDimensions {
  const pages = numPages ?? 0;

  switch (coverType) {
    case 'Main':
      return { spineWidth: 0, totalWidth: PDF_PAGE_WIDTH_IN, height: PDF_PAGE_HEIGHT_IN };

    case 'Amazon': {
      const spineWidth = pages * AMAZON_PAGE_THICKNESS_IN;
      return {
        spineWidth,
        totalWidth: spineWidth + AMAZON_BINDING_ALLOWANCE_IN + STANDARD_COVER_PANELS_WIDTH_IN,
        height: COVER_PAPERBACK_HEIGHT_IN,
      };
    }

    case 'CoilBound':
      return { spineWidth: 0, totalWidth: COILBOUND_TOTAL_COVER_WIDTH_IN, height: COVER_PAPERBACK_HEIGHT_IN };

    case 'CaseWrap': {
      const spineWidth =
        Object.entries(PDF_COVER_WIDTHS).reduce<number | null>(
          (acc, [k, v]) => (pages > parseInt(k) ? v : acc),
          null,
        ) ?? 0;
      return {
        spineWidth,
        totalWidth: spineWidth + CASEWRAP_COVER_PANELS_WIDTH_IN,
        height: COVER_HARDCOVER_HEIGHT_IN,
      };
    }

    case 'PerfectBound': {
      const spineWidth = Math.floor((pages / PERFECTBOUND_PAGES_PER_INCH + PERFECTBOUND_MIN_SPINE_IN) * 1000) / 1000;
      return {
        spineWidth,
        totalWidth: spineWidth + COILBOUND_TOTAL_COVER_WIDTH_IN,
        height: COVER_PAPERBACK_HEIGHT_IN,
      };
    }
  }
}

/**
 * Returns the header HTML for a content page, wrapped in a Prince running element container.
 * Must be placed in the <body> — Prince's `position: running(pageHeader)` (in pdf-page.css)
 * removes it from flow and places it in the @page @top margin box.
 */
export function generatePDFHeader(headerImg: string) {
  return `
    <div id="libre-pdf-header">
      <div id="libreHeader">
        <a href="https://libretexts.org"><img src="data:image/png;base64,${headerImg}" /></a>
      </div>
    </div>
  `;
}

/**
 * Returns the footer HTML for a content page, wrapped in a Prince running element container.
 * Must be placed in the <body> — Prince's `position: running(pageFooter)` (in pdf-page.css)
 * removes it from flow and places it in the @page @bottom margin box.
 *
 * The `--pdf-main-color` CSS custom property must be set in the document <head> for theming.
 */
export function generatePDFFooter({
  currentPage,
  mainColor,
  pageLicense,
  prefix,
}: {
  currentPage: BookPageInfo | null;
  mainColor: string;
  pageLicense: LicenseInfo | null;
  prefix: string;
}) {
  let programLink = '';
  if (currentPage?.printInfo) {
    const { attributionPrefix, programName, programURL } = currentPage.printInfo;
    if (attributionPrefix && programName && programURL) {
      programLink = `<a href="${programURL}" rel="noreferrer">${attributionPrefix} ${programName}</a>`;
    }
  }
  return `
    <style>
      * {
        print-color-adjust: exact;
      }
      a {
          text-decoration:none;
          color: white;
      }
      #libreFooter {
          display: flex;
          width: 100vw;
          height: 20px;
          margin: 0 4%;
          border-radius: 10px;
          font-size: 7px;
          justify-content: center;
          background-color: ${mainColor};
      }
      #libreFooter > a {
          display: block;
      }
      .footer-left {
          display: inline-flex;
          flex: 1;
          align-items: center;
          justify-content: space-between;
          color: #F5F5F5;
          padding: 1%;
      }
      .footer-left img {
          vertical-align: middle;
          height: 15px;
          display: inline-block;
          padding-right: 1px;
      }
      .footer-center {
          display: inline-flex;
          align-items: center;
          justify-content: center;
      }
      .footer-pagenum {
        background-color: white;
        border: 1px solid ${mainColor};
        color: ${mainColor};
        padding: 2px;
        border-radius: 10px;
        min-width: 10px;
        text-align: center;
        font-size: 8px;
      }
      .footer-right {
          display: inline-flex;
          flex: 1;
          align-items: center;
          justify-content: flex-end;
          color: #F5F5F5;
          padding: 1%;
      }
      .date, .pageNumber {
          display: inline-block;
      }
      #footer {
          display: flex;
          align-items: center;
          padding: 0 !important;
          margin: 0 !important;
      }
      .added {
          padding: 0 4px;
      }
    </style>
    <div id="libreFooter">
      <div class="footer-left">
          <a href="${pageLicense ? pageLicense.link : ''}">${pageLicense ? pageLicense.label : ''}</a>
          ${programLink ? `<div>${programLink}</div>` : ''}
      </div>
      <div class="footer-center">
            
            <div class="footer-pagenum">
              ${prefix}<div class="pageNumber"></div>
            </div>
      </div>
      <div class="footer-right">
          ${
            currentPage
              ? `<a href="https://${currentPage.subdomain}.libretexts.org/@go/page/${currentPage.pageID.pageNum}?pdf">https://${currentPage.subdomain}.libretexts.org/@go/page/${currentPage.pageID.pageNum}</a>`
              : ''
          }
      </div>
    </div>
  `;
}

export function generatePDFCoverHTML({
  bookInfo,
  coverType,
  opt,
  numPages,
}: {
  bookInfo: BookPageInfo;
  coverType: PDFCoverType;
  opt?: PDFCoverOpts;
  numPages: number | null;
}) {
  const dimensions = getCoverDimensions(coverType, numPages);

  const frontContent = _generatePDFFrontCoverContent(bookInfo);
  const backContent = _generatePDFBackCoverContent(bookInfo);
  const spine = _generatePDFSpineContent({ currentPage: bookInfo, opt, dimensions });
  const headStyles = _generatePDFCoverHeadStyles({ currentPage: bookInfo, opt, dimensions });

  return `
    <!DOCTYPE html>
    <html lang="en">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>${coverType} Cover</title>
        ${headStyles}
      </head>
      <body>
        ${coverType !== 'Main' ? `${backContent}${spine}${frontContent}` : frontContent}
      </body>
    </html>
  `;
}

/**
 * Generating the HTML content for the front cover of the PDF,
 * including the title and author information from the current page's printInfo.
 */
function _generatePDFFrontCoverContent(currentPage: BookPageInfo) {
  return `
    <div id="frontContainer">
      <div>
        <div id="frontTitle">${currentPage.printInfo.title ?? ''}</div>
      </div>
      <div>
        <div id="frontCite"><i>${currentPage.printInfo.authorName ?? ''}</i><br/>${currentPage.printInfo.companyName ?? ''}</div>
      </div>
    </div>
  `;
}

/**
 * Generates the HTML content for the back cover of the PDF,
 * including a logo (if specified in the page tags), an overview/summary of the page,
 * and a QR code linking to the page URL. The layout and styling are designed to fit within the back cover dimensions,
 * and the QR code is generated using the qrcode.js library.
 */
function _generatePDFBackCoverContent(currentPage: BookPageInfo) {
  let logoSrc = 'https://cdn.libretexts.net/shapeshift/pdf_back_logo.png';
  const logoTag = currentPage.tags.find((t) => t.startsWith('luluCover@'));
  if (logoTag) {
    logoSrc = logoTag.replace('luluCover@', '');
  }
  return `
    <div id="backContainer">
      <div>${logoSrc ? `<img id="backLogo" src="${logoSrc}">` : ''}</div>
      <div>
        <div id="backOverview">${currentPage.summary ?? ''}</div>
        <canvas id="canvas"></canvas>
      </div>
    </div>
    <script src="https://cdn.libretexts.net/shapeshift/qrcode.js"></script>
    <script>
      QRCode.toCanvas(
        document.getElementById('canvas'),
        '${currentPage.url}',
        {
          color: {
            dark: '#127BC4',
            light: '#FFF',
          },
          errorCorrectionLevel: 'low',
          margin: 2,
          scale: 2,
        },
        function (error) {
          if (error) {
            console.error(error);
            return;
          }
          console.log('success!');
        },
      );
    </script>
  `;
}

/**
 * Generates an HTML string containing the styles and elements needed for the PDF spine,
 * including the background image based on the current page's subdomain and the provided options.
 */
function _generatePDFSpineContent({
  currentPage,
  opt,
  dimensions,
}: {
  currentPage: BookPageInfo;
  opt?: PDFCoverOpts;
  dimensions: PDFCoverDimensions;
}) {
  const spinePercent = (dimensions.spineWidth / dimensions.totalWidth) * 100;
  const spineFontSize = Math.min((dimensions.spineWidth / dimensions.totalWidth) * 500, 40);
  return `
    <div id="spine">
      <div>${currentPage.printInfo.spineTitle || currentPage.printInfo.title || ''}</div>
      <div id="spineCite"><b style="flex:1; text-align: center">${currentPage.printInfo.authorName || ''}</b><img src="https://cdn.libretexts.net/shapeshift/stacked_logo.png" /></div>
    </div>
    <style>
      #spine {
        background-image: url("https://cdn.libretexts.net/shapeshift/SpineImages/${opt?.extraPadding ? 'LuluSpine' : 'NormalSpine'}/${currentPage.subdomain}.png");
        width: ${spinePercent}%;
        font-size: ${spineFontSize}px;
      }
    </style>
  `;
}

/**
 * Generates an HTML string containing the <head> styles and elements needed for the PDF cover,
 * including the background images for spine, front, and back based on the current page's subdomain and the provided options.
 */
export function _generatePDFCoverHeadStyles({
  currentPage,
  opt,
  dimensions,
}: {
  currentPage: BookPageInfo;
  opt?: PDFCoverOpts;
  dimensions: PDFCoverDimensions;
}) {
  const pageWidth = `${dimensions.totalWidth}in`;
  const pageHeight = `${dimensions.height}in`;

  return `
    <style>
      @page {
        size: ${pageWidth} ${pageHeight};
        margin: 0;
      }
    </style>
    <style>${pdfCoverCSS}</style>
    <style>${generateFontCSS()}</style>
    <style>
      #frontContainer {
        background-image: url("https://cdn.libretexts.net/shapeshift/CoverImages/${opt?.extraPadding ? 'LuluFront' : 'NormalFront'}/${currentPage.subdomain}.png");
      }
      #backContainer {
        background-image: url("https://cdn.libretexts.net/shapeshift/CoverImages/${opt?.extraPadding ? 'LuluBack' : 'NormalBack'}/${currentPage.subdomain}.png");
      }
      ${opt?.extraPadding ? pdfCoverExtraPaddingCSS : ''}
    </style>
  `;
}
