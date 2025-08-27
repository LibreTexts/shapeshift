import { ImageConstants } from '../../util/image_constants';

export function createPdfFooter(
  currentPage: Record<string, string>,
  pageLicense: Record<string, string>,
  prefix: string,
) {
  const mainColor = '#127BC4';
  let programLink = null;
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
  const footerHtml = `
  <!DOCTYPE html>
  <html lang="en">
  <head>
    <title>PDF Footer</title>
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
  </head>
  <body>
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
  </body>
  </html>
  `;
  return Buffer.from(footerHtml, 'utf-8');
}

export function createPdfHeader(headerImg?: string) {
  const headerHtml = `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <title>PDF Header</title>
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
    </head>
    <body>
      <div id="libreHeader">
        <a href="https://libretexts.org"><img src="data:image/png;base64,${headerImg ?? ImageConstants['default']}" /></a>
      </div>
    </body>
    </html>
  `;
  return Buffer.from(headerHtml, 'utf-8');
}
