import { LicenseInfo } from './licensing';
import { BookPageInfo } from '../types/book';
import { PDFCoverOpts } from '../services/pdf';
import { isNullOrUndefined } from '../helpers';
import { PDF_COVER_WIDTHS } from '../lib/constants';

export const pdfPageMargins = '0.75in 0.625in 0.9in'; // top, left/right, bottom

export function generatePDFHeader(headerImg: string) {
  return `
    <style>
      * {
        print-color-adjust: exact;
      }
      #header {
          padding: 0 !important;
          margin: 0 !important;
      }
      #libreHeader {
          height: 100%;
          display: flex;
          align-items: center;
          margin: 0;
          margin-left: 0.4in;
          width: 100vw;
          padding-top: 1%;
      }
      #libreHeader img {
          height: 25px;
          margin: 0;
          padding: 0;
      }
      #libreHeader a {
          margin: 0;
          padding: 0;
      }
    </style>
    <div id="libreHeader">
      <a href="https://libretexts.org"><img src="data:image/png;base64,${headerImg}" /></a>
    </div>
  `;
}

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

export const pdfTOCStyles = `
  #libre-print-directory-header {
    color: white !important;
    font-size: 1.6em !important;
    font-family: "Lato", Arial, serif !important;
    text-transform: uppercase;
    font-weight: bold;
    margin: 0 0 0 1% !important;
    padding: 1% 0 !important;
    letter-spacing: .05em !important;
  }
  #libre-print-directory-header-container {
    display: flex;
    background: #127BC4;
    margin: 0 0 2%;
    padding: 0;
    width: 100%;
    align-items: center;
  }
  .nobreak {
    page-break-inside: avoid;
  }
  .indent0 {
    margin-left: 6px !important;
  }
  .indent1 {
    margin-left: 12px !important;
  }
  .indent2 {
    margin-left: 18px !important;
  }
  .indent3 {
    margin-left: 24px !important;
  }
  .indent4 {
    margin-left: 30px !important;
  }
  .libre-print-directory {
    margin: 0;
    padding: 0 0 2%;
  }
  .libre-print-list {
    list-style-type: none;
    margin: 0 !important;
    padding: 0 !important;
    font-size: 12px;
  }
  .libre-print-list li {
    padding-bottom: 2px;
  }
  .libre-print-sublisting0 {
    padding-bottom: 8px;
  }
  .libre-print-sublisting1 {
    padding-bottom: 4px;
  }
  .libre-print-sublisting2 {
    padding-bottom: 2px;
  }
  .libre-print-list h2::before {
    content: none !important; // MT default styling
  }
`;

const pdfCoverStyles = `
  body {
    margin: 0;
    height: 100vh;
    width: 100vw;
    display: flex;
    background-color: #127bc4;
    font-family: 'Open Sans', sans-serif;
    align-content: stretch;
  }
  * {
    white-space: pre-wrap;
    box-sizing: border-box;
    /*border: 1px solid black;*/
    print-color-adjust: exact;
  }
  #frontContainer, #backContainer {
    display: flex;
    flex: 1;
    flex-direction: column;
    justify-content: space-evenly;
    /*width: 800px;*/
    color: white;
    padding: 80px 50px;
    background-size: 100% 100%;
    background-repeat: no-repeat;
  }
  #spine {
    display: flex;
    /*border: 1px dashed black;*/
    writing-mode: vertical-rl;
    padding: 80px 0;
    align-items: center;
    background-repeat: no-repeat;
    background-size: 100% 100%;
    overflow: hidden;
    color: white;
  }
  #spineCite > img {
    max-width: 100%;
    max-height: 6vh;
    /*margin-top: 20px;*/
  }
  #spine > div {
    flex: 1;
    width: 100%;
    display: flex;
    align-items: center;
  }
  #frontContainer > div, #backContainer > div {
    display: flex;
    flex-direction: column;
    justify-content: center;
    flex: 1;
    margin-right: 190px;
  }
  #backContainer > div {
    align-items: center;
  }
  #spine > div:first-child {
    margin-bottom: 70px;
  }
  #backContainer > div {
    margin-left: 190px;
    margin-right: unset;
  }
  #frontTitle {
    font-size: 50px;
    text-transform: uppercase;
  }
  #frontCite {
    font-size: 28px;
  }
  #backLogo {
    max-height: 70%;
    max-width: 80%;
    object-fit: contain;
  }
  div#backOverview {
    flex: 1;
    margin: 20px;
    text-align: justify;
    display: flex;
    justify-content: center;
    flex-direction: column;
  }
  #canvas {
    align-self: flex-end;
  }
  #spineCite {
    font-size: 80%;
  }
`;

const pdfExtraPaddingStyles = `
  #frontContainer, #backContainer {
    padding: 117px 50px;
  }
  #spine {
    padding: 117px 0;
  }
`;

export function generatePDFCoverContent({
  bookInfo,
  opt,
  numPages,
}: {
  bookInfo: BookPageInfo;
  opt?: PDFCoverOpts;
  numPages: number | null;
}) {
  const spineWidth = _getCoverSpineWidth({ numPages, opt });
  const width = _getCoverWidth({ numPages, opt });

  const frontContent = _generatePDFFrontCoverContent(bookInfo);
  const backContent = _generatePDFBackCoverContent(bookInfo);
  const spine = _generatePDFSpineContent({ currentPage: bookInfo, opt, spineWidth, width });
  const styles = _generatePDFCoverStyles({ currentPage: bookInfo, opt });
  const coverType = opt?.thin ? 'Thin' : 'Standard';

  return `
    <!DOCTYPE html>
    <html lang="en">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>${coverType} Cover</title>
        <style>
          @page {
            size: ${numPages ? `${width}in` : '8.5in'} 
            ${numPages ? (opt?.hardcover ? '12.75in' : '11.25in') : '11in'};
            margin: 0;
          }
          ${styles}
          ${opt?.extraPadding ? pdfExtraPaddingStyles : ''}
        </style>
      </head>
      <body>
        ${numPages ? `${backContent}${spine}${frontContent}` : frontContent}
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
  spineWidth,
  width,
}: {
  currentPage: BookPageInfo;
  opt?: PDFCoverOpts;
  spineWidth: number;
  width: number;
}) {
  return `
    <div id="spine">
      <div>${currentPage.printInfo.spineTitle || currentPage.printInfo.title || currentPage.printInfo.title || ''}</div>
      <div id="spineCite"><b style="flex:1; text-align: center">${currentPage.printInfo.authorName || ''}</b><img src="https://cdn.libretexts.net/shapeshift/stacked_logo.png" /></div>
    </div>
    <style>
      #spine {
        background-image: url("https://cdn.libretexts.net/shapeshift/SpineImages/${opt?.extraPadding ? 'LuluSpine' : 'NormalSpine'}/${currentPage.subdomain}.png");
        width: ${(spineWidth / width) * 100}%;
        font-size: ${Math.min((spineWidth / width) * 500, 40)}px;
      }
    </style>
  `;
}

/**
 * Generates an HTML string containing the styles and elements needed for the PDF cover,
 * including the background images for spine, front, and back based on the current page's subdomain and the provided options.
 */
export function _generatePDFCoverStyles({ currentPage, opt }: { currentPage: BookPageInfo; opt?: PDFCoverOpts }) {
  return `
    <style>${pdfCoverStyles}</style>
		<link href="https://fonts.googleapis.com/css?family=Open+Sans:300,300i" rel="stylesheet" />
    <style>
      #frontContainer{
        background-image: url("https://cdn.libretexts.net/shapeshift/CoverImages/${opt?.extraPadding ? 'LuluFront' : 'NormalFront'}/${currentPage.subdomain}.png");
      }
      #backContainer{
        background-image: url("https://cdn.libretexts.net/shapeshift/CoverImages/${opt?.extraPadding ? 'LuluBack' : 'NormalBack'}/${currentPage.subdomain}.png");
      }
    </style>
  `;
}

function _getCoverSpineWidth({ numPages, opt }: { numPages: number | null; opt?: PDFCoverOpts }) {
  if (opt?.thin) return 0;
  if (opt && !opt.extraPadding && !isNullOrUndefined(numPages)) return numPages * 0.002252; // Amazon side
  if (opt?.hardcover && !isNullOrUndefined(numPages)) {
    const res = Object.entries(PDF_COVER_WIDTHS).reduce(
      (acc, [k, v]) => {
        if (numPages > parseInt(k)) return v;
        return acc;
      },
      null as number | null,
    );
    if (res) return res;
  }

  if (isNullOrUndefined(numPages)) return 0;
  const baseWidth = numPages / 444 + 0.06;
  return Math.floor(baseWidth * 1000) / 1000;
}

function _getCoverWidth({ numPages, opt }: { numPages: number | null; opt?: PDFCoverOpts }) {
  if (opt?.thin) return 17.25;
  if (opt && !opt.extraPadding && !isNullOrUndefined(numPages)) return numPages * 0.002252 + 0.375 + 17; // Amazon size
  if (opt?.hardcover && !isNullOrUndefined(numPages)) {
    const res = Object.entries(PDF_COVER_WIDTHS).reduce(
      (acc, [k, v]) => {
        if (numPages > parseInt(k)) return v;
        return acc;
      },
      null as number | null,
    );
    if (res) return res + 18.75;
  }

  if (isNullOrUndefined(numPages)) return 0;
  const baseWidth = numPages / 444 + 0.06 + 17.25;
  return Math.floor(baseWidth * 1000) / 1000;
}
