import fs from 'node:fs/promises';
import { v4 as uuid } from 'uuid';
import { resolve } from 'node:path';
import puppeteer, { Browser, Dialog, Viewport, HTTPRequest, GoToOptions } from 'puppeteer';
import { pdfIgnoreList } from '../util/ignoreLists';
import { generatePDFFooter, generatePDFHeader, pdfPageMargins, pdfTOCStyles } from '../util/pdfHelpers';
import { ImageConstants } from '../util/imageConstants';
import { sleep } from '../helpers';
import { log as logService } from '../lib/log';
import { BookID, BookPageInfo } from './book';
import { CXOneRateLimiter } from '../lib/cxOneRateLimiter';
import { PDFDocument } from 'pdf-lib';
import { LogLayer } from 'loglayer';

type PDFCoverOpts = {
  extraPadding?: boolean;
  hardcover?: boolean;
  thin?: boolean;
};

export class PDFService {
  private _browser: Browser | null = null;
  private readonly logger: LogLayer;
  private readonly logName = 'PDFService';
  private readonly pageLoadSettings: GoToOptions = {
    timeout: 120000,
    waitUntil: ['load', 'domcontentloaded', 'networkidle0'],
  };
  private readonly viewportSettings: Viewport = { width: 975, height: 1000 };

  constructor() {
    this.logger = logService.child().withContext({ logSource: this.logName });
  }

  private async getBrowser(): Promise<Browser> {
    if (!this._browser) {
      this._browser = await puppeteer.launch();
    }
    return this._browser;
  }

  private async generateFinalOutputFileName({
    bookID,
    outFileNameOverride,
  }: {
    bookID: BookID;
    outFileNameOverride?: string;
  }) {
    const dirPath = resolve(`./.tmp/out/${bookID.lib}-${bookID.pageID}`);
    const fileName = outFileNameOverride ?? 'Full';
    const filePath = `${dirPath}/${fileName}.pdf`;
    await fs.mkdir(dirPath, { recursive: true });
    return filePath;
  }

  private async generatePageOutputFileName({
    bookID,
    outFileNameOverride,
  }: {
    bookID: BookID;
    outFileNameOverride?: string;
  }) {
    const dirPath = resolve(`./.tmp/pdf/${bookID.lib}-${bookID.pageID}`);
    const fileName = outFileNameOverride ?? uuid();
    const filePath = `${dirPath}/${fileName}.pdf`;
    await fs.mkdir(dirPath, { recursive: true });
    return filePath;
  }

  private async ensureCoversDirectory(bookID: BookID) {
    const dirPath = resolve(`./.tmp/pdf/${bookID.lib}-${bookID.pageID}/covers/`);
    await fs.mkdir(dirPath, { recursive: true });
    return dirPath;
  }

  private async detailsOpener(detailsElements: HTMLDetailsElement[]) {
    for (const elem of detailsElements) {
      elem.open = true;
    }
  }

  private async dialogHandler(dialog: Dialog) {
    await dialog.dismiss();
  }

  private async eagerImageLoader(imageElements: HTMLImageElement[]) {
    for (const img of imageElements) {
      img.loading = 'eager';
    }
  }

  private async requestHandler(req: HTTPRequest) {
    if (req.isInterceptResolutionHandled()) return;
    if (pdfIgnoreList?.length) {
      const url = req.url();
      const foundMatch = pdfIgnoreList.find((u) => url.includes(u));
      if (foundMatch) {
        await req.abort();
        return;
      }
    }
    await req.continue();
  }

  public async convertBook({ bookID, pages }: { bookID: BookID; pages: BookPageInfo }) {
    const pagePaths: string[] = [];
    const convertTree = async (p: BookPageInfo) => {
      const idx = `${pagePaths.length}`.padStart(4, '0');
      if (
        Array.isArray(p.subpages) &&
        p.subpages.length > 1 &&
        (p.tags.includes('article:topic-category') || p.tags.includes('article:topic-guide'))
      ) {
        pagePaths.push(
          await this.generateTableOfContents({
            pageInfo: p,
            outFileNameOverride: `1:${idx}_TOC`,
          }),
        );
      } else {
        pagePaths.push(
          await this.convertPage({
            pageInfo: p,
            outFileNameOverride: `1:${idx}_${p.lib}-${p.id}`,
          }),
        );
      }
      if (!Array.isArray(p.subpages)) return;
      for (const sub of p.subpages) {
        await convertTree(sub);
      }
    };
    await convertTree(pages);
    return await this.mergePagesAndWrite({ bookID, pages: pagePaths });
  }

  public async convertPage({
    outFileNameOverride,
    pageInfo,
  }: {
    outFileNameOverride?: string;
    pageInfo: BookPageInfo;
    token?: string;
  }) {
    await CXOneRateLimiter.waitUntilAPIAvailable(2);
    const browser = await this.getBrowser();
    const page = await browser.newPage();
    await page.setViewport(this.viewportSettings);
    await page.setRequestInterception(true);
    page.on('dialog', this.dialogHandler);
    page.on('request', this.requestHandler);
    await page.goto(`${pageInfo.url}?no-cache`, this.pageLoadSettings);
    await page.$$eval('img', this.eagerImageLoader);
    await page.$$eval('details', this.detailsOpener);
    await sleep(1000);

    const listing = await this.getLevel(pageInfo);
    if (listing) {
      await page.evaluate(this.processDirectoryPage, { listing, tags: pageInfo.tags, title: pageInfo.title });
      await sleep(1000);
    }
    const foundPrefix = await page.evaluate(function (url) {
      const title = document.getElementById('title');
      if (!title) return '';
      const color = window.getComputedStyle(title).color;
      const innerText = title.innerText;
      title.innerHTML = `<a style="color:${color}; text-decoration: none" href="${url}">${innerText}</a>`;
      if (innerText?.includes(':')) {
        return innerText.split(':')[0];
      }
      return '';
    }, pageInfo.url);
    const prefix = foundPrefix ? `${foundPrefix}.` : '';

    const showHeaders = !(
      pageInfo.tags.includes('printoptions:no-header') || pageInfo.tags.includes('printoptions:no-header-title')
    );
    // TOOD: re-evaluate
    if (pageInfo.url.includes('Wakim_and_Grewal')) {
      await page.addStyleTag({ content: `.mt-content-container {font-size: 93%}` });
    }
    await page.addStyleTag({
      content: `
        @page {
          size: letter portrait;
          margin: ${showHeaders ? `${pdfPageMargins};` : '0.625in;'}
          padding: 0;
        }
        ${pdfTOCStyles}
      `,
    });

    const path = await this.generatePageOutputFileName({
      bookID: {
        lib: pageInfo.lib,
        pageID: pageInfo.id,
      },
      outFileNameOverride,
    });
    await page.pdf({
      // Letter Margin
      path,
      displayHeaderFooter: showHeaders,
      headerTemplate: generatePDFHeader(ImageConstants['default']),
      footerTemplate: generatePDFFooter({
        currentPage: pageInfo,
        mainColor: '#127BC4',
        pageLicense: pageInfo.license,
        prefix,
      }),
      printBackground: true,
      preferCSSPageSize: true,
      timeout: this.pageLoadSettings.timeout,
    });
    this.logger.withMetadata({ url: pageInfo.url }).info('Converted page.');
    if (!page.isClosed()) await page.close();
    return path;
  }

  public async convertPages(pages: BookPageInfo[]) {
    const outPaths: string[] = [];
    for (const page of pages) {
      const path = await this.convertPage({ pageInfo: page });
      outPaths.push(path);
    }
    return outPaths;
  }

  private async mergeFiles(
    files: string[],
    metadata?: {
      author: string;
      isContent?: boolean;
      isPreview?: boolean;
      title: string;
    },
  ) {
    const outputDocument = await PDFDocument.create();
    for (const filePath of files) {
      const file = await fs.readFile(filePath);
      const filePDF = await PDFDocument.load(file);
      const filePages = await outputDocument.copyPages(filePDF, filePDF.getPageIndices());
      for (let j = 0, k = filePages.length; j < k; j += 1) {
        outputDocument.addPage(filePages[j]);
      }
    }

    if (metadata?.title) {
      let pdfTitle = metadata.title;
      if (metadata?.isPreview) {
        pdfTitle = `${pdfTitle} (Preview)`;
      } else if (metadata?.isContent) {
        pdfTitle = `${pdfTitle} (Inner Content)`;
      }
      outputDocument.setTitle(pdfTitle);
    }
    if (metadata?.author) outputDocument.setAuthor(metadata.author);

    outputDocument.setProducer('LibreTexts Shapeshift');
    outputDocument.setCreator('LibreTexts (libretexts.org)');
    outputDocument.setCreationDate(new Date());
    return outputDocument.save();
  }

  public async mergePagesAndWrite({ bookID, pages }: { bookID: BookID; pages: string[] }) {
    const sortedPages = Array.from(pages).sort((a, b) =>
      a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }),
    );
    const mergedRaw = await this.mergeFiles(sortedPages);
    const outPath = await this.generateFinalOutputFileName({ bookID });
    await fs.writeFile(outPath, mergedRaw);
    return outPath;
  }

  private async getLevel(pageInfo: BookPageInfo, level = 2, isSubTOC?: boolean): Promise<string> {
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
    const twoColumn =
      pageInfo.tags?.includes('columns:two') &&
      (pageInfo.tags?.includes('coverpage:yes') || pageInfo.tags?.includes('coverpage:nocommons')) &&
      level === 2;
    const prefix = level === 2 ? 'h2' : 'h';
    // Get subtitles
    const innerRaw = await Promise.all(
      pages.map(async (elem) => {
        // if (elem.modified === 'restricted') return ''; // private page - FIXME
        const isSubtopic = level > 2 ? `indent${level - 2}` : null;
        const subPageDir = await this.getLevel(elem, level + 1, resolvedIsSubTOC);
        const subListSpacing = subPageDir?.length > 0 ? `libre-print-sublisting${level - 2}` : '';
        if (!elem.url || !elem.title) return '';
        return `<li><div class="nobreak ${isSubtopic} ${subListSpacing}"><${prefix}><a href="${elem.url}">${elem.title}</a></${prefix}></div>${subPageDir}</li>`;
      }),
    );
    const inner = innerRaw.join('');
    return `<ul class='libre-print-list' ${twoColumn ? 'style="column-count: 2;"' : ''}>${inner}</ul>`;
  }

  private async processDirectoryPage({ listing, tags, title }: { listing: string; tags: string[]; title: string }) {
    const directory = document.querySelector('.mt-guide-content, .mt-category-container');
    if (!directory) return;
    const newDirectory = document.createElement('div');
    newDirectory.innerHTML = listing;
    newDirectory.classList.add('libre-print-directory');
    directory.replaceWith(newDirectory);
    if (!tags?.length) return;
    const pageType =
      tags.includes('coverpage:yes') || tags.includes('coverpage:nocommons') || title?.includes('Table of Contents')
        ? 'Table of Contents' // server-side TOC generation (deprecated)
        : tags.includes('article:topic-guide')
          ? 'Chapter Overview'
          : 'Section Overview';

    const pageTitle = document.querySelector('#title');
    const pageTitleParent = pageTitle?.parentNode;
    if (!pageTitle || !pageTitleParent) return;
    pageTitle.setAttribute('style', 'border-bottom: none !important');
    const newTitle = document.createElement('h1');
    newTitle.appendChild(document.createTextNode(pageType));
    newTitle.id = 'libre-print-directory-header';

    const typeContainer = document.createElement('div');
    typeContainer.id = 'libre-print-directory-header-container';
    typeContainer.appendChild(newTitle);
    pageTitleParent.insertBefore(typeContainer, pageTitle);
    if (pageType === 'Table of Contents') pageTitle.remove();
  }

  private async generateCover({
    bookInfo,
    numPages,
    opt,
  }: {
    bookInfo: BookPageInfo;
    numPages: number;
    opt?: PDFCoverOpts;
  }) {
    const dirPath = await this.ensureCoversDirectory({ lib: bookInfo.lib, pageID: bookInfo.id });

    // options.thin || numPages < 32
    const browser = await this.getBrowser();
    const page = await browser.newPage();
    const content = '';
    await page.setContent(content, { waitUntil: ['load', 'domcontentloaded', 'networkidle0'] });
    await page.pdf({
      path: `${dirPath}/`,
      printBackground: true,
      width: numPages ? `${this.getCoverWidth({ numPages, opt })} in` : '8.5 in',
      height: numPages ? (opt?.hardcover ? '12.75 in' : '11.25 in') : '11 in',
      timeout: this.pageLoadSettings.timeout,
    });
    await page.close();
  }

  private getCoverSpineWidth({ numPages, opt }: { numPages: number; opt?: PDFCoverOpts }) {
    const sizes: Record<string, number | null> = {
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
    if (opt?.thin) return 0;
    if (opt && !opt.extraPadding) return numPages * 0.002252; // Amazon side
    if (opt?.hardcover) {
      const res = Object.entries(sizes).reduce(
        (acc, [k, v]) => {
          if (numPages > parseInt(k)) return v;
          return acc;
        },
        null as number | null,
      );
      if (res) return res;
    }

    const baseWidth = numPages / 444 + 0.06;
    return Math.floor(baseWidth * 1000) / 1000;
  }

  private getCoverWidth({ numPages, opt }: { numPages: number; opt?: PDFCoverOpts }) {
    const sizes: Record<string, number | null> = {
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
      '388': 1.1875,
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
    if (opt?.thin) return 17.25;
    if (opt && !opt.extraPadding) return numPages * 0.002252 + 0.375 + 17; // Amazon size
    if (opt?.hardcover) {
      const res = Object.entries(sizes).reduce(
        (acc, [k, v]) => {
          if (numPages > parseInt(k)) return v;
          return acc;
        },
        null as number | null,
      );
      if (res) return res + 18.75;
    }

    const baseWidth = numPages / 444 + 0.06 + 17.25;
    return Math.floor(baseWidth * 1000) / 1000;
  }

  private async generateTableOfContents({
    pageInfo,
    outFileNameOverride,
  }: {
    pageInfo: BookPageInfo;
    outFileNameOverride?: string;
  }) {
    this.logger.withMetadata({ url: pageInfo.url }).info('Starting Table of Contents');
    let pageURL = pageInfo.url;
    const isMainTOC = pageInfo.tags.includes('coverpage:yes') || pageInfo.tags.includes('coverpage:nocommons');
    if (isMainTOC) {
      pageURL = `${pageURL}${pageURL.endsWith('/') ? '' : '/'}00:_Front_Matter/03:_Table_of_Contents`;
      /*
      TODO: create the toc here
       */
    }

    await CXOneRateLimiter.waitUntilAPIAvailable(2);
    const browser = await this.getBrowser();
    const page = await browser.newPage();
    await page.setViewport(this.viewportSettings);
    await page.setRequestInterception(true);
    page.on('dialog', this.dialogHandler);
    page.on('request', this.requestHandler);
    await page.goto(`${pageURL}?no-cache`, this.pageLoadSettings);
    await page.$$eval('img', this.eagerImageLoader);
    await page.$$eval('details', this.detailsOpener);
    await sleep(1000);

    if (!isMainTOC) {
      const listing = await this.getLevel(pageInfo);
      await page.evaluate(this.processDirectoryPage, { listing, tags: pageInfo.tags, title: pageInfo.title });
      await sleep(1000);
    }

    const path = await this.generatePageOutputFileName({
      bookID: {
        lib: pageInfo.lib,
        pageID: pageInfo.id,
      },
      outFileNameOverride,
    });
    const styleTag = `
      @page {
        size: letter portrait;
        margin: ${pdfPageMargins};
        padding: 0;
      }
      ${!isMainTOC ? pdfTOCStyles : ''}
    `;
    await page.addStyleTag({ content: styleTag });
    await page.pdf({
      // Letter Margin
      path,
      displayHeaderFooter: true,
      headerTemplate: generatePDFHeader(ImageConstants['default']),
      footerTemplate: generatePDFFooter({
        currentPage: pageInfo,
        mainColor: '#127BC4',
        pageLicense: pageInfo.license,
        prefix: '',
      }),
      printBackground: true,
      preferCSSPageSize: true,
      timeout: this.pageLoadSettings.timeout,
    });
    if (!page.isClosed()) await page.close();
    this.logger.withMetadata({ url: pageInfo.url }).info('Finished Table of Contents.');
    return path;
  }

  private async generateMatter({ mode, pageInfo }: { mode: 'back' | 'front'; pageInfo: BookPageInfo }) {
    // TODO
  }
}
