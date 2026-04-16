import fs from 'node:fs/promises';
import { readFileSync, createReadStream } from 'node:fs';
import pLimit from 'p-limit';
import { v4 as uuid } from 'uuid';
import { join, resolve } from 'node:path';
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
  pdfFooterCSS,
  pdfDetailedLicensingStyles,
} from '../util/pdfHelpers';
import { buildTagIndex, generateIndexHTML } from '../util/indexHelpers';
import { parseGlossaryTable, buildGlossaryData, generateGlossaryHTML } from '../util/glossaryHelpers';
import { ImageConstants } from '../util/imageConstants';
import { sleep } from '../helpers';
import { log as logService } from '../lib/log';
import { PDFDocument } from 'pdf-lib';
import { LogLayer } from 'loglayer';
import { Environment } from '../lib/environment';
import { StorageService } from '../lib/storageService';
import { getDirectoryPathFromFilePath } from '../util/fsHelpers';
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

const __dirname = dirname(fileURLToPath(import.meta.url));

// CSS loaded at module init and inlined into HTML sent to Prince.
// Note: changes to this file require a server restart in development.
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
 * Maximum number of content pages that may be packed into a single Prince invocation.
 * Large chapters beyond this limit are split into sequential sub-groups, each rendered
 * separately and merged by pdf-lib — avoiding excessive memory use in Prince for
 * books with very large chapters.
 */
const MAX_PAGES_PER_GROUP = 6;

/**
 * Maximum number of Prince subprocesses running concurrently.
 * Prince is CPU/I-O bound; 4 concurrent invocations balances throughput against
 * resource pressure. Tune via PRINCE_CONCURRENCY env var.
 */
const DEFAULT_PRINCE_CONCURRENCY = 4;

/**
 * Number of individual group PDFs merged in each batch pass.
 * Bounds peak memory during merging to roughly MERGE_BATCH_SIZE × avg-group-pdf-size.
 * Tune via MERGE_BATCH_SIZE env var.
 */
const DEFAULT_MERGE_BATCH_SIZE = 25;

/** Represents the pre-rendered math output for a single ConversionTask. */
type PrerenderedTask = { task: ConversionTask; renderedBody: string };

export class PDFService {
  private _bookID!: PageID;
  private _useLocalStorage: boolean = false;
  private _convertedPagePaths: string[] = [];
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

    this.logger = logService.child().withContext({ logSource: this.logName, bookID: this._bookID.toString() });
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
        .withMetadata({ totalTasks: conversionTasks.length, totalGroups: pageGroups.length })
        .info('Built conversion task list and page groups');

      // ── Phase 1: Pre-render MathJax for all groups sequentially ──────────────
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

      // ── Phase 2: Convert groups in two passes to produce correct page numbers ─
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

      // ── Phase 2a: Pass 1 ─────────────────────────────────────────────────────
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

      // ── Phase 2b: Count pages per group, compute cumulative offsets ───────────
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
            .withMetadata({ error: r.value.result.error, group: r.value.group.fileName })
            .error('Group failed Pass 1 after all retries');
        } else if (r.value.result.result) {
          const pageCount = await this.countPdfPages(r.value.result.result);
          pass1Counts.push({ group: r.value.group, pageCount });
        }
      }

      if (pass1FailureCount >= CIRCUIT_BREAKER_CONFIG.maxConsecutiveFailures) {
        throw new Error(`Job failed in Pass 1: ${pass1FailureCount} group(s) failed to convert`);
      }

      // Sort in the same order as mergeContentPagesAndWrite so offsets accumulate correctly
      pass1Counts.sort((a, b) => a.group.sortKey.localeCompare(b.group.sortKey, undefined, { numeric: true }));
      const groupOffsets = new Map<string, number>();
      let cumulativeOffset = 0;
      for (const { group, pageCount } of pass1Counts) {
        groupOffsets.set(group.sortKey, cumulativeOffset);
        cumulativeOffset += pageCount;
      }
      this.logger
        .withMetadata({ totalGroups: pass1Counts.length, totalPages: cumulativeOffset })
        .info('Pass 2: re-generating group PDFs with correct page offsets');

      // ── Phase 2c: Pass 2 — re-render with correct --page-offset ──────────────
      // Output paths are deterministic (generatePageOutputFilePath uses pageID + sortKey),
      // so Pass 2 overwrites Pass 1 files without a separate deletion step.
      const pass2Results = await Promise.allSettled(
        pageGroups.map((group) =>
          princeLimit(async () => {
            if (Date.now() - startTime > CIRCUIT_BREAKER_CONFIG.maxJobDurationMs) {
              throw new Error('Job exceeded maximum duration (4 hours)');
            }
            const prerendered = prerenderedMap.get(group.sortKey) ?? null;
            const pageOffset = groupOffsets.get(group.sortKey) ?? 0;
            const result = await this.retryWithBackoff(
              () => this.convertPageGroup(group, prerendered, pageOffset),
              `Pass 2 group: ${group.fileName} (${group.tasks.length} page(s))`,
            );
            return { group, result };
          }),
        ),
      );

      // ── Phase 2d: Collect Pass 2 results ─────────────────────────────────────
      let failureCount = 0;
      for (const r of pass2Results) {
        if (r.status === 'rejected') {
          failureCount++;
          this.logger.withMetadata({ error: r.reason }).error('Group Pass 2 promise rejected');
        } else if (!r.value.result.success) {
          failureCount++;
          this.logger
            .withMetadata({ error: r.value.result.error, group: r.value.group.fileName })
            .error('Group failed Pass 2 after all retries');
        } else {
          if (r.value.result.result) this._convertedPagePaths.push(r.value.result.result);
        }
      }

      if (failureCount >= CIRCUIT_BREAKER_CONFIG.maxConsecutiveFailures) {
        throw new Error(`Job failed: ${failureCount} group(s) failed to convert`);
      }

      // All pages converted successfully, merge and generate covers
      this.logger.info('All pages converted, merging content');
      const { filePath: contentFilePath, pageCount: numPages } = await this.mergeContentPagesAndWrite();

      // Generate covers with retry
      this.logger.info('Generating covers');
      const coverConfigs = PDF_COVER_TYPES.map((coverType) => ({
        coverType,
        numPages: COVER_TYPE_CONFIG[coverType].usesPageCount ? numPages : null,
        opt: COVER_TYPE_CONFIG[coverType].opt,
      }));

      // TODO: does pages contain the cover page or only true content pages?
      const coverPageInfo = pagesMap.get(this._bookID.toString());

      const coversPath = await this.ensureCoversDirectory();
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

      return await this.mergeToFullDocumentAndWrite({
        coverFilePath: `${coversPath}/Main.pdf`,
        contentFilePath,
      });
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
    const filePath = join(basePath, `/${this._bookID.toString()}.pdf`);

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
    const titleExclusions = ['Detailed Licensing', 'Glossary', 'Index', 'InfoPage', 'TitlePage', 'Table of Contents'];
    const isInExcludedList = titleExclusions.some((e) => pageInfo.title.includes(e));
    const isTableOfContents = pageInfo.pageID.pageNum === this._bookID.pageNum;
    const hasChildren = !!pageInfo.subpages?.length;
    const shouldRenderTitle = !(isInExcludedList || isTableOfContents || hasChildren);
    const pageTitleElem = shouldRenderTitle ? `<h1>${pageInfo.title}</h1>` : '';
    return `${pageTitleElem}${raw}`;
  }

  private decodeHTML(raw: string) {
    // Protect &quot; (used in attribute values) from being decoded to a bare " that
    // would break HTML attribute quoting. All other named entities — including curly
    // quotes like &ldquo; / &rdquo; / &rsquo; — are decoded to their unicode equivalents
    // so Prince receives plain text rather than literal entity strings.
    return decode(raw.replaceAll('&quot;', 'QUOT_REPL'), { level: 'html5' }).replace(/QUOT_REPL/g, '&quot;');
  }

  private async convertPage({
    additionalCSS,
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

      const headerHTML = this.getShouldShowHeader(pageInfo) ? generatePDFHeader(ImageConstants['default']) : '';
      const sectionNum = extractPageNumberPrefix(pageInfo.title).replace(/\.$/, '');
      const footerHTML = generatePDFFooter({ sectionNum });

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
  <style>${pdfTableCSS}</style>
  <style>${pdfHeaderCSS}</style>
  <style>:root { --pdf-main-color: ${mainColor}; }</style>
  <style>${pdfFooterCSS}</style>
  ${pageOffset ? `<style>html { counter-reset: page ${pageOffset}; }</style>` : ''}
  ${additionalCSS ? `<style>${additionalCSS}</style>` : ''}
  ${cleanedHeadHTML}
</head>
<body>
${headerHTML}
${renderedBodyHTML}
${footerHTML}
${stripBlocklistedScripts(pageTailHTML)}
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
  private async runPrinceConversion(inputPath: string | string[], outputPath: string) {
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

  /** Returns the page count of an existing PDF file. Used between Pass 1 and Pass 2 to compute per-group page offsets. */
  private async countPdfPages(filePath: string): Promise<number> {
    const bytes = await fs.readFile(filePath);
    const doc = await PDFDocument.load(bytes);
    return doc.getPageCount();
  }

  /**
   * Merges a list of PDF files into a single PDFDocument, processing them in
   * batches of MERGE_BATCH_SIZE to bound peak memory usage.
   *
   * Without batching, loading all 250+ group PDFs simultaneously can exhaust
   * available RAM (pdf-lib has no streaming API).  Batching keeps each pass to
   * ~MERGE_BATCH_SIZE × avg-pdf-size in memory at a time.
   *
   * @returns The merged PDF as a Uint8Array and the total page count.
   */
  private async mergeFiles(
    files: string[],
    metadata?: {
      author: string;
      isContent?: boolean;
      isPreview?: boolean;
      title: string;
    },
  ): Promise<{ data: Uint8Array; pageCount: number }> {
    const mergeBatchSize =
      parseInt(Environment.getOptional('MERGE_BATCH_SIZE', String(DEFAULT_MERGE_BATCH_SIZE)), 10) ||
      DEFAULT_MERGE_BATCH_SIZE;

    if (files.length <= mergeBatchSize) {
      return this._mergeFilesRaw(files, metadata);
    }

    // Two-tier batched merge: merge chunks → write batch temp files → merge batches
    this.logger
      .withMetadata({ totalFiles: files.length, mergeBatchSize })
      .info('Large merge: using batched two-tier strategy');

    const batchPaths: string[] = [];
    try {
      for (let i = 0; i < files.length; i += mergeBatchSize) {
        const batch = files.slice(i, i + mergeBatchSize);
        const { data } = await this._mergeFilesRaw(batch);
        const batchPath = await this._writeTempPDF(data);
        batchPaths.push(batchPath);
        this.logger
          .withMetadata({ batchIndex: Math.floor(i / mergeBatchSize), batchSize: batch.length })
          .debug('Batch merged');
      }
      return await this._mergeFilesRaw(batchPaths, metadata);
    } finally {
      // Always clean up batch temp files even if final merge throws
      await Promise.all(batchPaths.map((p) => fs.unlink(p).catch(() => {})));
    }
  }

  /** Low-level merge: loads and copies all given PDF files into one document. */
  private async _mergeFilesRaw(
    files: string[],
    metadata?: {
      author: string;
      isContent?: boolean;
      isPreview?: boolean;
      title: string;
    },
  ): Promise<{ data: Uint8Array; pageCount: number }> {
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

    const data = await outputDocument.save();
    return { data, pageCount: outputDocument.getPageCount() };
  }

  /** Writes a PDF Uint8Array to a uniquely-named temp file and returns its path. */
  private async _writeTempPDF(data: Uint8Array): Promise<string> {
    const tempDir = resolve('.tmp');
    await fs.mkdir(tempDir, { recursive: true });
    const tempPath = join(tempDir, `merge_batch_${uuid()}.pdf`);
    await fs.writeFile(tempPath, data);
    return tempPath;
  }

  /**
   * Merges all converted content page PDFs, uploads to storage, and cleans up
   * workdir intermediates.
   *
   * @returns The output file path and total page count (avoiding a redundant PDF reload).
   */
  private async mergeContentPagesAndWrite(): Promise<{ filePath: string; pageCount: number }> {
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

    const { data: mergedData, pageCount } = await this.mergeFiles(sortedPages);
    const outPath = await this.generateContentOutputFilePath();

    // Write merged PDF to its final local path first (needed by both storage paths)
    const dirPath = getDirectoryPathFromFilePath(outPath);
    await fs.mkdir(dirPath, { recursive: true });
    await fs.writeFile(outPath, mergedData);

    if (!this._useLocalStorage) {
      // Stream the file to S3 — avoids holding a second Buffer copy in memory
      const stream = createReadStream(outPath);
      const uploader = this.storageService.createStreamUploader({
        contentType: 'application/pdf',
        key: outPath,
        stream,
      });
      if (!uploader) throw new Error('Failed to create S3 stream uploader for content PDF');
      await uploader.done();
      // Remove the local temp copy after successful upload
      await fs.unlink(outPath).catch(() => {});
    }

    // Clean up all individual group PDFs now that merge is complete
    await Promise.all(sortedPages.map((p) => fs.unlink(p).catch(() => {})));

    return { filePath: outPath, pageCount };
  }

  private async mergeToFullDocumentAndWrite({
    contentFilePath,
    coverFilePath,
  }: {
    contentFilePath: string;
    coverFilePath: string;
  }) {
    const { data: mergedData } = await this.mergeFiles([coverFilePath, contentFilePath]);
    const outPath = await this.generateFullDocumentOutputFilePath();

    // Write merged PDF to its final local path first (needed by both storage paths)
    const dirPath = getDirectoryPathFromFilePath(outPath);
    await fs.mkdir(dirPath, { recursive: true });
    await fs.writeFile(outPath, mergedData);

    if (!this._useLocalStorage) {
      // Stream the file to S3 — avoids holding a second Buffer copy in memory
      const stream = createReadStream(outPath);
      const uploader = this.storageService.createStreamUploader({
        contentType: 'application/pdf',
        key: outPath,
        stream,
      });
      if (!uploader) throw new Error('Failed to create S3 stream uploader for content PDF');
      await uploader.done();
      // Remove the local temp copy after successful upload
      await fs.unlink(outPath).catch(() => {});
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
    pageOffset,
  }: {
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
    pageInfo,
    allPages,
    sortKey,
    pageOffset,
  }: {
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
    pageInfo,
    sortKey,
    pageOffset,
  }: {
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
    pageInfo,
    sortKey,
    pageOffset,
  }: {
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
      const licensingBodyHTML = `
        <div id="libre-print-directory-header-container">
          <h1 id="libre-print-directory-header">Detailed Licensing</h1>
        </div>
        <div id="libre-detailed-licensing">
          ${generateDetailedLicensingHTML(licensingReportRes.data)}
        </div>
      `;

      const outputPath = await this.convertPage({
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
      .withMetadata({ backMatterPages: backMatterPages.map((p) => ({ title: p.title, url: p.url })) })
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

  public getShouldShowHeader(pageInfo: BookPageInfo): boolean {
    return !['TitlePage', 'InfoPage'].includes(pageInfo.title);
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
   * Converts a PageGroup to a PDF file on disk.
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
   */
  private async convertPageGroup(
    group: PageGroup,
    prerendered: PrerenderedTask[] | null = null,
    pageOffset?: number,
  ): Promise<string | null> {
    const task = group.tasks[0];

    // Single-task path — dispatch to existing per-task conversion methods
    if (group.tasks.length === 1) {
      if (task.type === 'toc') {
        return this.generateTableOfContents({
          pageInfo: task.pageInfo,
          isMainTOC: task.subtype === 'main-toc',
          sortKey: task.sortKey,
          pageOffset,
        });
      } else if (task.type === 'index') {
        return this.generateIndex({
          pageInfo: task.pageInfo,
          allPages: this._allPages,
          sortKey: task.sortKey,
          pageOffset,
        });
      } else if (task.type === 'glossary') {
        return this.generateGlossary({
          pageInfo: task.pageInfo,
          sortKey: task.sortKey,
          pageOffset,
        });
      } else if (task.type === 'detailed-licensing') {
        return this.generateDetailedLicensing({
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

        return this.convertPage({
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
    }

    // Multi-file path — one HTML file per page, one Prince invocation for the chapter group.
    // Each page gets its own header/footer (correct per-page section numbers). Prince processes
    // multiple input files as a single document flow, updating running elements as it goes.
    const tempPaths: string[] = [];
    try {
      this.logger
        .withMetadata({ sortKey: group.sortKey, pageCount: group.tasks.length })
        .info('Converting chapter group (multi-file)');

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
        const renderedBody = this.sanitizeImagesForPDF(
          directoryHTML != null
            ? await prerenderMath(directoryHTML, t.pageInfo)
            : (preRendered ?? (await prerenderMath(rawBody, t.pageInfo))),
        );
        const cleanedHeadHTML = stripBlocklistedScripts(stripMathJaxScripts(t.pageInfo.head));
        const headerHTML = this.getShouldShowHeader(t.pageInfo) ? generatePDFHeader(ImageConstants['default']) : '';
        const sectionNum = extractPageNumberPrefix(t.pageInfo.title).replace(/\.$/, '');
        const footerHTML = generatePDFFooter({ sectionNum });

        // Inject counter-reset only in the first file — Prince treats multi-file input as one
        // continuous document, so resetting in each file would restart numbering per-page.
        const pageCounterCSS =
          i === 0 && pageOffset ? `<style>html { counter-reset: page ${pageOffset}; }</style>` : '';

        const wrappedHTML = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style>${pdfFontCSS}</style>
  <style>${pdfPageCSS}</style>
  <style>${pdfTableCSS}</style>
  <style>${pdfHeaderCSS}</style>
  <style>:root { --pdf-main-color: #127BC4; }</style>
  <style>${pdfFooterCSS}</style>
  ${directoryHTML ? `<style>${pdfTOCStyles}</style>` : ''}
  ${pageCounterCSS}
  ${cleanedHeadHTML}
</head>
<body>
${headerHTML}
${renderedBody}
${footerHTML}
${stripBlocklistedScripts(t.pageInfo.tail ?? '')}
</body>
</html>
        `.trim();

        tempPaths.push(await this._createTempFile(wrappedHTML));
      }

      const outputPath = await this.generatePageOutputFilePath(task.pageID, group.sortKey);
      await this.runPrinceConversion(tempPaths, outputPath);

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
      await Promise.all(tempPaths.map((p) => this._deleteTempFile(p).catch(() => {})));
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
    // <html>
    // <head>
    //   <meta charset="UTF-8">
    //   <style>${pdfFontCSS}</style>
    //   <style>${pdfPageCSS}</style>
    //   <style>${pdfHeaderCSS}</style>
    //   <style>:root { --pdf-main-color: #127BC4; }</style>
    //   <style>${pdfFooterCSS}</style>
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
