import { LicenseInfo } from './licensing';
import { BookPageInfo } from '../services/book';

export const pdfPageMargins = '0.75in 0.625in 0.9in'; // top, left/right, bottom

export function generatePDFHeader(headerImg: string) {
  return `
    <style>
    * {
      -webkit-print-color-adjust: exact;
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
  currentPage: BookPageInfo;
  mainColor: string;
  pageLicense: LicenseInfo | null;
  prefix: string;
}) {
  let programLink = null;
  /* TODO
  if (currentPage) {
    const { programname, programurl, attributionprefix } = currentPage;
    if (programname && programurl && attributionprefix) {
      programLink = `
        <a href="${programurl}" rel="noreferrer">
          ${attributionprefix} ${programname}
        </a>
      `;
    }
  }
   */
  return `
    <style>
      * {
        -webkit-print-color-adjust: exact;
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
              ? `<a href="https://${currentPage.subdomain}.libretexts.org/@go/page/${currentPage.id}?pdf">https://${currentPage.subdomain}.libretexts.org/@go/page/${currentPage.id}</a>`
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
