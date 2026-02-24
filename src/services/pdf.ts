import fs from 'node:fs/promises';
import { v4 as uuid } from 'uuid';
import { join, resolve } from 'node:path';
import { pdfIgnoreList } from '../util/ignoreLists';
import {
  generatePDFBackCoverContent,
  generatePDFCoverStyles,
  generatePDFFooter,
  generatePDFFrontCoverContent,
  generatePDFHeader,
  generatePDFSpineContent,
  pdfPageMargins,
  pdfTOCStyles,
} from '../util/pdfHelpers';
import { ImageConstants } from '../util/imageConstants';
import { isNullOrUndefined, sleep } from '../helpers';
import { log as logService } from '../lib/log';
import { CXOneRateLimiter } from '../lib/cxOneRateLimiter';
import { PDFDocument } from 'pdf-lib';
import { LogLayer } from 'loglayer';
import { Environment } from '../lib/environment';
import { StorageService } from '../lib/storageService';
import { getDirectoryPathFromFilePath } from '../util/fsHelpers';
import Prince from 'prince';
import { BookPageInfo, BookPageInfoWithContent } from '../types/book';
import PageID from '../util/pageID';
import { PDF_COVER_WIDTHS } from '../lib/constants';
import * as cheerio from 'cheerio';

export type PDFCoverOpts = {
  extraPadding?: boolean;
  hardcover?: boolean;
  thin?: boolean;
};

const pdfCoverTypes = ['Amazon', 'CaseWrap', 'CoilBound', 'Main', 'PerfectBound'] as const;
type PDFCoverType = (typeof pdfCoverTypes)[number];

type ConversionTask = {
  _id: string;
  pageID: PageID;
  pageInfo: BookPageInfoWithContent;
  fileName: string;
  type: 'page' | 'toc';
};

const RETRY_CONFIG = {
  maxAttempts: 3,
  initialDelayMs: 1000,
  maxDelayMs: 10000,
  backoffMultiplier: 2,
};

const CIRCUIT_BREAKER_CONFIG = {
  maxConsecutiveFailures: 5,
  maxJobDurationMs: 4 * 60 * 60 * 1000, // 4 hours
};

export class PDFService {
  private _bookID!: PageID;
  private _useLocalStorage: boolean = false;
  private _convertedPagePaths: string[] = [];
  private readonly logger: LogLayer;
  private readonly logName = 'PDFService';
  private readonly storageService: StorageService;

  constructor(bookID: PageID, opts: { useLocalStorage?: boolean } = {}) {
    this._bookID = bookID;
    this._useLocalStorage = opts.useLocalStorage ?? false;

    if (!bookID || !(bookID instanceof PageID)) {
      throw new Error('Book ID is required and must be a valid PageID instance');
    }

    this.logger = logService.child().withContext({ logSource: this.logName });
    this.storageService = new StorageService();
  }

  /**
   * Converts the HTML of a book to a PDF, including generating covers and front/back matter if missing.
   * Implements retry logic with exponential backoff for robustness, and a circuit breaker to prevent runaway jobs. The conversion process is as follows:
   * 1. Build a list of conversion tasks for each page, ensuring correct ordering and TOC placement.
   * 2. For each task, attempt to convert the page to PDF with retries. If a task fails after all retries, the entire conversion process is aborted.
   * 3. If all pages are converted succesfully, create the covers
   * 4. Merge all converted pages and covers into a final PDF, which is then uploaded to storage or saved locally based on configuration.
   * @param pages
   * @returns
   */
  public async convertBook(pages: BookPageInfoWithContent[]): Promise<string> {
    const startTime = Date.now();
    const pagesMap = new Map(pages.map((c) => [c.pageID.toString(), c] as [string, BookPageInfoWithContent]));

    try {
      // Build conversion tasks with correct ordering and TOC placement
      const conversionTasks = this.buildTaskList(pages);
      this.logger.withMetadata({ totalTasks: conversionTasks.length }).info('Built conversion task list');

      let processedPageCount = 0;
      let consecutiveFailures = 0;

      for (const task of conversionTasks) {
        // Check job timeout
        if (Date.now() - startTime > CIRCUIT_BREAKER_CONFIG.maxJobDurationMs) {
          throw new Error('Job exceeded maximum duration (4 hours)');
        }

        if (consecutiveFailures >= CIRCUIT_BREAKER_CONFIG.maxConsecutiveFailures) {
          throw new Error('Job failed due to too many consecutive page conversion failures');
        }

        this.logger
          .withMetadata({
            current: processedPageCount + 1,
            total: pages.length,
          })
          .info('Processing page');

        // Get the actual HTML content
        const content = pagesMap.get(task.pageID.toString());
        if (!content) {
          // This should never happen since we built the task list from the same pages, but we check just in case
          throw new Error(`Missing HTML content for pageID: ${task.pageID.toString()}`);
        }

        // Convert the page with retry logic
        const convertFn = async () => {
          if (task.type === 'toc') {
            return await this.generateTableOfContents({
              pageInfo: task.pageInfo,
            });
          } else {
            return await this.convertPage({
              pageID: task.pageID,
              pageBodyHTML: task.pageInfo.body.join(''),
            });
          }
        };

        const result = await this.retryWithBackoff(convertFn, `Convert ${task.type}: ${task.pageInfo.url}`);

        if (result.success) {
          this._convertedPagePaths.push(result.result!);
          processedPageCount++;
          consecutiveFailures = 0; // reset on success
        } else {
          // If a task fails after all retries, increment the consecutive failure count
          // if more tasks completely fail than the threshold allows, the circuit breaker will trip and abort the job completely
          consecutiveFailures++;
          this.logger.withMetadata({ error: result.error, pageID: task.pageID }).error('Task failed after all retries');
        }
      }

      // All pages converted successfully, merge and generate covers
      this.logger.info('All pages converted, merging content');
      const contentFilePath = await this.mergeContentPagesAndWrite();

      const numPages = await this.calculateNumPagesInPDFDocument(contentFilePath);

      // Generate covers with retry
      this.logger.info('Generating covers');
      const coverConfigs = [
        { coverType: 'Amazon' as PDFCoverType, numPages },
        {
          coverType: 'CaseWrap' as PDFCoverType,
          numPages,
          opt: { extraPadding: true, hardcover: true },
        },
        {
          coverType: 'CoilBound' as PDFCoverType,
          numPages,
          opt: { extraPadding: true, thin: true },
        },
        { coverType: 'Main' as PDFCoverType, numPages: null },
        {
          coverType: 'PerfectBound' as PDFCoverType,
          numPages,
          opt: { extraPadding: true },
        },
      ];

      // TODO: does pages contain the cover page or only true content pages?
      const coverPageInfo = pagesMap.get(this._bookID.toString());

      const coverResults = await Promise.allSettled(
        coverConfigs.map(async (config) => {
          const result = await this.retryWithBackoff(
            async () =>
              await this.generateCover({
                bookInfo: coverPageInfo!,
                coverType: config.coverType,
                numPages: config.numPages,
                opt: config.opt,
              }),
            `Generate cover: ${config.coverType}`,
          );
          if (!result.success) {
            this.logger
              .withMetadata({
                coverType: config.coverType,
                error: result.error,
              })
              .error('Cover generation failed after retries');
          }
          return result;
        }),
      );

      const failedCovers = coverResults.filter((r) => r.status === 'rejected').length;

      if (failedCovers > 0) {
        throw new Error('One or more covers failed to generate after all retries');
      }

      this.logger
        .withMetadata({
          duration: Date.now() - startTime,
          totalPages: pages.length,
        })
        .info('Book conversion completed successfully');

      return contentFilePath;
    } catch (error) {
      this.logger.withMetadata({ error, duration: Date.now() - startTime }).error('Book conversion failed');
      throw error;
    }
  }

  private async retryWithBackoff<T>(
    operation: () => Promise<T>,
    context: string,
  ): Promise<{ success: boolean; result?: T; error?: Error }> {
    let lastError: Error | null = null;
    for (let attempt = 1; attempt <= RETRY_CONFIG.maxAttempts; attempt++) {
      try {
        const result = await operation();
        if (attempt > 1) {
          this.logger.withMetadata({ context, attempt }).info('Operation succeeded after retry');
        }
        return { success: true, result };
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        this.logger
          .withMetadata({ context, attempt, error: lastError.message })
          .warn(`Operation failed, attempt ${attempt}/${RETRY_CONFIG.maxAttempts}`);

        if (attempt < RETRY_CONFIG.maxAttempts) {
          const delayMs = Math.min(
            RETRY_CONFIG.initialDelayMs * Math.pow(RETRY_CONFIG.backoffMultiplier, attempt - 1),
            RETRY_CONFIG.maxDelayMs,
          );
          await sleep(delayMs);
        }
      }
    }
    return { success: false, error: lastError || new Error('Unknown error') };
  }

  private async calculateNumPagesInPDFDocument(filePath: string): Promise<number> {
    const file = await fs.readFile(filePath);
    const filePDF = await PDFDocument.load(file);
    return filePDF.getPageCount();
  }

  private async generateContentOutputFilePath() {
    const baseDir = Environment.getOptional('TMP_OUT_DIR', './.tmp');
    const basePath = resolve(`${baseDir}/pdf/${this._bookID.toString()}`);
    const dirPath = join(basePath, 'workdir');
    const filePath = join(dirPath, `content_${this._bookID.toString()}.pdf`);

    // Ensure the dir exists before returning the file path
    await fs.mkdir(dirPath, { recursive: true });
    return filePath;
  }

  private async generatePageOutputFilePath(pageID: PageID) {
    const baseDir = Environment.getOptional('TMP_OUT_DIR', './.tmp');
    const basePath = resolve(`${baseDir}/pdf/${this._bookID.toString()}`);
    const dirPath = join(basePath, 'workdir');
    const filePath = join(dirPath, `${pageID.toString()}.pdf`);

    // Ensure the dir exists before returning the file path
    await fs.mkdir(dirPath, { recursive: true });

    return filePath;
  }

  private async convertPage({ pageID, pageBodyHTML }: { pageID: PageID; pageBodyHTML: string }) {
    try {
      // const listing = await this.getLevel(pageInfo);
      // if (listing) {
      //   await page.evaluate(this.processDirectoryPage, {
      //     listing,
      //     tags: pageInfo.tags,
      //     title: pageInfo.title,
      //   });
      //   await sleep(1000);
      // }
      // const foundPrefix = await page.evaluate(function (url) {
      //   const title = document.getElementById("title");
      //   if (!title) return "";
      //   const color = window.getComputedStyle(title).color;
      //   const innerText = title.innerText;
      //   title.innerHTML = `<a style="color:${color}; text-decoration: none" href="${url}">${innerText}</a>`;
      //   if (innerText?.includes(":")) {
      //     return innerText.split(":")[0];
      //   }
      //   return "";
      // }, pageInfo.url);
      // const prefix = foundPrefix ? `${foundPrefix}.` : "";

      // const showHeaders = !(
      //   pageInfo.tags.includes("printoptions:no-header") ||
      //   pageInfo.tags.includes("printoptions:no-header-title")
      // );
      // // TODO: re-evaluate
      // if (pageInfo.tags.includes("hidetop:solutions")) {
      //   await page.addStyleTag({
      //     content: "dd, dl {display: none;} h3 {font-size: 160%}",
      //   });
      // }
      // if (pageInfo.url.includes("Wakim_and_Grewal")) {
      //   await page.addStyleTag({
      //     content: `.mt-content-container {font-size: 93%}`,
      //   });
      // }
      // await page.addStyleTag({
      //   content: `
      //   @page {
      //     size: calc(8.5in - (0.75in + 0.9in)) calc(11in - 0.625in);
      //     margin: ${showHeaders ? `${pdfPageMargins};` : "0.625in;"}
      //     padding: 0;
      //     print-color-adjust: exact;
      //   }
      //   #elm-main-content {
      //     padding: 0 !important;
      //   }
      //   ${pdfTOCStyles}
      // `,
      // });

      const inputPath = await this.createTempFile(pageBodyHTML);
      const outputPath = await this.generatePageOutputFilePath(pageID);

      const prince = new Prince();
      await prince.inputs(inputPath).output(outputPath).execute();

      await this.deleteTempFile(inputPath); // Cleanup the temp file after conversion

      this.logger.withMetadata({ outputPath }).info('Converted page.');
      return outputPath;
    } catch (error) {
      this.logger.withMetadata({ error }).error('Page conversion failed');
      throw error;
    }
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

  private async mergeContentPagesAndWrite() {
    const extractFileName = (filePath: string) => {
      const split = filePath.split('/');
      return split[split.length - 1];
    };

    const isSplittable = (filePath: string) => !!filePath.split('/').length;
    const sortedPages = this._convertedPagePaths
      .filter((p) => isSplittable(p))
      .sort((aRaw, bRaw) => {
        const a = extractFileName(aRaw);
        const b = extractFileName(bRaw);
        return a.localeCompare(b, undefined, {
          numeric: true,
          sensitivity: 'base',
        });
      });

    const mergedRaw = await this.mergeFiles(sortedPages);
    const outPath = await this.generateContentOutputFilePath();

    if (!this._useLocalStorage) {
      await this.storageService.uploadFile({
        contentType: 'application/pdf',
        data: Buffer.from(mergedRaw),
        key: outPath,
      });
    } else {
      // Ensure directory exists before writing
      const dirPath = getDirectoryPathFromFilePath(outPath);
      await fs.mkdir(dirPath, { recursive: true });

      // Write file to local storage
      await fs.writeFile(outPath, mergedRaw);
    }
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

  private processDirectoryPage({
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
    const $ = cheerio.load(html);

    const directory = $('.mt-guide-content, .mt-category-container');
    if (!directory) return null;

    // Create a new directory element with the listing HTML and replace the existing directory content
    const newDirectory = $('<div></div>');
    newDirectory.html(listing);
    newDirectory.addClass('libre-print-directory');
    directory.replaceWith(newDirectory);

    if (!tags?.length) return null;
    const pageType =
      tags.includes('coverpage:yes') || tags.includes('coverpage:nocommons') || title?.includes('Table of Contents')
        ? 'Table of Contents' // server-side TOC generation (deprecated)
        : tags.includes('article:topic-guide')
          ? 'Chapter Overview'
          : 'Section Overview';

    const pageTitle = $('#title');

    const pageTitleParent = pageTitle?.parent();
    if (!pageTitle || !pageTitleParent) return null;
    pageTitle.css('style', 'border-bottom: none !important');

    const newTitle = $('<h1></h1>').text(pageType).attr('id', 'libre-print-directory-header');

    const typeContainer = $('<div></div>').attr('id', 'libre-print-directory-header-container');
    typeContainer.append(newTitle);

    // insert pageTitleParent before the typeConatiner
    // TODO: is this layout correct?
    pageTitleParent.insertBefore(typeContainer);

    if (pageType === 'Table of Contents') pageTitle.remove();

    // return the updated HTML
    return $.html();
  }

  private async generateCover({
    bookInfo,
    coverType,
    numPages,
    opt,
  }: {
    bookInfo: BookPageInfo;
    coverType: PDFCoverType;
    numPages: number | null;
    opt?: PDFCoverOpts;
  }) {
    try {
      const dirPath = await this.ensureCoversDirectory();

      const spineWidth = this.getCoverSpineWidth({ numPages, opt });
      const width = this.getCoverWidth({ numPages, opt });
      const frontContent = generatePDFFrontCoverContent(bookInfo);
      const backContent = generatePDFBackCoverContent(bookInfo);
      const spine = generatePDFSpineContent({
        currentPage: bookInfo,
        opt,
        spineWidth,
        width,
      });
      const styles = generatePDFCoverStyles({ currentPage: bookInfo, opt });

      const baseContent = numPages
        ? `${styles}${backContent}${opt?.thin ? '' : spine}${frontContent}`
        : `${styles}${frontContent}`;
      const content = `
      ${baseContent}
      ${
        opt?.extraPadding
          ? `
          <style>
            #frontContainer, #backContainer {
              padding: 117px 50px;
            }
            #spine {
              padding: 117px 0;
            }
          </style>`
          : ''
      }
    `;

      //TODO: here's where we'll generate the full HTML of the cover, including spine if needed, and then convert that to PDF.
      // This will likely involve creating a temporary HTML file and using Prince to convert to PDF
      // with the correct dimensions based on the number of pages and cover type.

      // await page.pdf({
      //   path: `${dirPath}/${coverType}.pdf`,
      //   printBackground: true,
      //   width: numPages
      //     ? `${this.getCoverWidth({ numPages, opt })} in`
      //     : "8.5 in",
      //   height: numPages ? (opt?.hardcover ? "12.75 in" : "11.25 in") : "11 in",
      //   timeout: this.pageLoadSettings.timeout,
      // });
      this.logger.withMetadata({ coverType, url: bookInfo.url }).info('Generated cover.');
    } catch (error) {
      this.logger.withMetadata({ coverType, url: bookInfo.url, error }).error('Cover generation failed');
      throw error;
    }
  }

  private getCoverSpineWidth({ numPages, opt }: { numPages: number | null; opt?: PDFCoverOpts }) {
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

  private getCoverWidth({ numPages, opt }: { numPages: number | null; opt?: PDFCoverOpts }) {
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

  private async generateTableOfContents({ pageInfo }: { pageInfo: BookPageInfoWithContent }) {
    try {
      this.logger.withMetadata({ url: pageInfo.url }).info('Starting Table of Contents');

      let pageURL = pageInfo.url;
      const isMainTOC = pageInfo.tags.includes('coverpage:yes') || pageInfo.tags.includes('coverpage:nocommons');
      if (isMainTOC) {
        pageURL = `${pageURL}${pageURL.endsWith('/') ? '' : '/'}00:_Front_Matter/03:_Table_of_Contents`;
        /*
      TODO: create the maintoc here, write it to temp file, convert to PDF, and return the path.
       */
      } else {
        const listing = await this.getLevel(pageInfo);
        const updatedHTML = this.processDirectoryPage({
          html: pageInfo.body.join(''),
          listing,
          tags: pageInfo.tags,
          title: pageInfo.title,
        });

        if (!updatedHTML) {
          this.logger.withMetadata({ url: pageInfo.url }).warn('Failed to process directory page for TOC');

          return null;
        }

        // Now we can just convert this page like normal since the HTML is updated with the listing content. The main difference is that we need to ensure the correct styles are applied for the TOC, which may involve including the pdfTOCStyles in the HTML.
        const outputPath = await this.convertPage({
          pageID: pageInfo.pageID,
          pageBodyHTML: updatedHTML,
        });

        //FIXME: figure out how we're going to do this without puppeteer.
        //We may need to create a temporary HTML file with the TOC content and then use Prince to convert it to PDF, similar to how we convert regular pages.
        // The main difference is that we need to ensure the correct styles are applied for the TOC, which may involve including the pdfTOCStyles in the HTML.
        //   const styleTag = `
        //   @page {
        //     size: letter portrait;
        //     margin: ${pdfPageMargins};
        //     padding: 0;
        //   }
        //   ${!isMainTOC ? pdfTOCStyles : ""}
        // `;

        //   await page.addStyleTag({ content: styleTag });
        //   await page.pdf({
        //     // Letter Margin
        //     path,
        //     displayHeaderFooter: true,
        //     headerTemplate: generatePDFHeader(ImageConstants["default"]),
        //     footerTemplate: generatePDFFooter({
        //       currentPage: null,
        //       mainColor: "#127BC4",
        //       pageLicense: null,
        //       prefix: "",
        //     }),
        //     printBackground: true,
        //     preferCSSPageSize: true,
        //     timeout: this.pageLoadSettings.timeout,
        //   });

        this.logger.withMetadata({ url: pageInfo.url }).info('Finished Table of Contents.');
        return outputPath;
      }
    } catch (error) {
      this.logger.withMetadata({ url: pageInfo.url, error }).error('Table of Contents generation failed');
      throw error;
    }
  }

  /**
   * Returns a flat list of conversion tasks in the correct order for PDF generation, including TOC placement.
   * The TOC is placed before the first page that has more than 1 subpage and is tagged as either "article:topic-category" or "article:topic-guide",
   * but after any front matter. Back matter pages are placed at the end. If there are no suitable pages for TOC placement, the TOC will be placed at the end before back matter.
   * @param pages - The flat list of pages with content to be converted, which will be organized into a task list with correct ordering and TOC placement.
   * @returns An array of conversion tasks in the correct order for PDF generation.
   */
  private buildTaskList(pages: BookPageInfoWithContent[]): Array<ConversionTask> {
    const conversionTasks: Array<ConversionTask> = [];
    let backMatterIdx = 0;
    let frontMatterIdx = 0;

    // Process flat array with correct ordering and TOC placement
    for (const p of pages) {
      const idx = `${conversionTasks.length + 1}`.padStart(4, '0');

      if (
        Array.isArray(p.subpages) &&
        p.subpages.length > 1 &&
        (p.tags.includes('article:topic-category') || p.tags.includes('article:topic-guide')) &&
        !['Back Matter', 'Front Matter'].some((t) => p.title.includes(t))
      ) {
        conversionTasks.push({
          _id: `toc-${p.pageID}`,
          pageID: p.pageID,
          pageInfo: p,
          fileName: `${idx}_TOC`,
          type: 'toc',
        });
      } else {
        let idxPrefix = idx;
        if (p.matterType === 'Front') {
          frontMatterIdx += 1;
          idxPrefix = `0000:${frontMatterIdx}`;
        }
        if (p.matterType === 'Back') {
          backMatterIdx += 1;
          idxPrefix = `9999:${backMatterIdx}`;
        }

        if (!['Back Matter', 'Front Matter'].some((t) => p.title.includes(t))) {
          conversionTasks.push({
            _id: `page-${p.pageID}`,
            pageID: p.pageID,
            pageInfo: p,
            fileName: `${idxPrefix}_${p.pageID}`,
            type: 'page',
          });
        }
      }
    }

    return conversionTasks.sort((a, b) => a.fileName.localeCompare(b.fileName, undefined, { numeric: true }));
  }

  private async ensureCoversDirectory() {
    // FIXME: are we storing cover in temp storage and handling final disposition in Job or
    // should we upload directly to final storage here?
    // If we upload here, we can stream the PDF generation directly to storage instead of writing to local disk first
    const baseDir = Environment.getOptional('TMP_OUT_DIR', './.tmp');
    const dirPath = resolve(`${baseDir}/pdf/${this._bookID.toString()}/covers`);
    await fs.mkdir(dirPath, { recursive: true });
    return dirPath;
  }

  private async createTempFile(content: string) {
    const id = uuid();
    const tempDir = resolve('.tmp');
    await fs.mkdir(tempDir, { recursive: true });
    const tempFilePath = join(tempDir, `${id}.html`);
    await fs.writeFile(tempFilePath, content);
    return tempFilePath;
  }

  private async deleteTempFile(filePath: string) {
    try {
      await fs.unlink(filePath);
    } catch (error) {
      this.logger.withMetadata({ filePath, error }).warn('Failed to delete temp file. Was it already deleted?');
    }
  }
}
