import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { join } from 'node:path';
import axios from 'axios';
import * as cheerio from 'cheerio';
import { LogLayer } from 'loglayer';
import pLimit from 'p-limit';
import { CXOneRateLimiter } from '../lib/cxOneRateLimiter';
import { Environment } from '../lib/environment';
import { log as logService } from '../lib/log';
import { BookPageInfo } from '../types/book';
import { optimizeImageBuffer } from '../util/imageOptimizer';
import { USER_AGENT } from '../util/util';

const DEFAULT_FETCH_CONCURRENCY = 8;
const IMAGE_FETCH_TIMEOUT_MS = 30_000;

/**
 * Print-resolution ceiling for content images, derived from the largest box an image can
 * ever occupy in the PDF: the content column is 7.25in wide (8.5in page less 0.625in
 * horizontal margins, see styles/pdf-page.css) and `img { max-height: 3in }` caps the
 * height. At 300dpi that is 2175x900px — under 2MP, comfortably below the 20MP limit our
 * print service enforces.
 */
const DEFAULT_MAX_WIDTH = 2175;
const DEFAULT_MAX_HEIGHT = 900;
const DEFAULT_JPEG_QUALITY = 80;

export interface ImageProcessingSummary {
  /** Total bytes of the source images that were replaced. */
  bytesBefore: number;
  /** Total bytes of their optimized replacements. */
  bytesAfter: number;
  /** Distinct image URLs encountered. */
  discovered: number;
  /** Images that could not be downloaded or written; originals left in place. */
  failed: number;
  /** Images deliberately left as-is (SVG, animated, data URI, already optimal). */
  skipped: number;
  /** Images replaced with an optimized local file. */
  optimized: number;
}

/**
 * Downloads, resamples, and re-encodes the images referenced by a book's HTML, rewriting
 * each `<img src>` to point at the local optimized file.
 *
 * This exists because Prince embeds raster images at their source pixel dimensions and
 * never resamples them: a 4000x3000 photo rendered into a 3in box is embedded at full
 * resolution, and anything that isn't already a JPEG is re-encoded as FlateDecode. Left
 * alone that produces PDFs several times larger than necessary, containing images the
 * print service rejects outright.
 *
 * Every URL is fetched and processed exactly once per book; the resulting local path is
 * reused across Prince's two numbering passes, the print edition, and the individual-pages
 * ZIP — which also removes the redundant downloads Prince was performing on each pass.
 */
export class ImageProcessor {
  private readonly _cache = new Map<string, string | null>();
  private readonly _jpegQuality: number;
  private readonly _limit: ReturnType<typeof pLimit>;
  private readonly _maxHeight: number;
  private readonly _maxWidth: number;
  private readonly _outputDir: string;
  private readonly logger: LogLayer;
  private _summary: ImageProcessingSummary = {
    bytesAfter: 0,
    bytesBefore: 0,
    discovered: 0,
    failed: 0,
    optimized: 0,
    skipped: 0,
  };

  constructor(opts: {
    bookID: string;
    jobID?: string;
    jpegQuality?: number;
    maxHeight?: number;
    maxWidth?: number;
    outputDir: string;
  }) {
    this._outputDir = opts.outputDir;
    this._maxWidth =
      opts.maxWidth ?? Number.parseInt(Environment.getOptional('IMAGE_MAX_WIDTH', String(DEFAULT_MAX_WIDTH)), 10);
    this._maxHeight =
      opts.maxHeight ?? Number.parseInt(Environment.getOptional('IMAGE_MAX_HEIGHT', String(DEFAULT_MAX_HEIGHT)), 10);
    this._jpegQuality =
      opts.jpegQuality ??
      Number.parseInt(Environment.getOptional('IMAGE_JPEG_QUALITY', String(DEFAULT_JPEG_QUALITY)), 10);
    const concurrency =
      Number.parseInt(Environment.getOptional('IMAGE_FETCH_CONCURRENCY', String(DEFAULT_FETCH_CONCURRENCY)), 10) ||
      DEFAULT_FETCH_CONCURRENCY;
    this._limit = pLimit(concurrency);
    this.logger = logService.child().withContext({
      bookID: opts.bookID,
      jobID: opts.jobID,
      logSource: 'ImageProcessor',
    });
  }

  /**
   * Optimizes every image referenced by the given pages, rewriting each page's body in
   * place. Pages whose images all fail to process are left exactly as they were, so a
   * failure here can never lose content — it only forfeits the size reduction.
   */
  public async optimizePages(pages: BookPageInfo[]): Promise<ImageProcessingSummary> {
    await fs.mkdir(this._outputDir, { recursive: true });

    // Phase 1: discover every distinct image URL across the whole book so they can be
    // fetched concurrently, rather than page-by-page.
    const urls = new Set<string>();
    for (const page of pages) {
      if (!page?.body?.length) continue;
      for (const url of this.collectImageURLs(page.body.join(''), page.subdomain)) urls.add(url);
    }
    this._summary.discovered = urls.size;
    if (!urls.size) return this._summary;

    // Phase 2: download + optimize, populating the URL -> local path cache.
    await Promise.all(Array.from(urls).map((url) => this._limit(() => this.resolveLocalPath(url))));

    // Phase 3: rewrite the HTML to point at whatever landed on disk.
    for (const page of pages) {
      if (!page?.body?.length) continue;
      const rewritten = this.rewriteHTML(page.body.join(''), page.subdomain);
      if (rewritten !== null) page.body = [rewritten];
    }

    this.logger.withMetadata({ ...this._summary }).info('Optimized book images for PDF rendering');
    return this._summary;
  }

  /** Removes the directory of optimized images. Safe to call when it was never created. */
  public async cleanup(): Promise<void> {
    await fs.rm(this._outputDir, { force: true, recursive: true }).catch(() => {});
  }

  /**
   * Resolves an `src` attribute to the absolute URL it will be fetched from, mirroring the
   * normalization the EPUB pipeline performs: force https, and resolve site-relative paths
   * against the page's own library subdomain. Returns null for sources we never touch.
   */
  private normalizeSrc(src: string | undefined, subdomain: string): string | null {
    if (!src) return null;
    const trimmed = src.trim();
    if (!trimmed || trimmed.startsWith('data:')) return null;
    try {
      const raw = /^https?:\/\//.test(trimmed)
        ? trimmed.replace(/^http:\/\//, 'https://')
        : trimmed.startsWith('//')
          ? `https:${trimmed}`
          : `https://${subdomain}.libretexts.org/${trimmed.replace(/^\//, '')}`;
      const url = new URL(raw);
      // SVG is vector — re-encoding it would only make it bigger and blurrier.
      if (url.pathname.toLowerCase().endsWith('.svg')) return null;
      return url.toString();
    } catch {
      return null;
    }
  }

  private collectImageURLs(html: string, subdomain: string): string[] {
    const $ = cheerio.load(html, { xmlMode: false });
    const found: string[] = [];
    $('img').each((_, el) => {
      const url = this.normalizeSrc($(el).attr('src'), subdomain);
      if (url) found.push(url);
    });
    return found;
  }

  /**
   * Rewrites `<img src>` to the local optimized file for every image that has one. Returns
   * null when nothing changed or the HTML could not be parsed, so the caller keeps the
   * original markup rather than a needlessly re-serialized copy of it.
   */
  private rewriteHTML(html: string, subdomain: string): string | null {
    try {
      const $ = cheerio.load(html, { xmlMode: false });
      let rewritten = 0;
      $('img').each((_, el) => {
        const $el = $(el);
        const url = this.normalizeSrc($el.attr('src'), subdomain);
        if (!url) return;
        const localPath = this._cache.get(url);
        if (!localPath) return; // never fetched, skipped, or failed — keep the remote URL
        $el.attr('src', localPath);
        // srcset would otherwise send Prince back to the original full-resolution asset.
        $el.removeAttr('srcset');
        rewritten++;
      });
      if (!rewritten) return null;
      return $('body').html() ?? html;
    } catch (error) {
      this.logger.withMetadata({ error }).warn('Failed to rewrite image sources; keeping original HTML');
      return null;
    }
  }

  /**
   * Fetches and optimizes a single image, returning the local file path (or null when the
   * original should be kept). Results — including negative ones — are cached per URL.
   */
  private async resolveLocalPath(url: string): Promise<string | null> {
    const cached = this._cache.get(url);
    if (cached !== undefined) return cached;

    try {
      // CXOne-hosted files count against the same API budget as page content; CDN assets don't.
      if (/(^|\.)libretexts\.org$/i.test(new URL(url).hostname)) {
        await CXOneRateLimiter.waitUntilAPIAvailable();
      }

      const response = await axios.get<ArrayBuffer>(url, {
        headers: { 'User-Agent': USER_AGENT },
        responseType: 'arraybuffer',
        timeout: IMAGE_FETCH_TIMEOUT_MS,
      });
      const original = Buffer.from(response.data as unknown as ArrayBuffer);

      const optimized = await optimizeImageBuffer(original, {
        jpegQuality: this._jpegQuality,
        maxHeight: this._maxHeight,
        maxWidth: this._maxWidth,
      });
      if (!optimized) {
        // Vector, animated, or already smaller than anything we'd produce. Leaving the
        // remote URL in place lets Prince fetch it as before.
        this._summary.skipped++;
        this._cache.set(url, null);
        return null;
      }

      const fileName = `${createHash('sha1').update(url).digest('hex')}.${optimized.extension}`;
      const filePath = join(this._outputDir, fileName);
      await fs.writeFile(filePath, optimized.data);

      this._summary.optimized++;
      this._summary.bytesBefore += original.length;
      this._summary.bytesAfter += optimized.data.length;
      this._cache.set(url, filePath);
      return filePath;
    } catch (error) {
      this._summary.failed++;
      this._cache.set(url, null);
      this.logger
        .withMetadata({ error: error instanceof Error ? error.message : String(error), url })
        .warn('Failed to optimize image; falling back to the original source');
      return null;
    }
  }
}
