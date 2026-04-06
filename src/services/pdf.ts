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
} from '../util/pdfHelpers';
import { buildTagIndex, generateIndexHTML } from '../util/indexHelpers';
import { parseGlossaryTable, buildGlossaryData, generateGlossaryHTML } from '../util/glossaryHelpers';
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
  type: 'page' | 'toc' | 'index' | 'glossary';
};

/**
 * A group of ConversionTasks to be rendered in a single Prince invocation.
 * Content pages that share a chapter ancestor are packed into one group to eliminate
 * excess whitespace where a page ends with only a few lines before the next page begins.
 * Front/back matter, TOC, and Index tasks are always solo groups (isPacked: false).
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
            rendered.push({ task: t, renderedBody: await prerenderMath(t.pageInfo.body.join(''), t.pageInfo) });
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

      // ── Phase 2: Convert groups in parallel (bounded by PRINCE_CONCURRENCY) ──
      const princeConcurrency =
        parseInt(Environment.getOptional('PRINCE_CONCURRENCY', String(DEFAULT_PRINCE_CONCURRENCY)), 10) ||
        DEFAULT_PRINCE_CONCURRENCY;
      const princeLimit = pLimit(princeConcurrency);
      this.logger
        .withMetadata({ totalGroups: pageGroups.length, princeConcurrency })
        .info('Converting page groups in parallel');

      const groupResults = await Promise.allSettled(
        pageGroups.map((group) =>
          princeLimit(async () => {
            if (Date.now() - startTime > CIRCUIT_BREAKER_CONFIG.maxJobDurationMs) {
              throw new Error('Job exceeded maximum duration (4 hours)');
            }
            const prerendered = prerenderedMap.get(group.sortKey) ?? null;
            const result = await this.retryWithBackoff(
              () => this.convertPageGroup(group, prerendered),
              `Convert group: ${group.fileName} (${group.tasks.length} page(s))`,
            );
            return { group, result };
          }),
        ),
      );

      let failureCount = 0;
      for (const r of groupResults) {
        if (r.status === 'rejected') {
          failureCount++;
          this.logger.withMetadata({ error: r.reason }).error('Group conversion promise rejected');
        } else if (!r.value.result.success) {
          failureCount++;
          this.logger
            .withMetadata({ error: r.value.result.error, group: r.value.group.fileName })
            .error('Group failed after all retries');
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
    preRenderedBodyHTML,
    pageHeadHTML = '',
    pageTailHTML = '',
    additionalCSS,
    mainColor = '#127BC4',
    sortKey,
  }: {
    pageID: PageID;
    pageInfo: BookPageInfo;
    pageBodyHTML: string;
    /** If supplied, skips the prerenderMath call (math was pre-rendered in Phase 1). */
    preRenderedBodyHTML?: string;
    pageHeadHTML?: string;
    pageTailHTML?: string;
    additionalCSS?: string;
    mainColor?: string;
    sortKey: string;
  }) {
    try {
      // Use pre-rendered math if available (Phase 1 pre-render), otherwise render now.
      const renderedBodyHTML = this.sanitizeImagesForPDF(
        preRenderedBodyHTML ?? (await prerenderMath(pageBodyHTML, pageInfo)),
      );
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
        .filter((s) => !/^\s*(width|height)\s*:/.test(s))
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
  }: {
    pageInfo: BookPageInfo;
    allPages: BookPageInfo[];
    sortKey: string;
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
  private async generateGlossary({ pageInfo, sortKey }: { pageInfo: BookPageInfo; sortKey: string }) {
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
      });

      this.logger.withMetadata({ url: pageInfo.url }).info('Finished Glossary generation.');
      return outputPath;
    } catch (error) {
      this.logger.withMetadata({ url: pageInfo.url, error }).error('Glossary generation failed');
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
      const idx = `${conversionTasks.length + 1}`.padStart(4, '0');
      //const treeNode = this._treeMap.get(p.pageID.toString());

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

  /**
   * Groups a sorted ConversionTask array into PageGroups for chapter-level packing.
   *
   * Content pages that share the same chapter ancestor (direct child of the root tree node)
   * are merged into a single PageGroup and passed to Prince as one HTML document, eliminating
   * the excess whitespace that accumulates when a page ends after only a few lines.
   *
   * Front/back matter pages, TOC tasks, and Index tasks are always emitted as solo groups
   * (isPacked: false) to preserve their specialized per-page layouts.
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

    // Build PageGroup objects for chapter buckets, splitting any that exceed MAX_PAGES_PER_GROUP
    const chapterGroups: PageGroup[] = [];
    for (const [, bucketTasks] of chapterBuckets) {
      for (let offset = 0; offset < bucketTasks.length; offset += MAX_PAGES_PER_GROUP) {
        const slice = bucketTasks.slice(offset, offset + MAX_PAGES_PER_GROUP);
        const first = slice[0];
        chapterGroups.push({
          sortKey: first.sortKey,
          fileName: first.fileName,
          tasks: slice,
          isPacked: true,
        });
      }
    }

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
   * Solo groups (front/back matter, TOC, Index, or single-page chapters) delegate to
   * the existing per-task conversion methods. Packed groups (multiple content pages from
   * the same chapter) are pre-rendered sequentially through MathJax, concatenated into
   * a single HTML document, and passed to Prince in one invocation.
   */
  /**
   * Converts a PageGroup to a PDF file on disk.
   *
   * @param prerendered - Pre-rendered math results from Phase 1, keyed per task.
   *   When provided, math rendering is skipped inside this method.
   */
  private async convertPageGroup(
    group: PageGroup,
    prerendered: PrerenderedTask[] | null = null,
  ): Promise<string | null> {
    const task = group.tasks[0];

    // Solo path — dispatch to existing single-task methods
    if (!group.isPacked || group.tasks.length === 1) {
      if (task.type === 'toc') {
        return this.generateTableOfContents({
          pageInfo: task.pageInfo,
          isMainTOC: task.subtype === 'main-toc',
          sortKey: task.sortKey,
        });
      } else if (task.type === 'index') {
        return this.generateIndex({
          pageInfo: task.pageInfo,
          allPages: this._allPages,
          sortKey: task.sortKey,
        });
      } else if (task.type === 'glossary') {
        return this.generateGlossary({
          pageInfo: task.pageInfo,
          sortKey: task.sortKey,
        });
      } else {
        return this.convertPage({
          pageID: task.pageID,
          pageInfo: task.pageInfo,
          pageBodyHTML: task.pageInfo.body.join(''),
          preRenderedBodyHTML: prerendered?.[0]?.renderedBody,
          pageHeadHTML: task.pageInfo.head,
          pageTailHTML: task.pageInfo.tail,
          sortKey: task.sortKey,
        });
      }
    }

    // Packed path — merge multiple content pages into one Prince invocation
    try {
      this.logger
        .withMetadata({ sortKey: group.sortKey, pageCount: group.tasks.length })
        .info('Converting packed chapter group');

      // Use pre-rendered math from Phase 1 when available; fall back to inline rendering.
      let rendered: Array<{ task: ConversionTask; body: string }>;
      if (prerendered) {
        rendered = prerendered.map((p) => ({ task: p.task, body: p.renderedBody }));
      } else {
        // Fallback: render sequentially (should only occur if called outside the normal convertBook flow)
        rendered = [];
        for (const t of group.tasks) {
          rendered.push({ task: t, body: await prerenderMath(t.pageInfo.body.join(''), t.pageInfo) });
        }
      }

      const packedBodyHTML = rendered
        .map(
          ({ task: t, body }) =>
            `<div class="packed-page" data-page-id="${t.pageID}">\n${this.sanitizeImagesForPDF(body)}\n</div>`,
        )
        .join('\n');

      // Use the first task's pageInfo for header/footer context (chapter guide page).
      // The footer URL will point to the chapter's top-level page rather than individual sections.
      const firstTaskInfo = task.pageInfo;
      const cleanedHeadHTML = stripMathJaxScripts(firstTaskInfo.head);
      const headerHTML = generatePDFHeader(ImageConstants['default']);
      const footerHTML = generatePDFFooter({
        currentPage: firstTaskInfo,
        mainColor: '#127BC4',
        pageLicense: firstTaskInfo.license,
        prefix: '',
      });

      const wrappedHTML = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style>${pdfFontCSS}</style>
  <style>${pdfPageCSS}</style>
  <style>${pdfHeaderCSS}</style>
  <style>:root { --pdf-main-color: #127BC4; }</style>
  <style>${pdfFooterCSS}</style>
  ${cleanedHeadHTML}
</head>
<body>
${headerHTML}
${footerHTML}
${packedBodyHTML}
</body>
</html>
      `.trim();

      const outputPath = await this.generatePageOutputFilePath(firstTaskInfo.pageID, group.sortKey);
      await this.withTempFile(wrappedHTML, (inputPath) => this.runPrinceConversion(inputPath, outputPath));

      this.logger.withMetadata({ outputPath, pageCount: group.tasks.length }).info('Converted packed chapter group.');
      return outputPath;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : JSON.stringify(error);
      this.logger.withMetadata({ error, errorMessage, group: group.fileName }).error('Packed group conversion failed');
      throw error;
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
