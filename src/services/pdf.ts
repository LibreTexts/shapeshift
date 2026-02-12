import fs from 'node:fs/promises';
import { v4 as uuid } from 'uuid';
import { join, resolve } from 'node:path';
import puppeteer, { Browser, Dialog, Viewport, HTTPRequest, GoToOptions } from 'puppeteer';
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
import { log, log as logService } from '../lib/log';
import { BookID, BookPageInfo } from './book';
import { CXOneRateLimiter } from '../lib/cxOneRateLimiter';
import { PDFDocument } from 'pdf-lib';
import { LogLayer } from 'loglayer';
import { Environment } from '../lib/environment';
import { StorageService } from '../lib/storageService';
import { getDirectoryPathFromFilePath } from '../util/fsHelpers';

export type PDFCoverOpts = {
  extraPadding?: boolean;
  hardcover?: boolean;
  thin?: boolean;
};

const pdfCoverTypes = ['Amazon', 'CaseWrap', 'CoilBound', 'Main', 'PerfectBound'] as const;
type PDFCoverType = (typeof pdfCoverTypes)[number];

type ConversionCheckpoint = {
  convertedPages: string[];
  lastProcessedPageId: string;
  totalPagesProcessed: number;
  consecutiveFailures: number;
  timestamp: Date;
};

type ConversionOptions = {
  forceRestart?: boolean;
  jobId?: string;
  onProgress?: (progress: { current: number; total: number; status: string }) => void;
};

type ConversionTask = {
  pageInfo: BookPageInfo;
  fileName: string;
  type: 'page' | 'toc';
  id: string;
}

const RETRY_CONFIG = {
  maxAttempts: 3,
  initialDelayMs: 1000,
  maxDelayMs: 10000,
  backoffMultiplier: 2,
};

const CIRCUIT_BREAKER_CONFIG = {
  maxConsecutiveFailures: 3,
  maxJobDurationMs: 4 * 60 * 60 * 1000, // 4 hours
};

const BROWSER_RESTART_THRESHOLD = 50;

export class PDFService {
  private _browser: Browser | null = null;
  private _pagesProcessedCount: number = 0;
  private readonly logger: LogLayer;
  private readonly logName = 'PDFService';
  private readonly pageLoadSettings: GoToOptions = {
    timeout: 120000,
    waitUntil: ['load', 'domcontentloaded', 'networkidle0'],
  };
  private readonly storageService: StorageService;
  private readonly viewportSettings: Viewport = { width: 975, height: 1000 };

  constructor() {
    this.logger = logService.child().withContext({ logSource: this.logName });
    this.storageService = new StorageService();
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

  private async getBrowser(): Promise<Browser> {
    if (!this._browser) {
      this._browser = await puppeteer.launch({
        headless: true,
        args: ['--font-render-hinting=none', '--force-color-profile=sRGB', '--no-sandbox'],
      });
      log.debug("Using Puppeteer executable at: " + puppeteer.executablePath());
      log.debug("Puppeteer version: " + (await this._browser.version()));
    }
    return this._browser;
  }

  private async restartBrowser(): Promise<void> {
    this.logger.info('Restarting browser to prevent memory leaks');
    if (this._browser) {
      try {
        await this._browser.close();
      } catch (error) {
        this.logger.withMetadata({ error }).warn('Error closing browser during restart');
      }
      this._browser = null;
    }
    this._pagesProcessedCount = 0;
    await this.getBrowser();
  }

  private async ensureBrowserHealthy(): Promise<void> {
    if (this._pagesProcessedCount >= BROWSER_RESTART_THRESHOLD) {
      await this.restartBrowser();
    }
    try {
      const browser = await this.getBrowser();
      if (!browser.isConnected()) {
        this.logger.warn('Browser disconnected, restarting');
        await this.restartBrowser();
      }
    } catch (error) {
      this.logger.withMetadata({ error }).error('Browser health check failed, restarting');
      await this.restartBrowser();
    }
  }

  public async cleanup(): Promise<void> {
    this.logger.info('Cleaning up PDFService resources');
    if (this._browser) {
      try {
        await this._browser.close();
      } catch (error) {
        this.logger.withMetadata({ error }).warn('Error closing browser during cleanup');
      }
      this._browser = null;
    }
  }

  private async generatePageOutputFileName({
    bookID,
    outFileNameOverride,
    preferLocalStorage = false,
    useWorkdir = false,
  }: {
    bookID: BookID;
    outFileNameOverride?: string;
    preferLocalStorage?: boolean;
    useWorkdir?: boolean;
  }) {
    const baseDir = preferLocalStorage ? Environment.getOptional('TMP_OUT_DIR', './.tmp') : '';
    const basePath = resolve(`${baseDir}/pdf/${bookID.lib}-${bookID.pageID}`);
    const dirPath = useWorkdir ? join(basePath, 'workdir') : basePath;
    const fileName = outFileNameOverride ?? uuid();
    const filePath = join(dirPath, `${fileName}.pdf`);
    if (preferLocalStorage) await fs.mkdir(dirPath, { recursive: true });
    return filePath;
  }

  private async ensureCoversDirectory(bookID: BookID) {
    const tmpDir = Environment.getOptional('TMP_OUT_DIR', './.tmp');
    const dirPath = resolve(`${tmpDir}/pdf/${bookID.lib}-${bookID.pageID}/covers/`);
    await fs.mkdir(dirPath, { recursive: true });
    return dirPath;
  }

  private getCheckpointPath(bookID: BookID): string {
    const tmpDir = Environment.getOptional('TMP_OUT_DIR', './.tmp');
    return resolve(`${tmpDir}/pdf/${bookID.lib}-${bookID.pageID}/checkpoint.json`);
  }

  private async saveCheckpoint(bookID: BookID, checkpoint: ConversionCheckpoint): Promise<void> {
    const checkpointPath = this.getCheckpointPath(bookID);
    await fs.mkdir(resolve(checkpointPath, '..'), { recursive: true });
    await fs.writeFile(checkpointPath, JSON.stringify(checkpoint, null, 2));
    this.logger.withMetadata({ totalPagesProcessed: checkpoint.totalPagesProcessed }).debug('Checkpoint saved');
  }

  private async loadCheckpoint(bookID: BookID): Promise<ConversionCheckpoint | null> {
    const checkpointPath = this.getCheckpointPath(bookID);
    try {
      const data = await fs.readFile(checkpointPath, 'utf-8');
      const checkpoint = JSON.parse(data) as ConversionCheckpoint;
      this.logger.withMetadata({ totalPagesProcessed: checkpoint.totalPagesProcessed }).info('Checkpoint loaded');
      return checkpoint;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return null;
      }
      this.logger.withMetadata({ error }).warn('Error loading checkpoint');
      return null;
    }
  }

  private async clearCheckpoint(bookID: BookID): Promise<void> {
    const checkpointPath = this.getCheckpointPath(bookID);
    try {
      await fs.unlink(checkpointPath);
      this.logger.info('Checkpoint cleared');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.logger.withMetadata({ error }).warn('Error clearing checkpoint');
      }
    }
  }

  private async cleanupTempFiles(bookID: BookID): Promise<void> {
    const tmpDir = Environment.getOptional('TMP_OUT_DIR', './.tmp');
    const workdirPath = resolve(`${tmpDir}/pdf/${bookID.lib}-${bookID.pageID}/workdir`);
    this.logger.withMetadata({ workdirPath }).info('Cleaning up workdir');

    try {
      await fs.rm(workdirPath, { recursive: true, force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.logger.withMetadata({ error, workdirPath }).warn('Error deleting workdir');
      }
    }
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

  public async convertBook({
    bookID,
    pages,
    options = {},
  }: {
    bookID: BookID;
    pages: BookPageInfo;
    options?: ConversionOptions;
  }): Promise<string> {
    const startTime = Date.now();
    let consecutiveFailures = 0;
    const preferLocalStorage = Environment.getOptional('USE_LOCAL_STORAGE', 'false') === 'true';

    try {
      // Load or clear checkpoint
      let checkpoint: ConversionCheckpoint | null = null;
      if (options.forceRestart) {
        this.logger.info('Force restart requested, clearing checkpoint and temp files');
        await this.clearCheckpoint(bookID);
        await this.cleanupTempFiles(bookID);
      } else {
        checkpoint = await this.loadCheckpoint(bookID);
        if (checkpoint) {
          consecutiveFailures = checkpoint.consecutiveFailures;
          this.logger
            .withMetadata({ resumeFrom: checkpoint.lastProcessedPageId })
            .info('Resuming from checkpoint');
        }
      }

      // Flatten book structure into conversion tasks
      const conversionTasks = this.buildTaskList(pages);
      this.logger.withMetadata({ totalTasks: conversionTasks.length }).info('Built conversion task list');

      // Filter tasks based on checkpoint
      const tasksToProcess = checkpoint
        ? conversionTasks.filter((task) => !checkpoint?.convertedPages?.includes(task.fileName))
        : conversionTasks;

      const pagePaths: string[] = checkpoint ? [...checkpoint.convertedPages] : [];
      let processedCount = checkpoint?.totalPagesProcessed || 0;

      for (const task of tasksToProcess) {
        // Check job timeout
        if (Date.now() - startTime > CIRCUIT_BREAKER_CONFIG.maxJobDurationMs) {
          throw new Error('Job exceeded maximum duration (4 hours)');
        }

        // Check circuit breaker
        if (consecutiveFailures >= CIRCUIT_BREAKER_CONFIG.maxConsecutiveFailures) {
          throw new Error(
            `Circuit breaker triggered: ${consecutiveFailures} consecutive failures. Aborting job.`,
          );
        }

        // Ensure browser is healthy before processing
        await this.ensureBrowserHealthy();

        this.logger
          .withMetadata({
            current: processedCount + 1,
            total: tasksToProcess.length,
            type: task.type,
            title: task.pageInfo.title
          })
          .info('Processing page');

        // Convert the page with retry logic
        const convertFn = async () => {
          if (task.type === 'toc') {
            return await this.generateTableOfContents({
              bookID,
              pageInfo: task.pageInfo,
              outFileNameOverride: task.fileName,
            });
          } else {
            return await this.convertPage({
              bookID,
              pageInfo: task.pageInfo,
              outFileNameOverride: task.fileName,
            });
          }
        };

        const result = await this.retryWithBackoff(convertFn, `Convert ${task.type}: ${task.pageInfo.url}`);

        if (result.success) {
          pagePaths.push(result.result!);
          processedCount++;
          consecutiveFailures = 0; // Reset on success

          if (options.onProgress) {
            options.onProgress({
              current: processedCount,
              total: conversionTasks.length,
              status: `Converted ${task.type}: ${task.pageInfo.title}`,
            });
          }

          // Save checkpoint after each successful conversion
          await this.saveCheckpoint(bookID, {
            convertedPages: pagePaths.slice(),
            lastProcessedPageId: task.id,
            totalPagesProcessed: processedCount,
            consecutiveFailures,
            timestamp: new Date(),
          });
        } else {
          consecutiveFailures++;
          this.logger
            .withMetadata({ error: result.error, task: task.id })
            .error('Task failed after retries');

          // Save checkpoint even on failure
          await this.saveCheckpoint(bookID, {
            convertedPages: pagePaths.slice(),
            lastProcessedPageId: task.id,
            totalPagesProcessed: processedCount,
            consecutiveFailures,
            timestamp: new Date(),
          });
        }

        this._pagesProcessedCount++;
      }

      // All pages converted successfully, merge and generate covers
      this.logger.info('All pages converted, merging content');
      const contentFilePath = await this.mergeContentPagesAndWrite({
        bookID,
        pages: pagePaths,
        preferLocalStorage,
      });
      const numPages = await this.calculateNumPagesInPDFDocument(contentFilePath);

      // Generate covers with retry
      this.logger.info('Generating covers');
      const coverConfigs = [
        { coverType: 'Amazon' as PDFCoverType, numPages },
        { coverType: 'CaseWrap' as PDFCoverType, numPages, opt: { extraPadding: true, hardcover: true } },
        { coverType: 'CoilBound' as PDFCoverType, numPages, opt: { extraPadding: true, thin: true } },
        { coverType: 'Main' as PDFCoverType, numPages: null },
        { coverType: 'PerfectBound' as PDFCoverType, numPages, opt: { extraPadding: true } },
      ];

      const coverResults = await Promise.allSettled(
        coverConfigs.map(async (config) => {
          const result = await this.retryWithBackoff(
            async () =>
              await this.generateCover({
                bookInfo: pages,
                coverType: config.coverType,
                numPages: config.numPages,
                opt: config.opt,
              }),
            `Generate cover: ${config.coverType}`,
          );
          if (!result.success) {
            this.logger
              .withMetadata({ coverType: config.coverType, error: result.error })
              .error('Cover generation failed after retries');
          }
          return result;
        }),
      );

      const failedCovers = coverResults.filter((r) => r.status === 'rejected').length;
      if (failedCovers > 0) {
        this.logger.withMetadata({ failedCovers }).warn('Some covers failed to generate');
      }

      const finalPath = await this.mergeContentPagesAndWrite({
        bookID,
        pages: pagePaths,
        preferLocalStorage,
      });

      this.logger
        .withMetadata({ duration: Date.now() - startTime, totalPages: processedCount })
        .info('Book conversion completed successfully');

      // Success! Clear checkpoint and cleanup
      await this.clearCheckpoint(bookID);
      await this.cleanupTempFiles(bookID);

      return finalPath;
    } catch (error) {
      this.logger.withMetadata({ error, duration: Date.now() - startTime }).error('Book conversion failed');
      // Keep checkpoint and temp files for potential resume
      throw error;
    }
  }

  public async convertPage({
    bookID,
    outFileNameOverride,
    pageInfo,
  }: {
    bookID?: BookID;
    outFileNameOverride?: string;
    pageInfo: BookPageInfo;
    token?: string;
  }) {
    await CXOneRateLimiter.waitUntilAPIAvailable(2);
    const browser = await this.getBrowser();
    const page = await browser.newPage();

    try {
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
      // TODO: re-evaluate
      if (pageInfo.tags.includes('hidetop:solutions')) {
        await page.addStyleTag({ content: 'dd, dl {display: none;} h3 {font-size: 160%}' });
      }
      if (pageInfo.url.includes('Wakim_and_Grewal')) {
        await page.addStyleTag({ content: `.mt-content-container {font-size: 93%}` });
      }
      await page.addStyleTag({
        content: `
        @page {
          size: calc(8.5in - (0.75in + 0.9in)) calc(11in - 0.625in);
          margin: ${showHeaders ? `${pdfPageMargins};` : '0.625in;'}
          padding: 0;
          print-color-adjust: exact;
        }
        #elm-main-content {
          padding: 0 !important;
        }
        ${pdfTOCStyles}
      `,
      });

      const path = await this.generatePageOutputFileName({
        bookID: bookID ?? {
          lib: pageInfo.lib,
          pageID: pageInfo.id,
        },
        outFileNameOverride,
        preferLocalStorage: true,
        useWorkdir: !!bookID,
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
      this.logger.withMetadata({ url: pageInfo.url, outFileNameOverride }).info('Converted page.');
      return path;
    } finally {
      if (!page.isClosed()) await page.close();
    }
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

  public async mergeContentPagesAndWrite({
    bookID,
    pages,
    preferLocalStorage = false,
  }: {
    bookID: BookID;
    pages: string[];
    preferLocalStorage?: boolean;
  }) {
    const extractFileName = (filePath: string) => {
      const split = filePath.split('/');
      return split[split.length - 1];
    };
    const isSplittable = (filePath: string) => !!filePath.split('/').length;
    const sortedPages = pages
      .filter((p) => isSplittable(p))
      .sort((aRaw, bRaw) => {
        const a = extractFileName(aRaw);
        const b = extractFileName(bRaw);
        return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
      });
    const mergedRaw = await this.mergeFiles(sortedPages);
    const outPath = await this.generatePageOutputFileName({
      bookID,
      outFileNameOverride: 'Content',
      preferLocalStorage,
    });
    if (!preferLocalStorage) {
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
    coverType,
    numPages,
    opt,
  }: {
    bookInfo: BookPageInfo;
    coverType: PDFCoverType;
    numPages: number | null;
    opt?: PDFCoverOpts;
  }) {
    const dirPath = await this.ensureCoversDirectory({ lib: bookInfo.lib, pageID: bookInfo.id });

    const browser = await this.getBrowser();
    const page = await browser.newPage();

    try {
      const spineWidth = this.getCoverSpineWidth({ numPages, opt });
      const width = this.getCoverWidth({ numPages, opt });
      const frontContent = generatePDFFrontCoverContent(bookInfo);
      const backContent = generatePDFBackCoverContent(bookInfo);
      const spine = generatePDFSpineContent({ currentPage: bookInfo, opt, spineWidth, width });
      const styles = generatePDFCoverStyles({ currentPage: bookInfo, opt });

      const baseContent = numPages
        ? `${styles}${backContent}${opt?.thin ? '' : spine}${frontContent}`
        : `${styles}${frontContent}`;
      const content = `
      ${baseContent}
      ${opt?.extraPadding
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
      await page.setContent(content, { waitUntil: ['load', 'domcontentloaded', 'networkidle0'] });
      await page.pdf({
        path: `${dirPath}/${coverType}.pdf`,
        printBackground: true,
        width: numPages ? `${this.getCoverWidth({ numPages, opt })} in` : '8.5 in',
        height: numPages ? (opt?.hardcover ? '12.75 in' : '11.25 in') : '11 in',
        timeout: this.pageLoadSettings.timeout,
      });
      this.logger.withMetadata({ coverType, url: bookInfo.url }).info('Generated cover.');
    } finally {
      await page.close();
    }
  }

  private getCoverSpineWidth({ numPages, opt }: { numPages: number | null; opt?: PDFCoverOpts }) {
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
    if (opt && !opt.extraPadding && !isNullOrUndefined(numPages)) return numPages * 0.002252; // Amazon side
    if (opt?.hardcover && !isNullOrUndefined(numPages)) {
      const res = Object.entries(sizes).reduce(
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
    if (opt && !opt.extraPadding && !isNullOrUndefined(numPages)) return numPages * 0.002252 + 0.375 + 17; // Amazon size
    if (opt?.hardcover && !isNullOrUndefined(numPages)) {
      const res = Object.entries(sizes).reduce(
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

  private async generateTableOfContents({
    bookID,
    pageInfo,
    outFileNameOverride,
  }: {
    bookID?: BookID;
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

    try {
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
        bookID: bookID ?? {
          lib: pageInfo.lib,
          pageID: pageInfo.id,
        },
        outFileNameOverride,
        preferLocalStorage: true,
        useWorkdir: !!bookID,
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
          currentPage: null,
          mainColor: '#127BC4',
          pageLicense: null,
          prefix: '',
        }),
        printBackground: true,
        preferCSSPageSize: true,
        timeout: this.pageLoadSettings.timeout,
      });
      this.logger.withMetadata({ url: pageInfo.url }).info('Finished Table of Contents.');
      return path;
    } finally {
      if (!page.isClosed()) await page.close();
    }
  }

  private buildTaskList(coverPage: BookPageInfo) {
    const conversionTasks: Array<ConversionTask> = [];
    let backMatterIdx = 0;
    let frontMatterIdx = 0;

    // Depth-first traversal to build task list with correct ordering and TOC placement
    const buildTaskListInner = (p: BookPageInfo) => {
      const idx = `${conversionTasks.length + 1}`.padStart(4, '0');
      const pageId = `${p.lib}-${p.id}`;

      if (
        Array.isArray(p.subpages) &&
        p.subpages.length > 1 &&
        (p.tags.includes('article:topic-category') || p.tags.includes('article:topic-guide')) &&
        !['Back Matter', 'Front Matter'].some((t) => p.title.includes(t))
      ) {
        conversionTasks.push({
          pageInfo: p,
          fileName: `${idx}_TOC`,
          type: 'toc',
          id: `toc-${pageId}`,
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
            pageInfo: p,
            fileName: `${idxPrefix}_${pageId}`,
            type: 'page',
            id: `page-${pageId}`,
          });
        }
      }

      if (Array.isArray(p.subpages)) {
        for (const sub of p.subpages) {
          buildTaskListInner(sub);
        }
      }
    };

    buildTaskListInner(coverPage);

    return conversionTasks;
  }
}
