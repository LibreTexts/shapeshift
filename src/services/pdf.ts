import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { v4 as uuid } from 'uuid';
import { join, resolve } from 'node:path';
import {
  generatePDFCoverHTML,
  generatePDFHeader,
  generatePDFFooter,
  generateFontCSS,
  PDF_COVER_TYPES,
  pdfTOCStyles,
  pdfHeaderCSS,
  pdfFooterCSS,
} from '../util/pdfHelpers';
import { ImageConstants } from '../util/imageConstants';
import { sleep } from '../helpers';
import { log as logService } from '../lib/log';
// import { CXOneRateLimiter } from '../lib/cxOneRateLimiter';
import { PDFDocument } from 'pdf-lib';
import { LogLayer } from 'loglayer';
import { Environment } from '../lib/environment';
import { StorageService } from '../lib/storageService';
import { getDirectoryPathFromFilePath } from '../util/fsHelpers';
import Prince from 'prince';
import { BookPageInfo, BookPages } from '../types/book';
import PageID from '../util/pageID';
// import { PDF_COVER_WIDTHS } from '../lib/constants';
import * as cheerio from 'cheerio';
import { PDFCoverOpts, PDFCoverType } from '../types/pdf';
import { prerenderMath, stripMathJaxScripts } from '../util/mathjax';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// CSS loaded at module init and inlined into HTML sent to Prince.
// Note: changes to this file require a server restart in development.
const pdfPageCSS = readFileSync(join(__dirname, '../styles/pdf-page.css'), 'utf-8');
const pdfFontCSS = generateFontCSS();

/**
 * Canonical configuration for each cover type.
 * `opt` contains the styling flags passed to the cover generator.
 * `usesPageCount` indicates whether the cover dimensions depend on the content page count
 * (false only for 'Main', which is a single front-only cover at a fixed size).
 */
export const COVER_TYPE_CONFIG: Record<PDFCoverType, { opt?: PDFCoverOpts; usesPageCount: boolean }> = {
  Amazon: { usesPageCount: true },
  CaseWrap: { opt: { extraPadding: true, hardcover: true }, usesPageCount: true },
  CoilBound: { opt: { extraPadding: true, thin: true }, usesPageCount: true },
  Main: { usesPageCount: false },
  PerfectBound: { opt: { extraPadding: true }, usesPageCount: true },
};

type ConversionTask = {
  _id: string;
  pageID: PageID;
  pageInfo: BookPageInfo;
  fileName: string;
  sortKey: string;
  subtype?: 'main-toc';
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
  public async convertBook(pagesInput: BookPages): Promise<string | null> {
    if (!pagesInput?.flat?.length) return null;
    const { flat: pages } = pagesInput;
    const startTime = Date.now();
    const pagesMap = new Map(pages.map((c) => [c.pageID.toString(), c] as [string, BookPageInfo]));

    try {
      const preflightOk = await this.runPreflightChecks();
      if (!preflightOk) {
        throw new Error('Preflight checks failed: Prince binary is not properly configured');
      }

      // Build conversion tasks with correct ordering and TOC placement
      const conversionTasks = this.buildTaskList(pagesInput);
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
              isMainTOC: task.subtype === 'main-toc',
              sortKey: task.sortKey,
            });
          } else {
            return await this.convertPage({
              pageID: task.pageID,
              pageInfo: task.pageInfo,
              pageBodyHTML: task.pageInfo.body.join(''),
              pageHeadHTML: task.pageInfo.head,
              pageTailHTML: task.pageInfo.tail,
              sortKey: task.sortKey,
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
      const coverConfigs = PDF_COVER_TYPES.map((coverType) => ({
        coverType,
        numPages: COVER_TYPE_CONFIG[coverType].usesPageCount ? numPages : null,
        opt: COVER_TYPE_CONFIG[coverType].opt,
      }));

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
            const errorMessage = result.error instanceof Error ? result.error.message : JSON.stringify(result.error);
            this.logger
              .withMetadata({
                coverType: config.coverType,
                error: result.error,
                errorMessage,
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

  /**
   * Checks that a Prince binary is accessible and executable at the specified path (either from environment variable or default location).
   * This is a preflight check that should be run before attempting any conversions to fail fast if the binary is not properly configured.
   * @returns True if a Prince binary is accessible and executable, false otherwise.
   */
  private async runPreflightChecks(): Promise<boolean> {
    const princeBinaryLocalPath = Environment.getOptional('PRINCE_BINARY_PATH', '');
    if (princeBinaryLocalPath) {
      try {
        await fs.access(princeBinaryLocalPath, fs.constants.X_OK);
        return true;
      } catch (error) {
        this.logger
          .withMetadata({ path: princeBinaryLocalPath, error })
          .error('PRINCE_BINARY_PATH is set but the binary is not accessible or executable at the specified path.');
        return false;
      }
    }

    // check if prince binary at node_modules/prince/bin/prince exists and is executable
    try {
      await fs.access(princeBinaryLocalPath, fs.constants.X_OK);
      return true;
    } catch (error) {
      this.logger
        .withMetadata({ path: princeBinaryLocalPath, error })
        .error(`Prince binary is not accessible or executable at path: ${princeBinaryLocalPath}`);
      return false;
    }
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

  private async generatePageOutputFilePath(pageID: PageID, sortKey: string) {
    const baseDir = Environment.getOptional('TMP_OUT_DIR', './.tmp');
    const basePath = resolve(`${baseDir}/pdf/${this._bookID.toString()}`);
    const dirPath = join(basePath, 'workdir');
    const filePath = join(dirPath, `${sortKey}_${pageID.toString()}.pdf`);

    // Ensure the dir exists before returning the file path
    await fs.mkdir(dirPath, { recursive: true });

    return filePath;
  }

  private async convertPage({
    pageID,
    pageInfo,
    pageBodyHTML,
    pageHeadHTML = '',
    pageTailHTML = '',
    additionalCSS,
    mainColor = '#127BC4',
    sortKey,
  }: {
    pageID: PageID;
    pageInfo: BookPageInfo;
    pageBodyHTML: string;
    pageHeadHTML?: string;
    pageTailHTML?: string;
    additionalCSS?: string;
    mainColor?: string;
    sortKey: string;
  }) {
    try {
      // Pre-render TeX math to inline SVG so Prince doesn't need to execute MathJax JS.
      // Strip CMS-provided MathJax <script> tags from head since they're now unnecessary.
      // Pass pageInfo to configure equation numbering based on page title (e.g., "4.2.1" for section 4.2)
      const renderedBodyHTML = await prerenderMath(pageBodyHTML, pageInfo);
      const cleanedHeadHTML = stripMathJaxScripts(pageHeadHTML);

      const headerHTML = generatePDFHeader(ImageConstants['default']);
      const footerHTML = generatePDFFooter({
        currentPage: pageInfo,
        mainColor,
        pageLicense: pageInfo.license,
        prefix: '',
      });

      // Wrap the page content in a complete HTML document with header/footer running elements.
      // Prince's running element CSS (in pdf-page.css) pulls #libre-pdf-header and
      // #libre-pdf-footer out of body flow and places them in the @page margin boxes.
      // pageTailHTML includes post-body scripts that must run after the content is in the DOM.
      const wrappedHTML = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style>${pdfFontCSS}</style>
  <style>${pdfPageCSS}</style>
  <style>${pdfHeaderCSS}</style>
  <style>:root { --pdf-main-color: ${mainColor}; }</style>
  <style>${pdfFooterCSS}</style>
  ${additionalCSS ? `<style>${additionalCSS}</style>` : ''}
  ${cleanedHeadHTML}
</head>
<body>
${headerHTML}
${footerHTML}
${renderedBodyHTML}
${pageTailHTML}
</body>
</html>
      `.trim();

      const outputPath = await this.generatePageOutputFilePath(pageID, sortKey);

      await this.withTempFile(wrappedHTML, (inputPath) => this.runPrinceConversion(inputPath, outputPath));

      this.logger.withMetadata({ outputPath }).info('Converted page.');
      return outputPath;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : JSON.stringify(error);
      this.logger.withMetadata({ error, errorMessage }).error('Page conversion failed');
      throw error;
    }
  }

  /**
   * Wrapper function to run Prince conversion with the configured binary path.
   * Allows us to abstract Prince initilization and execution in one place.
   * @param inputPath - path to the input HTML file to be converted
   * @param outputPath - desired path for the output PDF file
   */
  private async runPrinceConversion(inputPath: string, outputPath: string) {
    try {
      const prince = new Prince({
        binary: Environment.getOptional('PRINCE_BINARY_PATH', '') || undefined,
      });

      const result = await prince
        .option('verbose', true)
        .option('javascript', true)
        .inputs(inputPath)
        .output(outputPath)
        .execute();

      // Prince writes warnings and info messages to stderr even on success
      const stderr = result?.stderr?.toString?.()?.trim();
      if (stderr) {
        this.logger.withMetadata({ inputPath, outputPath, princeOutput: stderr }).debug('Prince output');
      }
    } catch (error) {
      // The prince npm wrapper rejects with { error, stdout, stderr }
      const princeError = error as { error?: unknown; stdout?: Buffer; stderr?: Buffer };
      const stderr = princeError?.stderr?.toString?.()?.trim();
      const errorMessage =
        princeError?.error instanceof Error
          ? princeError.error.message
          : typeof princeError?.error === 'string'
            ? princeError.error
            : JSON.stringify(error);
      this.logger
        .withMetadata({ inputPath, outputPath, errorMessage, princeOutput: stderr || undefined })
        .error('Prince conversion failed');
      throw new Error(`Prince conversion failed: ${errorMessage}`);
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
    const prefix = level === 2 ? 'h2' : 'span';
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
      const content = generatePDFCoverHTML({
        bookInfo,
        coverType,
        opt,
        numPages,
      });

      const outputPath = `${dirPath}/${coverType}.pdf`;

      await this.withTempFile(content, async (inputPath) => {
        this.logger.withMetadata({ coverType, url: bookInfo.url, inputPath, outputPath }).info('Generating cover...');
        await this.runPrinceConversion(inputPath, outputPath);
      });

      this.logger.withMetadata({ coverType, url: bookInfo.url, outputPath }).info('Generated cover.');
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : JSON.stringify(error);
      this.logger.withMetadata({ coverType, url: bookInfo.url, error, errorMessage }).error('Cover generation failed');
      throw error;
    }
  }

  private async generateTableOfContents({
    pageInfo,
    isMainTOC = false,
    sortKey,
  }: {
    pageInfo: BookPageInfo;
    isMainTOC?: boolean;
    sortKey: string;
  }) {
    try {
      this.logger.withMetadata({ url: pageInfo.url }).info('Starting Table of Contents');

      if (isMainTOC) {
        const listing = await this.getLevel(pageInfo);
        if (!listing) {
          this.logger.withMetadata({ url: pageInfo.url }).warn('Main TOC listing is empty, skipping conversion');
          return null;
        }

        const tocBodyHTML = `
          <div id="libre-print-directory-header-container">
            <h1 id="libre-print-directory-header">Table of Contents</h1>
          </div>
          <div class="libre-print-directory">
            ${listing}
          </div>
        `;

        const outputPath = await this.convertPage({
          pageID: pageInfo.pageID,
          pageInfo,
          pageBodyHTML: tocBodyHTML,
          additionalCSS: pdfTOCStyles,
          sortKey,
        });

        this.logger.withMetadata({ url: pageInfo.url }).info('Finished Main Table of Contents.');
        return outputPath;
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

        const outputPath = await this.convertPage({
          pageID: pageInfo.pageID,
          pageInfo,
          pageBodyHTML: updatedHTML,
          pageHeadHTML: pageInfo.head,
          pageTailHTML: pageInfo.tail,
          additionalCSS: pdfTOCStyles,
          sortKey,
        });

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
  private buildTaskList({ flat: pages, tree }: BookPages): Array<ConversionTask> {
    const conversionTasks: Array<ConversionTask> = [];
    let backMatterIdx = 0;
    let frontMatterIdx = 0;

    // Build a map from pageID → tree node so we can access subpages, which are stripped
    // from the flat array by flattenPagesObj.
    const treeMap = new Map<string, BookPageInfo>();
    const buildTreeMap = (node: BookPageInfo) => {
      treeMap.set(node.pageID.toString(), node);
      node.subpages?.forEach(buildTreeMap);
    };
    buildTreeMap(tree);

    // Process flat array with correct ordering and TOC placement
    for (const p of pages) {
      const idx = `${conversionTasks.length + 1}`.padStart(4, '0');
      //const treeNode = treeMap.get(p.pageID.toString());

      // The front matter "Table of Contents" page uses the root book hierarchy to generate
      // a full-book TOC. It outputs at the front matter position, replacing the CXOne template placeholder.
      if (p.matterType === 'Front' && p.title === 'Table of Contents') {
        frontMatterIdx += 1;
        const tocFileName = `0000:${frontMatterIdx}`;
        conversionTasks.push({
          _id: `toc-main`,
          pageID: p.pageID,
          pageInfo: tree, // root node carries the full hierarchy needed by getLevel()
          fileName: tocFileName,
          sortKey: tocFileName,
          subtype: 'main-toc',
          type: 'toc',
        });
        continue;
      }

      // TODO: Re-enable chapter/section TOC generation once main TOC placement is stable.
      // Chapter/section directory pages will eventually get their own TOC page at the start of each chapter.
      // if (
      //   treeNode &&
      //   Array.isArray(treeNode.subpages) &&
      //   treeNode.subpages.length > 1 &&
      //   (p.tags.includes('article:topic-category') || p.tags.includes('article:topic-guide')) &&
      //   !['Back Matter', 'Front Matter'].some((t) => p.title.includes(t)) &&
      //   p.pageID.toString() !== tree.pageID.toString() // guard: root book page TOC is handled by toc-main
      // ) {
      //   const chapterFileName = `${idx}_TOC`;
      //   conversionTasks.push({
      //     _id: `toc-${p.pageID}`,
      //     pageID: p.pageID,
      //     pageInfo: treeNode, // tree node retains subpages for getLevel()
      //     fileName: chapterFileName,
      //     sortKey: chapterFileName,
      //     type: 'toc',
      //   });
      //   continue;
      // }

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
        const pageFileName = `${idxPrefix}_${p.pageID}`;
        conversionTasks.push({
          _id: `page-${p.pageID}`,
          pageID: p.pageID,
          pageInfo: p,
          fileName: pageFileName,
          sortKey: pageFileName,
          type: 'page',
        });
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

  private async withTempFile<T>(content: string, fn: (path: string) => Promise<T>): Promise<T> {
    const path = await this._createTempFile(content);
    try {
      return await fn(path);
    } finally {
      await this._deleteTempFile(path);
    }
  }

  private async _createTempFile(content: string, fileName?: string) {
    const id = uuid();
    const tempDir = resolve('.tmp');
    await fs.mkdir(tempDir, { recursive: true });
    const tempFilePath = join(tempDir, fileName || `${id}.html`);
    await fs.writeFile(tempFilePath, content);
    return tempFilePath;
  }

  private async _deleteTempFile(filePath: string) {
    try {
      await fs.unlink(filePath);
    } catch (error) {
      this.logger.withMetadata({ filePath, error }).warn('Failed to delete temp file. Was it already deleted?');
    }
  }
}
