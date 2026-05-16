import fs from 'node:fs/promises';
import { readFileSync, createReadStream, writeFileSync, createWriteStream } from 'node:fs';
import pLimit from 'p-limit';
import { v4 as uuid } from 'uuid';
import { basename, join, resolve } from 'node:path';
import {
  generatePDFCoverHTML,
  generatePDFHeader,
  generatePDFFooter,
  generateFontCSS,
  PDF_COVER_TYPES,
  pdfTOCStyles,
  pdfIndexStyles,
  pdfGlossaryStyles,
  pdfHeaderCSS,
  pdfDetailedLicensingStyles,
  countPDFPages,
  extractPDFPages,
} from '../util/pdfHelpers';
import { buildTagIndex, generateIndexHTML } from '../util/indexHelpers';
import { parseGlossaryTable, buildGlossaryData, generateGlossaryHTML } from '../util/glossaryHelpers';
import { ImageConstants } from '../util/imageConstants';
import { sleep } from '../helpers';
import { log as logService } from '../lib/log';
import { LogLayer } from 'loglayer';
import { Environment } from '../lib/environment';
import { StorageService } from '../lib/storageService';
import { fsPathToS3Key, getDirectoryPathFromFilePath } from '../util/fsHelpers';
import Prince from 'prince';
import { BookPageInfo, BookPages } from '../types/book';
import PageID from '../util/pageID';
import * as cheerio from 'cheerio';
import { PDFCoverOpts, PDFCoverType } from '../types/pdf';
import { prerenderMath, stripMathJaxScripts, extractPageNumberPrefix } from '../util/mathjax';
import { stripBlocklistedScripts } from '../util/htmlFilters';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decode } from 'html-entities';
import { generateDetailedLicensingHTML } from '../util/detailedLicensingHelpers';
import axios from 'axios';
import { PassThrough } from 'node:stream';
import Archiver from 'archiver';
import { Upload } from '@aws-sdk/lib-storage';

const __dirname = dirname(fileURLToPath(import.meta.url));

// CSS loaded at module init and inlined into HTML sent to Prince.
// Note: changes to this file require a server restart in development.
const princePdfCssPath = join(__dirname, '../styles/prince-pdf.css');
const pdfPageCSS = readFileSync(join(__dirname, '../styles/pdf-page.css'), 'utf-8');
const pdfTableCSS = readFileSync(join(__dirname, '../styles/pdf-tables.css'), 'utf-8');
const pdfFontCSS = generateFontCSS();

/**
 * Canonical configuration for each cover type.
 * `opt` contains the styling flags passed to the cover generator.
 * `usesPageCount` indicates whether the cover dimensions depend on the content page count
 * (false only for 'Main', which is a single front-only cover at a fixed size).
 */
export const COVER_TYPE_CONFIG: Record<PDFCoverType, { opt?: PDFCoverOpts; usesPageCount: boolean }> = {
  Amazon: { usesPageCount: true },
  CaseWrap: {
    opt: { extraPadding: true, hardcover: true },
    usesPageCount: true,
  },
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
  type: 'page' | 'toc' | 'index' | 'glossary' | 'detailed-licensing';
};

/**
 * A group of ConversionTasks to be rendered in a single Prince invocation.
 * Content pages that share a chapter ancestor are grouped together so that a single
 * Prince invocation renders them all (multi-file input), reducing subprocess overhead.
 * Front/back matter, TOC, and Index tasks are always single-task groups.
 *
 * isPacked is kept for commented-out packing code below; all live groups use isPacked: false.
 */
type PageGroup = {
  sortKey: string;
  fileName: string;
  tasks: ConversionTask[];
  isPacked: boolean;
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

/**
 * Maximum number of content pages per chapter sub-group in a single Prince invocation.
 * Large chapters beyond this limit are split into sequential sub-groups to bound
 * per-invocation memory in Pass 1 (page counting). Pass 2 feeds all HTML files to
 * a single Prince call regardless of group size.
 */
const MAX_PAGES_PER_GROUP = 6;

/**
 * Maximum number of Prince subprocesses running concurrently.
 * Prince is CPU/I-O bound; 4 concurrent invocations balances throughput against
 * resource pressure. Tune via PRINCE_CONCURRENCY env var.
 */
const DEFAULT_PRINCE_CONCURRENCY = 4;

/** Represents the pre-rendered math output for a single ConversionTask. */
type PrerenderedTask = { task: ConversionTask; renderedBody: string };

export class PDFService {
  private _bookID!: PageID;
  private readonly _useEnvironmentPrinceLicense: boolean = false;
  private _useLocalStorage: boolean = false;
  private readonly logger: LogLayer;
  private readonly logName = 'PDFService';
  private readonly storageService: StorageService;
  private _treeMap: Map<string, BookPageInfo> = new Map();
  private _parentMap: Map<string, string> = new Map();
  private _rootPageID: string = '';
  private _allPages: BookPageInfo[] = [];

  constructor(bookID: PageID, opts: { useLocalStorage?: boolean } = {}) {
    this._bookID = bookID;
    this._useLocalStorage = opts.useLocalStorage ?? false;

    if (!bookID || !(bookID instanceof PageID)) {
      throw new Error('Book ID is required and must be a valid PageID instance');
    }

    this.logger = logService.child().withContext({
      logSource: this.logName,
      bookID: this._bookID.toString(),
    });
    this.storageService = new StorageService();

    const encodedPrinceLicense = Environment.getOptional('PRINCE_LICENSE_ENCODED');
    if (encodedPrinceLicense) {
      this._useEnvironmentPrinceLicense = true;
      this.initEnvironmentPrinceLicense(encodedPrinceLicense);
    }
  }

  private initEnvironmentPrinceLicense(encodedLicense: string) {
    // check if license is initialized already
    try {
      readFileSync('./prince_license.dat', 'utf-8');
      return;
    } catch (e) {
      this.logger.info('Initializing Prince license from environment variable.');
    }

    try {
      const licenseStr = Buffer.from(encodedLicense, 'base64').toString('utf-8');
      writeFileSync('./prince_license.dat', licenseStr, { encoding: 'utf-8' });
    } catch (e) {
      this.logger.withError(e).warn('Error occured initializing Prince license from environment variable.');
    }
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
    this._allPages = pages;
    const startTime = Date.now();
    const pagesMap = new Map(pages.map((c) => [c.pageID.toString(), c] as [string, BookPageInfo]));

    try {
      const preflightOk = await this.runPreflightChecks();
      if (!preflightOk) {
        throw new Error('Preflight checks failed: Prince binary is not properly configured');
      }

      // Build conversion tasks with correct ordering and TOC placement, then group
      // content pages by chapter so each chapter is rendered in a single Prince invocation.
      const conversionTasks = this.buildTaskList(pagesInput);
      const pageGroups = this.groupTasksIntoChapters(conversionTasks);
      this.logger
        .withMetadata({
          totalTasks: conversionTasks.length,
          totalGroups: pageGroups.length,
        })
        .info('Built conversion task list and page groups');

      // ── Phase 1: Pre-render MathJax for all groups sequentially ──
      // currentPageNumberPrefix is a module-level global in mathjax.ts; concurrent
      // renders would race on it.  We complete all math work before spawning any
      // Prince processes so Phase 2 is free of MathJax state.
      this.logger.withMetadata({ totalGroups: pageGroups.length }).info('Pre-rendering math for all groups');
      const prerenderedMap = new Map<string, PrerenderedTask[]>();
      for (const group of pageGroups) {
        const pageTasks = group.tasks.filter((t) => t.type === 'page');
        if (pageTasks.length === 0) continue; // TOC / Index — no math needed
        try {
          const rendered: PrerenderedTask[] = [];
          for (const t of pageTasks) {
            // Decode HTML entities before MathJax so liteDOM never stores them as verbatim
            // strings (which get double-encoded to &amp;ldquo; in outerHTML output).
            const rawHTML = this.decodeHTML(this.addPageTitle(t.pageInfo, t.pageInfo.body.join('')));
            rendered.push({
              task: t,
              renderedBody: await prerenderMath(rawHTML, t.pageInfo),
            });
          }
          prerenderedMap.set(group.sortKey, rendered);
        } catch (mathError) {
          // Math pre-rendering failed for this group (e.g. stack overflow on a deeply
          // nested expression). Leave the group out of the map so Phase 2 falls back to
          // inline rendering inside convertPageGroup, where retryWithBackoff handles it.
          //
          // Pass only the message string — not the Error object — to the logger.
          // If mathError is a RangeError the stack may still be near its limit, and
          // passing the object lets LogLayer call util.inspect on it, which can
          // re-trigger the overflow and produce a confusing "Enrichment error".
          const errMsg = mathError instanceof Error ? mathError.message : String(mathError);
          this.logger
            .withMetadata({ sortKey: group.sortKey, error: errMsg })
            .warn('Math pre-render failed for group — will render inline during conversion');
        }
      }

      // ── Phase 2: Convert groups in two passes to produce correct page numbers ──
      //
      // Pass 1 renders all groups at default page numbering so we can count pages per
      // group. Pass 2 re-renders with --page-offset set to the cumulative page count
      // of all preceding groups, producing a continuously-numbered merged PDF.
      // Both passes run fully parallel up to PRINCE_CONCURRENCY.
      const princeConcurrency =
        parseInt(Environment.getOptional('PRINCE_CONCURRENCY', String(DEFAULT_PRINCE_CONCURRENCY)), 10) ||
        DEFAULT_PRINCE_CONCURRENCY;
      const princeLimit = pLimit(princeConcurrency);
      this.logger
        .withMetadata({ totalGroups: pageGroups.length, princeConcurrency })
        .info('Pass 1: generating group PDFs to measure page counts');

      // ── Phase 2a: Pass 1 ──
      const pass1Results = await Promise.allSettled(
        pageGroups.map((group) =>
          princeLimit(async () => {
            if (Date.now() - startTime > CIRCUIT_BREAKER_CONFIG.maxJobDurationMs) {
              throw new Error('Job exceeded maximum duration (4 hours)');
            }
            const prerendered = prerenderedMap.get(group.sortKey) ?? null;
            const result = await this.retryWithBackoff(
              () => this.convertPageGroup(group, prerendered),
              `Pass 1 group: ${group.fileName} (${group.tasks.length} page(s))`,
            );
            return { group, result };
          }),
        ),
      );

      // ── Phase 2b: Count pages per group, compute cumulative offsets ──
      type GroupCount = { group: PageGroup; pageCount: number };
      let pass1FailureCount = 0;
      const pass1Counts: GroupCount[] = [];
      for (const r of pass1Results) {
        if (r.status === 'rejected') {
          pass1FailureCount++;
          this.logger.withMetadata({ error: r.reason }).error('Group Pass 1 promise rejected');
        } else if (!r.value.result.success) {
          pass1FailureCount++;
          this.logger
            .withMetadata({
              error: r.value.result.error,
              group: r.value.group.fileName,
            })
            .error('Group failed Pass 1 after all retries');
        } else if (r.value.result.result) {
          // Pass 1 never uses htmlOnly, so the result is always a single PDF path.
          const pageCount = await countPDFPages(r.value.result.result as string);
          pass1Counts.push({ group: r.value.group, pageCount });
        }
      }

      if (pass1FailureCount >= CIRCUIT_BREAKER_CONFIG.maxConsecutiveFailures) {
        throw new Error(`Job failed in Pass 1: ${pass1FailureCount} group(s) failed to convert`);
      }

      // Identify the first group with visible page numbering so we can insert a
      // counter-reset in its HTML. Suppressed pages (TitlePage, InfoPage)
      // still increment it in prince, so we reset to 0 at the first visible page so
      // numbering starts at 1.
      const sortedPass1 = [...pass1Counts].sort((a, b) =>
        a.group.sortKey.localeCompare(b.group.sortKey, undefined, {
          numeric: true,
        }),
      );
      const firstVisibleSortKey = sortedPass1.find(
        ({ group }) => !group.tasks.every((t) => !this.getShouldShowMarginContent(t.pageInfo)),
      )?.group.sortKey;
      // Map each group to the pageOffset it needs: only the first visible group
      // gets counter-reset: page 0 (so its first page displays "1"). All other
      // groups omit counter-reset and let Prince auto-increment continuously.
      const groupOffsets = new Map<string, number | undefined>();
      for (const { group } of sortedPass1) {
        groupOffsets.set(group.sortKey, group.sortKey === firstVisibleSortKey ? 0 : undefined);
      }

      const totalPages = sortedPass1.reduce((sum, { pageCount }) => sum + pageCount, 0);
      this.logger
        .withMetadata({ totalGroups: sortedPass1.length, totalPages })
        .info('Pass 2: generating HTML for single Prince invocation');

      // ── Phase 2c: Pass 2 — generate HTML temp files ──
      // Each group produces one or more HTML files. All files are collected in
      // sortKey order and passed to a single Prince invocation that produces the
      // entire content PDF with a unified tagged structure tree.
      type Pass2GroupResult = { group: PageGroup; htmlPaths: string[] };
      const pass2Results = await Promise.allSettled(
        pageGroups.map((group) =>
          princeLimit(async () => {
            if (Date.now() - startTime > CIRCUIT_BREAKER_CONFIG.maxJobDurationMs) {
              throw new Error('Job exceeded maximum duration (4 hours)');
            }
            const prerendered = prerenderedMap.get(group.sortKey) ?? null;
            const pageOffset = groupOffsets.get(group.sortKey);
            const result = await this.retryWithBackoff(
              () => this.convertPageGroup(group, prerendered, pageOffset, true),
              `Pass 2 HTML group: ${group.fileName} (${group.tasks.length} page(s))`,
            );
            if (!result.success || !result.result) {
              throw result.error ?? new Error('No HTML paths returned');
            }
            const htmlPaths = Array.isArray(result.result) ? result.result : [result.result];
            return { group, htmlPaths } satisfies Pass2GroupResult;
          }),
        ),
      );

      // ── Phase 2d: Collect HTML paths ──
      let failureCount = 0;
      const pass2Groups: Pass2GroupResult[] = [];
      for (const r of pass2Results) {
        if (r.status === 'rejected') {
          failureCount++;
          this.logger.withMetadata({ error: r.reason }).error('Group Pass 2 promise rejected');
        } else if (!r.value.htmlPaths) {
          failureCount++;
          this.logger
            .withMetadata({ group: r.value.group.fileName })
            .error('Group failed Pass 2: no HTML paths returned');
        } else {
          pass2Groups.push(r.value);
        }
      }

      if (failureCount >= CIRCUIT_BREAKER_CONFIG.maxConsecutiveFailures) {
        throw new Error(`Job failed: ${failureCount} group(s) failed to convert`);
      }

      // Sort groups by sortKey, then flatten to a single ordered list of HTML paths.
      pass2Groups.sort((a, b) =>
        a.group.sortKey.localeCompare(b.group.sortKey, undefined, {
          numeric: true,
        }),
      );
      const allHTMLPaths = pass2Groups.flatMap((g) => g.htmlPaths);

      // ── Phase 2e: Rewrite internal fragment links to include target filenames ──
      // Prince's multi-file input doesn't resolve bare #id fragments across files.
      // We rewrite href="#page-{id}" → href="targetfile.html#page-{id}" so Prince
      // can resolve each link to the correct input file.
      const anchorToFile = new Map<string, string>();
      for (const { group, htmlPaths } of pass2Groups) {
        for (let i = 0; i < group.tasks.length; i++) {
          const filePath = htmlPaths[i];
          if (filePath) {
            anchorToFile.set(`page-${group.tasks[i].pageID}`, basename(filePath));
          }
        }
      }
      await Promise.all(
        allHTMLPaths.map(async (htmlPath) => {
          const content = await fs.readFile(htmlPath, 'utf-8');
          const rewritten = content.replace(/href="#(page-[^"]+)"/g, (_match, anchor) => {
            const targetFile = anchorToFile.get(anchor);
            return targetFile ? `href="${targetFile}#${anchor}"` : `href="#${anchor}"`;
          });
          if (rewritten !== content) {
            await fs.writeFile(htmlPath, rewritten);
          }
        }),
      );

      // ── Phase 3: Generate Main cover HTML and prepend to the Prince input ──
      // The Main cover doesn't need a page count and must suppress header/footer.
      const coverPageInfo = pagesMap.get(this._bookID.toString())!;
      const mainCoverHTML = generatePDFCoverHTML({
        bookInfo: coverPageInfo,
        coverType: 'Main',
        numPages: null,
      });
      const mainCoverTempPath = await this._createTempFile(mainCoverHTML);

      // ── Phase 4: Run Prince conversion ──
      this.logger
        .withMetadata({ totalHTMLFiles: allHTMLPaths.length + 1 })
        .info('All HTML generated, running single Prince invocation for full document');
      const fullDocHTMLPaths = [mainCoverTempPath, ...allHTMLPaths];
      const finalFilePath = await this.generateFullDocumentOutputFilePath();
      const finalDir = getDirectoryPathFromFilePath(finalFilePath);
      await fs.mkdir(finalDir, { recursive: true });
      await this.runPrinceConversion({
        inputPath: fullDocHTMLPaths,
        outputPath: finalFilePath,
        pageInfo: coverPageInfo,
      });
      if (!this._useLocalStorage) await this.streamFileToS3(finalFilePath);

      // ── Phase 5: Generate additional assets like Content file and covers ──
      // Extract content-only pages (page 2 onward) for the publication zip.
      // Tags/structure are not needed in this file: used for printers only.
      const contentFilePath = await this.generateContentOutputFilePath();
      const contentDir = getDirectoryPathFromFilePath(contentFilePath);
      await fs.mkdir(contentDir, { recursive: true });
      await extractPDFPages({
        inputPath: finalFilePath,
        outputPath: contentFilePath,
        pageStart: 2,
      });
      if (!this._useLocalStorage) await this.streamFileToS3(contentFilePath);

      // Clean up HTML temp files now that Prince has consumed them.
      await Promise.all(fullDocHTMLPaths.map((p) => this._deleteTempFile(p).catch(() => {})));
      this.logger.info('Full document and content PDF generated successfully');

      // Generate print covers (Amazon, CaseWrap, CoilBound, PerfectBound) with retry.
      this.logger.info('Generating publication covers');
      const numPages = await countPDFPages(finalFilePath);
      const contentPageCount = numPages - 1; // exclude Main cover
      const coverConfigs = PDF_COVER_TYPES.filter((t) => t !== 'Main').map((coverType) => ({
        coverType,
        numPages: COVER_TYPE_CONFIG[coverType].usesPageCount ? contentPageCount : null,
        opt: COVER_TYPE_CONFIG[coverType].opt,
      }));

      const coversPath = await this.ensureCoversDirectory();
      const coverResults = await Promise.allSettled(
        coverConfigs.map(async (config) => {
          const result = await this.retryWithBackoff(
            async () =>
              await this.generateCover({
                bookInfo: coverPageInfo,
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

      await this.mergeToPublicationZipAndWrite({
        coversDirPath: coversPath,
        contentFilePath,
      });
      await this.cleanupWorkdir();
      if (!this._useLocalStorage) await this.cleanupLocalArtifacts({ finalFilePath });
      return finalFilePath;
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

  private async generateContentOutputFilePath() {
    const baseDir = Environment.getOptional('TMP_OUT_DIR', './.tmp');
    const basePath = resolve(`${baseDir}/pdf/${this._bookID.toString()}`);
    const dirPath = join(basePath, 'workdir');
    const filePath = join(dirPath, `content_${this._bookID.toString()}.pdf`);

    // Ensure the dir exists before returning the file path
    await fs.mkdir(dirPath, { recursive: true });
    return filePath;
  }

  private async generateFullDocumentOutputFilePath() {
    const baseDir = Environment.getOptional('TMP_OUT_DIR', './.tmp');
    const basePath = resolve(`${baseDir}/pdf/${this._bookID.toString()}`);
    const filePath = join(basePath, '/Full.pdf');

    // Ensure the dir exists before returning the file path
    await fs.mkdir(basePath, { recursive: true });
    return filePath;
  }

  private async generatePublicationZipOutputFilePath() {
    const baseDir = Environment.getOptional('TMP_OUT_DIR', './.tmp');
    const basePath = resolve(`${baseDir}/pdf/${this._bookID.toString()}`);
    const filePath = join(basePath, '/Publication.zip');

    // Ensure the dir exists before returning the file path
    await fs.mkdir(basePath, { recursive: true });
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

  private addPageTitle(pageInfo: BookPageInfo, raw: string) {
    const titleExclusions = [
      'Detailed Licensing',
      'Glossary',
      'Index',
      'InfoPage',
      'Table of Contents',
      'ProgramPage',
      'Title Page',
      'TitlePage',
    ];
    const isInExcludedList = titleExclusions.some((e) => pageInfo.title.includes(e));
    const isTableOfContents = pageInfo.pageID.pageNum === this._bookID.pageNum;
    const hasChildren = !!pageInfo.subpages?.length;
    const shouldRenderTitle = !(isInExcludedList || isTableOfContents || hasChildren);
    const anchor = `page-${pageInfo.pageID}`;
    if (shouldRenderTitle) {
      return `<h1 id="${anchor}">${pageInfo.title}</h1>${raw}`;
    }
    return `<span id="${anchor}" class="pdf-anchor">&#8203;</span>${raw}`;
  }

  private decodeHTML(raw: string) {
    // Protect &quot; (used in attribute values) from being decoded to a bare " that
    // would break HTML attribute quoting. All other named entities — including curly
    // quotes like &ldquo; / &rdquo; / &rsquo; — are decoded to their unicode equivalents
    // so Prince receives plain text rather than literal entity strings.
    return decode(raw.replaceAll('&quot;', 'QUOT_REPL'), {
      level: 'html5',
    }).replace(/QUOT_REPL/g, '&quot;');
  }

  private async convertPage({
    additionalCSS,
    htmlOnly = false,
    mainColor = '#127BC4',
    pageBodyHTML,
    pageHeadHTML = '',
    pageID,
    pageInfo,
    pageOffset,
    pageTailHTML = '',
    preRenderedBodyHTML,
    sortKey,
  }: {
    additionalCSS?: string;
    /** When true, writes the HTML to a persistent temp file and returns its path without invoking Prince. */
    htmlOnly?: boolean;
    mainColor?: string;
    pageBodyHTML: string;
    pageHeadHTML?: string;
    pageID: PageID;
    pageInfo: BookPageInfo;
    pageOffset?: number;
    pageTailHTML?: string;
    /** If supplied, skips the prerenderMath call (math was pre-rendered in Phase 1). */
    preRenderedBodyHTML?: string;
    sortKey: string;
  }) {
    try {
      // Use pre-rendered math if available (Phase 1 pre-render), otherwise render now.
      // Entities in pageBodyHTML are decoded before prerenderMath so MathJax's liteDOM
      // never stores them verbatim (which causes double-encoding in outerHTML output).
      // The outer decodeHTML is a catch-all for any other content paths (TOC, Index, etc.).
      const renderedBodyHTML = this.decodeHTML(
        this.sanitizeImagesForPDF(
          preRenderedBodyHTML ??
            (await prerenderMath(this.decodeHTML(this.addPageTitle(pageInfo, pageBodyHTML)), pageInfo)),
        ),
      );
      const cleanedHeadHTML = stripBlocklistedScripts(stripMathJaxScripts(pageHeadHTML));

      const showMarginContent = this.getShouldShowMarginContent(pageInfo);
      const headerHTML = showMarginContent ? generatePDFHeader(ImageConstants['default']) : '';
      const sectionNum = extractPageNumberPrefix(pageInfo.title).replace(/\.$/, '');
      const footerHTML = showMarginContent ? generatePDFFooter({ sectionNum }) : '';

      // Wrap the page content in a complete HTML document with header/footer margin elements.
      // Prince's running element CSS (in pdf-page.css) pulls #libre-pdf-header out of body
      // flow into the @page @top margin box. The footer uses string-set + counter(page) in
      // the @page @bottom margin box directly. See pdf-page.css for details.
      // pageTailHTML includes post-body scripts that must run after the content is in the DOM.
      // TODO: lang attr for non-English texts
      const wrappedHTML = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>${pageInfo.printInfo?.title || pageInfo.title || 'Unknown'}</title>
  <style>${pdfFontCSS}</style>
  <style>${pdfPageCSS}</style>
  <style>${pdfTableCSS}</style>
  <style>${pdfHeaderCSS}</style>
  <style>:root { --pdf-main-color: ${mainColor}; }</style>
  ${pageOffset !== undefined ? `<style>html { counter-reset: page ${pageOffset + 1}; }</style>` : ''}
  ${additionalCSS ? `<style>${additionalCSS}</style>` : ''}
  ${cleanedHeadHTML}
</head>
<body${showMarginContent ? '' : ' class="no-margin-content"'}>
${headerHTML}
${footerHTML}
${renderedBodyHTML}
${stripBlocklistedScripts(pageTailHTML)}
</body>
</html>
      `.trim();

      if (htmlOnly) {
        const htmlPath = await this._createTempFile(wrappedHTML);
        this.logger.withMetadata({ htmlPath, sortKey }).debug('Generated HTML (htmlOnly).');
        return htmlPath;
      }

      const outputPath = await this.generatePageOutputFilePath(pageID, sortKey);

      await this.withTempFile(wrappedHTML, (inputPath) =>
        this.runPrinceConversion({
          inputPath,
          outputPath,
          pageInfo,
        }),
      );

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
  private async runPrinceConversion({
    inputPath,
    outputPath,
    pageInfo,
  }: {
    inputPath: string | string[];
    outputPath: string;
    pageInfo: BookPageInfo;
  }) {
    const inputCount = Array.isArray(inputPath) ? inputPath.length : 1;
    const timeoutMs = Number.parseInt(Environment.getOptional('PRINCE_TIMEOUT_SECONDS', '60'), 10) * 1000;
    const maxBufferBytes =
      Number.parseInt(Environment.getOptional('PRINCE_MAX_BUFFER_GB', '3'), 10) * 1024 * 1024 * 1024;

    try {
      const prince = new Prince({
        binary: Environment.getOptional('PRINCE_BINARY_PATH', '') || undefined,
      });
      prince.timeout(timeoutMs);
      prince.maxbuffer(maxBufferBytes);
      if (this._useEnvironmentPrinceLicense) prince.license('./prince_license.dat');

      const title = pageInfo.printInfo?.title || pageInfo.title || 'Unknown';
      const result = await prince
        .option('verbose', true)
        .option('javascript', true)
        .option('tagged-pdf', true)
        .option('pdf-title', title)
        .option('style', princePdfCssPath)
        .option('pdf-xmp-metadata', true, true)
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
      const princeError = error as {
        error?: unknown;
        stdout?: Buffer;
        stderr?: Buffer;
      };
      const stderr = princeError?.stderr?.toString?.()?.trim();
      const innerError = princeError?.error as any;

      // Surface timeout/killed signals explicitly — execFile kills the process
      // on timeout but the prince wrapper doesn't distinguish it from other errors.
      let errorMessage: string;
      if (innerError?.killed || innerError?.signal === 'SIGTERM') {
        errorMessage = `Prince process was killed (signal: ${innerError.signal ?? 'unknown'}, timeout: ${timeoutMs}ms, inputs: ${inputCount} file(s)). Likely exceeded timeout for large document.`;
      } else if (innerError instanceof Error) {
        errorMessage = innerError.message;
      } else if (typeof innerError === 'string') {
        errorMessage = innerError;
      } else {
        errorMessage = JSON.stringify(error);
      }

      this.logger
        .withMetadata({
          inputPath: Array.isArray(inputPath) ? `[${inputCount} files]` : inputPath,
          outputPath,
          errorMessage,
          killed: innerError?.killed,
          signal: innerError?.signal,
          timeoutMs,
          princeOutput: stderr || undefined,
        })
        .error('Prince conversion failed');
      throw new Error(`Prince conversion failed: ${errorMessage}`);
    }
  }

  private async mergeToPublicationZipAndWrite({
    contentFilePath,
    coversDirPath,
  }: {
    contentFilePath: string;
    coversDirPath: string;
  }) {
    const outPath = await this.generatePublicationZipOutputFilePath();
    const output = !this._useLocalStorage ? new PassThrough() : createWriteStream(outPath);
    output.on('close', () => {
      this.logger.info('Publication.zip output write stream closed.');
    });
    const archive = Archiver('zip', { zlib: { level: 9 } });
    archive.on('error', (err) => {
      this.logger.withError(err).error('Encountered an error preparing final Publication.zip.');
      output.destroy(err);
    });
    archive.pipe(output);

    let uploader: Upload | undefined;
    if (!this._useLocalStorage) {
      uploader = this.storageService.createStreamUploader({
        contentType: 'application/zip',
        key: fsPathToS3Key(outPath),
        stream: output as PassThrough,
      });
    }

    // <write files>
    archive.file(contentFilePath, { name: 'Content.pdf' });
    PDF_COVER_TYPES.forEach((coverType) => {
      if (coverType === 'Main') return;
      archive.file(`${coversDirPath}/${coverType}.pdf`, {
        name: `Cover_${coverType}.pdf`,
      });
    });
    // </write files>

    if (!this._useLocalStorage) {
      // WARN: don't actually await here: can cause deadlock with storage service streaming upload
      archive.finalize();
      this.logger.info('Uploading Publication.zip to storage service...');
      await uploader?.done();
      this.logger.info('Finished upload Publication.zip to storage service.');
    } else {
      await archive.finalize();
    }

    this.logger.info('Finished writing Publication.zip output.');
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
        return `<li><div class="nobreak ${isSubtopic} ${subListSpacing}"><${prefix}><a href="#page-${elem.pageID}" title="${elem.title}">${elem.title}</a></${prefix}></div>${subPageDir}</li>`;
      }),
    );
    const inner = innerRaw.join('');
    return `<ul class='libre-print-list' ${twoColumn ? 'style="column-count: 2;"' : ''}>${inner}</ul>`;
  }

  /**
   * Strips HTML width/height attributes and inline width/height style declarations from <img>
   * elements so that the CSS max-width rule in pdf-page.css can take effect. CMS content often
   * embeds fixed pixel dimensions that would otherwise override the stylesheet constraint.
   */
  private sanitizeImagesForPDF(html: string): string {
    const $ = cheerio.load(html, { xmlMode: false });
    $('img').each((_, el) => {
      const $el = $(el);
      $el.removeAttr('width');
      $el.removeAttr('height');
      const style = $el.attr('style') ?? '';
      const cleaned = style
        .split(';')
        .filter((s) => !/^\s*(max-)?(width|height)\s*:/.test(s))
        .join(';');
      if (cleaned.trim()) {
        $el.attr('style', cleaned);
      } else {
        $el.removeAttr('style');
      }
    });
    return $('body').html() ?? html;
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
    if (!directory.length) return null;

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
    pageTitle.attr('style', 'border-bottom: none !important');

    const newTitle = $('<h1></h1>').text(pageType).attr('id', 'libre-print-directory-header');

    const typeContainer = $('<div></div>').attr('id', 'libre-print-directory-header-container');
    typeContainer.append(newTitle);
    pageTitle.before(typeContainer);

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
        await this.runPrinceConversion({
          inputPath,
          outputPath,
          pageInfo: bookInfo, // FIXME: override PDF document title
        });
      });

      this.logger.withMetadata({ coverType, url: bookInfo.url, outputPath }).info('Generated cover.');
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : JSON.stringify(error);
      this.logger.withMetadata({ coverType, url: bookInfo.url, error, errorMessage }).error('Cover generation failed');
      throw error;
    }
  }

  private async generateTableOfContents({
    htmlOnly = false,
    pageInfo,
    isMainTOC = false,
    sortKey,
    pageOffset,
  }: {
    htmlOnly?: boolean;
    pageInfo: BookPageInfo;
    isMainTOC?: boolean;
    sortKey: string;
    pageOffset?: number;
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
          htmlOnly,
          pageID: pageInfo.pageID,
          pageInfo,
          pageBodyHTML: tocBodyHTML,
          additionalCSS: pdfTOCStyles,
          sortKey,
          pageOffset,
        });

        this.logger.withMetadata({ url: pageInfo.url }).info('Finished Main Table of Contents.');
        return outputPath;
      } else {
        const listing = await this.getLevel(pageInfo);
        const updatedHTML = this.processDirectoryPage({
          html: `<h2 id="title">${pageInfo.title}</h2>${pageInfo.body.join('')}`,
          listing,
          tags: pageInfo.tags,
          title: pageInfo.title,
        });

        if (!updatedHTML) {
          this.logger.withMetadata({ url: pageInfo.url }).warn('Failed to process directory page for TOC');
          return null;
        }

        const outputPath = await this.convertPage({
          htmlOnly,
          pageID: pageInfo.pageID,
          pageInfo,
          pageBodyHTML: updatedHTML,
          pageHeadHTML: pageInfo.head,
          pageTailHTML: pageInfo.tail,
          additionalCSS: pdfTOCStyles,
          sortKey,
          pageOffset,
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
   * Generates the back-matter Index page for PDF output.
   *
   * Replaces the CXOne placeholder (a page whose body calls `template('DynamicIndex')`)
   * with a server-side alphabetised index built from all content-page tags.
   * Only pages without a `matterType` contribute terms — front/back matter
   * infrastructure pages are excluded since they carry system metadata tags rather
   * than human-assigned index terms.
   *
   * Tag filtering mirrors the legacy DynamicIndex.old.js exclusion rules, with one
   * fix: leading-article trimming ("a ", "an ", "the ") now works correctly.
   */
  private async generateIndex({
    htmlOnly = false,
    pageInfo,
    allPages,
    sortKey,
    pageOffset,
  }: {
    htmlOnly?: boolean;
    pageInfo: BookPageInfo;
    allPages: BookPageInfo[];
    sortKey: string;
    pageOffset?: number;
  }) {
    try {
      this.logger.withMetadata({ url: pageInfo.url }).info('Starting Index generation');

      const indexData = buildTagIndex(allPages);
      const indexBodyHTML = `
        <div id="libre-print-directory-header-container">
          <h1 id="libre-print-directory-header">Index</h1>
        </div>
        <div id="libre-index">
          ${generateIndexHTML(indexData)}
        </div>
      `;

      const outputPath = await this.convertPage({
        htmlOnly,
        pageID: pageInfo.pageID,
        pageInfo,
        pageBodyHTML: indexBodyHTML,
        additionalCSS: pdfIndexStyles,
        sortKey,
        pageOffset,
      });

      this.logger.withMetadata({ url: pageInfo.url }).info('Finished Index generation.');
      return outputPath;
    } catch (error) {
      this.logger.withMetadata({ url: pageInfo.url, error }).error('Index generation failed');
      throw error;
    }
  }

  /**
   * Generates the back-matter Glossary page for PDF output.
   *
   * Replaces the raw CXOne table (which renders poorly in PDF) with a
   * server-side alphabetised definition list parsed from the table's
   * data-th column attributes.
   *
   * Falls back to raw page rendering if the page body contains no parseable
   * glossary table — e.g. a book where the author left the Glossary page empty
   * or used a non-standard layout.
   */
  private async generateGlossary({
    htmlOnly = false,
    pageInfo,
    sortKey,
    pageOffset,
  }: {
    htmlOnly?: boolean;
    pageInfo: BookPageInfo;
    sortKey: string;
    pageOffset?: number;
  }) {
    try {
      this.logger.withMetadata({ url: pageInfo.url }).info('Starting Glossary generation');

      const rawBody = pageInfo.body.join('');
      const entries = parseGlossaryTable(rawBody);

      if (!entries || entries.length === 0) {
        this.logger
          .withMetadata({ url: pageInfo.url })
          .warn('No parseable glossary table found — falling back to raw page rendering');
        return this.convertPage({
          htmlOnly,
          pageID: pageInfo.pageID,
          pageInfo,
          pageBodyHTML: rawBody,
          pageHeadHTML: pageInfo.head,
          pageTailHTML: pageInfo.tail,
          sortKey,
          pageOffset,
        });
      }

      const glossaryBodyHTML = `
        <div id="libre-print-directory-header-container">
          <h1 id="libre-print-directory-header">Glossary</h1>
        </div>
        <div id="libre-glossary">
          ${generateGlossaryHTML(buildGlossaryData(entries))}
        </div>
      `;

      const outputPath = await this.convertPage({
        htmlOnly,
        pageID: pageInfo.pageID,
        pageInfo,
        pageBodyHTML: glossaryBodyHTML,
        additionalCSS: pdfTOCStyles + '\n' + pdfGlossaryStyles,
        sortKey,
        pageOffset,
      });

      this.logger.withMetadata({ url: pageInfo.url }).info('Finished Glossary generation.');
      return outputPath;
    } catch (error) {
      this.logger.withMetadata({ url: pageInfo.url, error }).error('Glossary generation failed');
      throw error;
    }
  }

  private async generateDetailedLicensing({
    htmlOnly = false,
    pageInfo,
    sortKey,
    pageOffset,
  }: {
    htmlOnly?: boolean;
    pageInfo: BookPageInfo;
    sortKey: string;
    pageOffset?: number;
  }) {
    try {
      this.logger.withMetadata({ bookID: pageInfo.pageID.toString() }).info('Starting Detailed Licensing generation');
      const licensingReportRes = await axios.get(`https://api.libretexts.org/endpoint/licensereport/${pageInfo.url}`, {
        headers: {
          Origin: 'downloads.libretexts.org',
        },
      });
      if (licensingReportRes.status !== 200 || !licensingReportRes.data) {
        this.logger
          .withMetadata({ bookID: pageInfo.pageID.toString() })
          .info('No detailed licensing report found or error encountered.');
      }

      const anchorMap = new Map<string, string>();
      for (const page of this._allPages) {
        anchorMap.set(page.url, `#page-${page.pageID}`);
      }

      const licensingBodyHTML = `
        <div id="libre-print-directory-header-container">
          <h1 id="libre-print-directory-header">Detailed Licensing</h1>
        </div>
        <div id="libre-detailed-licensing">
          ${generateDetailedLicensingHTML(licensingReportRes.data, anchorMap)}
        </div>
      `;

      const outputPath = await this.convertPage({
        htmlOnly,
        pageID: pageInfo.pageID,
        pageInfo,
        pageBodyHTML: licensingBodyHTML,
        additionalCSS: pdfTOCStyles + '\n' + pdfDetailedLicensingStyles,
        sortKey,
        pageOffset,
      });

      this.logger.withMetadata({ url: pageInfo.url }).info('Finished Detailed Licensing generation.');
      return outputPath;
    } catch (error) {
      this.logger.withMetadata({ url: pageInfo.url, error }).error('Detailed Licensing generation failed');
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

    // Build treeMap, parentMap, and set rootPageID on the instance so groupTasksIntoChapters
    // can walk the hierarchy without re-traversing the tree.
    this._treeMap.clear();
    this._parentMap.clear();
    this._rootPageID = tree.pageID.toString();
    this.buildMaps(tree);

    // Log all back matter pages for debugging
    const backMatterPages = pages.filter((p) => p.matterType === 'Back');
    this.logger
      .withMetadata({
        backMatterPages: backMatterPages.map((p) => ({
          title: p.title,
          url: p.url,
        })),
      })
      .info('Back matter pages discovered');

    // Process flat array with correct ordering and TOC placement
    for (const p of pages) {
      if (p.pageID.toString() === this._rootPageID) continue; // don't include actual cover page with page listing
      const idx = `${conversionTasks.length + 1}`.padStart(4, '0');
      const treeNode = this._treeMap.get(p.pageID.toString());

      // The front matter "Table of Contents" page uses the root book hierarchy to generate
      // a full-book TOC. It outputs at the front matter position, replacing the CXOne template placeholder.
      if (p.matterType === 'Front' && p.title === 'Table of Contents') {
        frontMatterIdx += 1;
        const tocFileName = `0000:${frontMatterIdx}`;
        conversionTasks.push({
          _id: 'toc-main',
          pageID: p.pageID,
          pageInfo: tree, // root node carries the full hierarchy needed by getLevel()
          fileName: tocFileName,
          sortKey: tocFileName,
          subtype: 'main-toc',
          type: 'toc',
        });
        continue;
      }

      // The back matter "Index" page is replaced server-side by a generated alphabetical
      // term index built from all content-page tags.
      if (p.matterType === 'Back' && p.title === 'Index') {
        backMatterIdx += 1;
        const idxFileName = `9999:${backMatterIdx}`;
        conversionTasks.push({
          _id: 'index-main',
          pageID: p.pageID,
          pageInfo: p,
          fileName: idxFileName,
          sortKey: idxFileName,
          type: 'index',
        });
        continue;
      }

      // The back matter "Glossary" page is replaced server-side by a generated alphabetical
      // definition list parsed from the CXOne table authored by instructors.
      if (p.matterType === 'Back' && p.title === 'Glossary') {
        backMatterIdx += 1;
        const glossFileName = `9999:${backMatterIdx}`;
        conversionTasks.push({
          _id: 'glossary-main',
          pageID: p.pageID,
          pageInfo: p,
          fileName: glossFileName,
          sortKey: glossFileName,
          type: 'glossary',
        });
        continue;
      }

      // The back matter "Detailed Licensing" page is replaced by a server-side generated report.
      if (p.matterType === 'Back' && p.title === 'Detailed Licensing') {
        backMatterIdx += 1;
        const dlFileName = `9999:${backMatterIdx}`;
        conversionTasks.push({
          _id: 'detailed-licensing-main',
          pageID: p.pageID,
          pageInfo: tree, // needs full hierarchy contained in root node
          fileName: dlFileName,
          sortKey: dlFileName,
          type: 'detailed-licensing',
        });
        continue;
      }

      // TODO: Re-enable chapter/section TOC generation once main TOC placement is stable.
      // Chapter/section directory pages will eventually get their own TOC page at the start of each chapter.
      if (
        treeNode &&
        Array.isArray(treeNode.subpages) &&
        treeNode.subpages.length > 1 &&
        (p.tags.includes('article:topic-category') || p.tags.includes('article:topic-guide')) &&
        !['Back Matter', 'Front Matter'].some((t) => p.title.includes(t)) &&
        p.pageID.toString() !== tree.pageID.toString() // guard: root book page TOC is handled by toc-main
      ) {
        const chapterFileName = `${idx}_TOC`;
        conversionTasks.push({
          _id: `toc-${p.pageID}`,
          pageID: p.pageID,
          pageInfo: treeNode, // tree node retains subpages for getLevel()
          fileName: chapterFileName,
          sortKey: chapterFileName,
          type: 'toc',
        });
        continue;
      }

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

    // Always emit an index task at the end of back matter, regardless of whether the
    // book has a CXOne Index placeholder page.  Server-side index generation doesn't
    // need a CXOne page to exist — it derives terms directly from content page tags.
    // When a real CXOne Index page was found above, the task was already pushed and
    // the check below is a no-op.
    const hasIndexTask = conversionTasks.some((t) => t.type === 'index');
    if (!hasIndexTask) {
      backMatterIdx += 1;
      const idxFileName = `9999:${backMatterIdx}`;
      conversionTasks.push({
        _id: 'index-main',
        pageID: tree.pageID,
        pageInfo: tree,
        fileName: idxFileName,
        sortKey: idxFileName,
        type: 'index',
      });
    }

    return conversionTasks.sort((a, b) => a.fileName.localeCompare(b.fileName, undefined, { numeric: true }));
  }

  /**
   * Recursively populates `_treeMap` (pageID → BookPageInfo) and `_parentMap`
   * (child pageID → parent pageID) from the book tree root.
   */
  private buildMaps(node: BookPageInfo, parentIDStr?: string) {
    this._treeMap.set(node.pageID.toString(), node);
    if (parentIDStr) {
      this._parentMap.set(node.pageID.toString(), parentIDStr);
    }
    node.subpages?.forEach((child) => this.buildMaps(child, node.pageID.toString()));
  }

  /**
   * Walks up the parentMap from a given page to find its chapter-level ancestor —
   * the direct child of the root node. Returns the chapter ancestor's pageID string,
   * or null if the page is not a descendant of the root (orphan).
   */
  private findChapterAncestor(pageIDStr: string): string | null {
    let current = pageIDStr;
    let parent = this._parentMap.get(current);
    while (parent && parent !== this._rootPageID) {
      current = parent;
      parent = this._parentMap.get(current);
    }
    return parent === this._rootPageID ? current : null;
  }

  public getShouldShowMarginContent(pageInfo: BookPageInfo): boolean {
    return !['InfoPage', 'ProgramPage', 'Title Page', 'TitlePage'].includes(pageInfo.title);
  }

  /**
   * Groups a sorted ConversionTask array into PageGroups for chapter-level multi-file rendering.
   *
   * Content pages that share the same chapter ancestor (direct child of the root tree node)
   * are grouped into a single PageGroup and passed to Prince as multiple HTML files in one
   * invocation, reducing Prince subprocess overhead without combining HTML content.
   *
   * Front/back matter pages, TOC tasks, Index tasks, and orphan pages are always emitted
   * as single-task groups to preserve their specialized per-page layouts.
   *
   * The output array preserves the original sortKey ordering.
   */
  private groupTasksIntoChapters(tasks: ConversionTask[]): PageGroup[] {
    // chapterBuckets preserves insertion order (Map), so chapter groups stay in the
    // same relative order as the first page of each chapter in the sorted task list.
    const chapterBuckets = new Map<string, ConversionTask[]>();
    const soloGroups: Array<{ task: ConversionTask; insertionIndex: number }> = [];

    for (let i = 0; i < tasks.length; i++) {
      const task = tasks[i];

      // Non-page tasks and matter pages are always solo
      if (task.type !== 'page' || task.pageInfo.matterType === 'Front' || task.pageInfo.matterType === 'Back') {
        soloGroups.push({ task, insertionIndex: i });
        continue;
      }

      const ancestorID = this.findChapterAncestor(task.pageID.toString());
      if (!ancestorID) {
        // Orphan page — not in the tree, emit solo
        soloGroups.push({ task, insertionIndex: i });
        continue;
      }

      const bucket = chapterBuckets.get(ancestorID);
      if (bucket) {
        bucket.push(task);
      } else {
        chapterBuckets.set(ancestorID, [task]);
      }
    }

    // Build PageGroup objects for chapter buckets.
    // Split any that exceed MAX_PAGES_PER_GROUP to bound Prince memory use per invocation.
    // Each group uses isPacked: false — pages are rendered as separate HTML files, not combined.
    const chapterGroups: PageGroup[] = [];
    for (const [, bucketTasks] of chapterBuckets) {
      for (let offset = 0; offset < bucketTasks.length; offset += MAX_PAGES_PER_GROUP) {
        const slice = bucketTasks.slice(offset, offset + MAX_PAGES_PER_GROUP);
        const first = slice[0];
        chapterGroups.push({
          sortKey: first.sortKey,
          fileName: first.fileName,
          tasks: slice,
          isPacked: false,
        });
      }
    }

    // ── PACKING DISABLED ────────────────────────────────────────────────────────────────────────
    // The original packing approach combined all page HTML bodies into a single document per
    // chapter, which reduced whitespace but caused per-page header/footer styling issues.
    // Kept here for reference in case packing is re-evaluated.
    //
    // for (const [, bucketTasks] of chapterBuckets) {
    //   for (let offset = 0; offset < bucketTasks.length; offset += MAX_PAGES_PER_GROUP) {
    //     const slice = bucketTasks.slice(offset, offset + MAX_PAGES_PER_GROUP);
    //     const first = slice[0];
    //     chapterGroups.push({
    //       sortKey: first.sortKey,
    //       fileName: first.fileName,
    //       tasks: slice,
    //       isPacked: true,   // ← combined HTML packing
    //     });
    //   }
    // }
    // ────────────────────────────────────────────────────────────────────────────────────────────

    // Build PageGroup objects for solo tasks
    const soloPageGroups: PageGroup[] = soloGroups.map(({ task }) => ({
      sortKey: task.sortKey,
      fileName: task.fileName,
      tasks: [task],
      isPacked: false,
    }));

    // Merge and sort by sortKey to preserve original ordering
    return [...chapterGroups, ...soloPageGroups].sort((a, b) =>
      a.sortKey.localeCompare(b.sortKey, undefined, { numeric: true }),
    );
  }

  /**
   * Converts a PageGroup to a PDF file on disk, or (when `htmlOnly` is true) generates
   * HTML temp files and returns their paths without invoking Prince.
   *
   * Single-task groups (front/back matter, TOC, Index, Glossary, orphan pages) delegate
   * to the existing per-task conversion methods.
   *
   * Multi-task chapter groups use a multi-file Prince invocation: each page is rendered
   * to its own HTML file (with correct per-page header/footer), then all files are passed
   * to Prince in one invocation. This preserves per-page styling while reducing subprocess
   * overhead compared to one invocation per page.
   *
   * @param prerendered - Pre-rendered math results from Phase 1, keyed per task.
   *   When provided, math rendering is skipped inside this method.
   * @param htmlOnly - When true, returns HTML temp file paths instead of running Prince.
   *   Callers are responsible for cleaning up the temp files.
   */
  private async convertPageGroup(
    group: PageGroup,
    prerendered: PrerenderedTask[] | null = null,
    pageOffset?: number,
    htmlOnly = false,
  ): Promise<string | string[] | null> {
    const task = group.tasks[0];

    // Single-task path — dispatch to existing per-task conversion methods.
    // Each returns a single path (PDF or HTML depending on htmlOnly).
    if (group.tasks.length === 1) {
      let result: string | null = null;
      if (task.type === 'toc') {
        result = await this.generateTableOfContents({
          htmlOnly,
          pageInfo: task.pageInfo,
          isMainTOC: task.subtype === 'main-toc',
          sortKey: task.sortKey,
          pageOffset,
        });
      } else if (task.type === 'index') {
        result = await this.generateIndex({
          htmlOnly,
          pageInfo: task.pageInfo,
          allPages: this._allPages,
          sortKey: task.sortKey,
          pageOffset,
        });
      } else if (task.type === 'glossary') {
        result = await this.generateGlossary({
          htmlOnly,
          pageInfo: task.pageInfo,
          sortKey: task.sortKey,
          pageOffset,
        });
      } else if (task.type === 'detailed-licensing') {
        result = await this.generateDetailedLicensing({
          htmlOnly,
          pageInfo: task.pageInfo,
          sortKey: task.sortKey,
          pageOffset,
        });
      } else {
        const rawBody = task.pageInfo.body.join('');
        const listing = await this.getLevel(task.pageInfo);
        const directoryHTML = this.processDirectoryPage({
          html: rawBody,
          listing,
          tags: task.pageInfo.tags,
          title: task.pageInfo.title,
        });

        result = await this.convertPage({
          htmlOnly,
          pageID: task.pageID,
          pageInfo: task.pageInfo,
          pageBodyHTML: directoryHTML ?? rawBody,
          preRenderedBodyHTML: prerendered?.[0]?.renderedBody,
          pageHeadHTML: task.pageInfo.head,
          pageTailHTML: task.pageInfo.tail,
          additionalCSS: directoryHTML ? pdfTOCStyles : undefined,
          sortKey: task.sortKey,
          pageOffset,
        });
      }

      // Wrap single-task result in an array for htmlOnly so callers always get string[].
      if (htmlOnly && result) return [result];
      return result;
    }

    // Multi-file path — one HTML file per page, one Prince invocation for the chapter group.
    // Each page gets its own header/footer (correct per-page section numbers). Prince processes
    // multiple input files as a single document flow, updating running elements as it goes.
    const tempPaths: string[] = [];
    try {
      this.logger
        .withMetadata({ sortKey: group.sortKey, pageCount: group.tasks.length })
        .info(`${htmlOnly ? 'Generating HTML for' : 'Converting'} chapter group (multi-file)`);

      for (let i = 0; i < group.tasks.length; i++) {
        const t = group.tasks[i];

        const rawBody = t.pageInfo.body.join('');
        const listing = await this.getLevel(t.pageInfo);
        const directoryHTML = this.processDirectoryPage({
          html: rawBody,
          listing,
          tags: t.pageInfo.tags,
          title: t.pageInfo.title,
        });

        const preRendered = prerendered?.find((p) => p.task._id === t._id)?.renderedBody;
        const anchor = `<span id="page-${t.pageID}" class="pdf-anchor">&#8203;</span>`;
        const renderedBody = this.sanitizeImagesForPDF(
          directoryHTML != null
            ? `${anchor}${await prerenderMath(directoryHTML, t.pageInfo)}`
            : (preRendered ?? (await prerenderMath(this.addPageTitle(t.pageInfo, rawBody), t.pageInfo))),
        );
        const cleanedHeadHTML = stripBlocklistedScripts(stripMathJaxScripts(t.pageInfo.head));
        const shouldShowMarginContent = this.getShouldShowMarginContent(t.pageInfo);
        const headerHTML = shouldShowMarginContent ? generatePDFHeader(ImageConstants['default']) : '';
        const sectionNum = extractPageNumberPrefix(t.pageInfo.title).replace(/\.$/, '');
        const footerHTML = shouldShowMarginContent ? generatePDFFooter({ sectionNum }) : '';

        // Inject counter-reset only in the first file — Prince treats multi-file input as one
        // continuous document, so resetting in each file would restart numbering per-page.
        const pageCounterCSS =
          i === 0 && pageOffset !== undefined ? `<style>html { counter-reset: page ${pageOffset + 1}; }</style>` : '';

        // TODO: lang attr for non-English texts
        const wrappedHTML = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>${t.pageInfo.printInfo?.title || t.pageInfo.title || 'Unknown'}</title>
  <style>${pdfFontCSS}</style>
  <style>${pdfPageCSS}</style>
  <style>${pdfTableCSS}</style>
  <style>${pdfHeaderCSS}</style>
  <style>:root { --pdf-main-color: #127BC4; }</style>
  ${directoryHTML ? `<style>${pdfTOCStyles}</style>` : ''}
  ${pageCounterCSS}
  ${cleanedHeadHTML}
</head>
<body>
${headerHTML}
${footerHTML}
${renderedBody}
${stripBlocklistedScripts(t.pageInfo.tail ?? '')}
</body>
</html>
        `.trim();

        tempPaths.push(await this._createTempFile(wrappedHTML));
      }

      // In htmlOnly mode, return the temp paths for the caller to pass to Prince later.
      if (htmlOnly) return tempPaths;

      const outputPath = await this.generatePageOutputFilePath(task.pageID, group.sortKey);
      await this.runPrinceConversion({
        inputPath: tempPaths,
        outputPath,
        pageInfo: task.pageInfo,
      });

      this.logger
        .withMetadata({ outputPath, pageCount: group.tasks.length })
        .info('Converted chapter group (multi-file).');
      return outputPath;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : JSON.stringify(error);
      this.logger
        .withMetadata({ error, errorMessage, group: group.fileName })
        .error('Multi-file chapter group conversion failed');
      throw error;
    } finally {
      // Only clean up temp files when Prince was run (not in htmlOnly mode).
      if (!htmlOnly) {
        await Promise.all(tempPaths.map((p) => this._deleteTempFile(p).catch(() => {})));
      }
    }

    // ── PACKING DISABLED ────────────────────────────────────────────────────────────────────────
    // The original packing approach combined all page HTML bodies into a single HTML document
    // per chapter group, which eliminated excess whitespace but caused per-page header/footer
    // styling issues (all pages in a group shared the first page's section number in the footer).
    // Kept here for reference in case packing is re-evaluated.
    //
    // try {
    //   this.logger
    //     .withMetadata({ sortKey: group.sortKey, pageCount: group.tasks.length })
    //     .info('Converting packed chapter group');
    //
    //   let rendered: Array<{ task: ConversionTask; body: string }>;
    //   if (prerendered) {
    //     rendered = prerendered.map((p) => ({ task: p.task, body: p.renderedBody }));
    //   } else {
    //     rendered = [];
    //     for (const t of group.tasks) {
    //       rendered.push({ task: t, body: await prerenderMath(t.pageInfo.body.join(''), t.pageInfo) });
    //     }
    //   }
    //
    //   const packedBodyHTML = rendered
    //     .map(
    //       ({ task: t, body }) =>
    //         `<div class="packed-page" data-page-id="${t.pageID}">\n${this.sanitizeImagesForPDF(body)}\n</div>`,
    //     )
    //     .join('\n');
    //
    //   const firstTaskInfo = task.pageInfo;
    //   const cleanedHeadHTML = stripMathJaxScripts(firstTaskInfo.head);
    //   const headerHTML = generatePDFHeader(ImageConstants['default']);
    //   const sectionNum = extractPageNumberPrefix(firstTaskInfo.title).replace(/\.$/, '');
    //   const footerHTML = generatePDFFooter({ sectionNum });
    //
    //   const wrappedHTML = `
    // <!DOCTYPE html>
    // <html lang="en">
    // <head>
    //   <meta charset="UTF-8">
    //   <style>${pdfFontCSS}</style>
    //   <style>${pdfPageCSS}</style>
    //   <style>${pdfHeaderCSS}</style>
    //   <style>:root { --pdf-main-color: #127BC4; }</style>
    //   ${cleanedHeadHTML}
    // </head>
    // <body>
    // ${headerHTML}
    // ${footerHTML}
    // ${packedBodyHTML}
    // </body>
    // </html>
    //   `.trim();
    //
    //   const outputPath = await this.generatePageOutputFilePath(firstTaskInfo.pageID, group.sortKey);
    //   await this.withTempFile(wrappedHTML, (inputPath) => this.runPrinceConversion(inputPath, outputPath));
    //
    //   this.logger.withMetadata({ outputPath, pageCount: group.tasks.length }).info('Converted packed chapter group.');
    //   return outputPath;
    // } catch (error) {
    //   const errorMessage = error instanceof Error ? error.message : JSON.stringify(error);
    //   this.logger.withMetadata({ error, errorMessage, group: group.fileName }).error('Packed group conversion failed');
    //   throw error;
    // }
    // ────────────────────────────────────────────────────────────────────────────────────────────
  }

  private async streamFileToS3(outPath: string) {
    // Stream the file to S3 — avoids holding a second Buffer copy in memory
    const stream = createReadStream(outPath);
    const uploader = this.storageService.createStreamUploader({
      contentType: 'application/pdf',
      key: fsPathToS3Key(outPath),
      stream,
    });
    if (!uploader) throw new Error('Failed to create S3 stream uploader for content PDF');
    await uploader?.done();
  }

  private async cleanupLocalArtifacts({ finalFilePath }: { finalFilePath: string }) {
    const logData = { bookID: this._bookID.toString(), finalFilePath };
    try {
      await fs.unlink(finalFilePath);
      this.logger.withMetadata(logData).info('Cleaned up local artifacts');
    } catch (error) {
      this.logger.withMetadata(logData).withError(error).warn('Failed to clean up local artifacts');
    }
  }

  /**
   * Removes the workdir for this book, deleting all intermediate group PDFs and the
   * merged content PDF.  Called on job failure to prevent orphaned temp files from
   * accumulating on disk across retries.
   */
  public async cleanupWorkdir(): Promise<void> {
    const baseDir = Environment.getOptional('TMP_OUT_DIR', './.tmp');
    const workdir = resolve(`${baseDir}/pdf/${this._bookID.toString()}/workdir`);
    try {
      await fs.rm(workdir, { recursive: true, force: true });
      this.logger.withMetadata({ workdir }).info('Cleaned up workdir');
    } catch (error) {
      this.logger.withMetadata({ workdir, error }).warn('Failed to clean up workdir');
    }
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
