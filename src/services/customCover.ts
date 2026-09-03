import { LogLayer } from 'loglayer';
import { log as logService } from '../lib/log';
import { Environment } from '../lib/environment';
import PageID from '../util/pageID';
import { getPathFromURL, ORIGIN_HEADER, USER_AGENT } from '../util/util';
import { normalizeSpineImage } from '../util/spineImage';
import { SpineImage } from '../types/pdf';
import {
  CustomCoverConfigEnvelope,
  CustomCoverConfigResponse,
  CustomCoverOrg,
  ResolvedCustomCover,
} from '../types/customCover';

/** Books outside this path prefix can never carry a custom cover. */
const CUSTOM_COVER_PATH_PREFIX = 'Courses/';

const DEFAULT_COMMONS_BASE_URL = 'https://commons.libretexts.org';

/** Commons is a hard dependency of nothing here, so give up on it quickly. */
const CONFIG_FETCH_TIMEOUT_MS = 5_000;
const TEMPLATE_FETCH_TIMEOUT_MS = 20_000;

/**
 * Ceiling on a downloaded template. Templates are a handful of MB of print
 * artwork; anything larger is a misconfiguration, and letting it through would
 * mean holding it in memory and handing it to pdf-lib's parser.
 */
const MAX_TEMPLATE_BYTES = 50 * 1024 * 1024;

/**
 * Ceiling on a downloaded spine image. Far tighter than the template cap: this
 * is a logo drawn at most ~0.75in wide, so anything approaching this size is
 * already a misconfiguration.
 */
const MAX_SPINE_IMAGE_BYTES = 10 * 1024 * 1024;

const DEFAULT_CACHE_TTL_MS = 10 * 60 * 1000;

/**
 * Hosts the processor is willing to download a cover template from.
 *
 * The template URLs arrive in a Commons response and are fetched server-side
 * from inside the VPC, so without this an unexpected value would turn the
 * processor into a request forwarder for anything reachable from there — the
 * EC2 instance metadata endpoint included. Matching on the parsed `hostname`
 * (not the raw string) is what makes it sound: `new URL()` resolves
 * `https://cdn.libretexts.net@evil.example/x` to hostname `evil.example`, and
 * the leading dot stops `notlibretexts.org` from passing as a subdomain.
 */
const ALLOWED_TEMPLATE_HOSTS = ['libretexts.org', 'libretexts.net'];

/** Fallback when an org's stored spine color can't be parsed. */
const FALLBACK_SPINE_HEX = '#000000';

/** Labels the asset being fetched, for log lines and error messages. */
type AssetRole = 'front cover template' | 'back cover template' | 'spine image';

interface CachedTemplate {
  bytes: Uint8Array;
  expiresAt: number;
}

interface CachedSpineImage {
  image: SpineImage;
  expiresAt: number;
}

/**
 * Process-wide template cache. The processor works one job at a time, so this
 * only pays off across consecutive jobs on the same worker — which is the case
 * that matters, a course's books being recompiled as a batch.
 */
const templateCache = new Map<string, CachedTemplate>();

/**
 * Cached alongside the templates, but holding the *normalized* PNG rather than
 * the bytes as downloaded, so a repeat compile skips the sharp pass too.
 */
const spineImageCache = new Map<string, CachedSpineImage>();

/**
 * Drops every entry past its TTL.
 *
 * Deleting only the key being read would leave a multi-megabyte buffer resident
 * for the life of the process as soon as an org stopped being compiled, which
 * on a long-lived worker is a slow leak rather than a bounded cache. Run on
 * write, where the map is already being mutated and the entry count is at most
 * three per org.
 */
function evictExpiredAssets(now: number): void {
  for (const [key, entry] of templateCache) {
    if (entry.expiresAt <= now) templateCache.delete(key);
  }
  for (const [key, entry] of spineImageCache) {
    if (entry.expiresAt <= now) spineImageCache.delete(key);
  }
}

function cacheTtlMs(): number {
  const parsed = Number.parseInt(Environment.getOptional('CUSTOM_COVER_CACHE_TTL_MS', ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_CACHE_TTL_MS;
}

export class CustomCoverService {
  private readonly logger: LogLayer;
  private readonly logName = 'CustomCoverService';
  private readonly baseURL: string;
  /**
   * Local template hosts are accepted only under NODE_ENV=DEVELOPMENT, so a
   * mock CDN can stand in during local testing. This can never widen the
   * allowlist in staging or production.
   */
  private readonly allowsLocalTemplateHosts: boolean;

  constructor() {
    this.logger = logService.child().withContext({ logSource: this.logName });
    this.baseURL = Environment.getOptional('COMMONS_API_BASE_URL', DEFAULT_COMMONS_BASE_URL).replace(/\/+$/, '');
    this.allowsLocalTemplateHosts = Environment.getSystemEnvironment() === 'DEVELOPMENT';
  }

  /**
   * True when a book is even eligible for a custom cover. Only books under
   * `Courses/` are; every other book skips the Commons round trip entirely.
   *
   * Takes the coverpage's canonical `uri.ui` rather than the submitted job URL,
   * so an alias or redirect can't route a course book down the wrong path.
   */
  public static appliesTo(bookURL: string): boolean {
    if (!bookURL) return false;
    try {
      return getPathFromURL(bookURL).replace(/^\/+/, '').startsWith(CUSTOM_COVER_PATH_PREFIX);
    } catch {
      // A book URL we can't parse is a book we can't classify. Treat it as
      // ineligible rather than letting a URL parse failure reach the pipeline.
      return false;
    }
  }

  /**
   * The pipeline's single entry point: resolve a book to a ready-to-use custom
   * cover, or to null.
   *
   * Never throws and never rejects. Most books legitimately have no
   * configuration, and a book that does must still compile if Commons or the
   * CDN is having a bad day — the caller falls back to standard covers.
   */
  public async resolve(bookID: PageID): Promise<ResolvedCustomCover | null> {
    const found = await this.fetchConfig(bookID);
    if (!found) return null;

    const { org, config } = found;

    let frontTemplateBytes: Uint8Array;
    let backTemplateBytes: Uint8Array;
    try {
      [frontTemplateBytes, backTemplateBytes] = await Promise.all([
        this.fetchTemplate(config.frontTemplateURL, 'front'),
        this.fetchTemplate(config.backTemplateURL, 'back'),
      ]);
    } catch (error) {
      this.logger
        .withMetadata({
          bookID: bookID.toString(),
          org: org.name,
          frontTemplateURL: config.frontTemplateURL,
          backTemplateURL: config.backTemplateURL,
          error: error instanceof Error ? error.message : String(error),
        })
        .error('Failed to download custom cover templates; falling back to standard covers');
      return null;
    }

    const spineHex = this.normalizeSpineHex(config.spineHexColor, bookID, org);
    const spineImage = await this.resolveSpineImage(config.spineImageURL, bookID, org);

    this.logger
      .withMetadata({
        bookID: bookID.toString(),
        org: org.name,
        orgID: org.orgID,
        spineHex,
        frontBytes: frontTemplateBytes.byteLength,
        backBytes: backTemplateBytes.byteLength,
        spineImage: spineImage
          ? { bytes: spineImage.bytes.byteLength, px: `${spineImage.widthPx}x${spineImage.heightPx}` }
          : null,
      })
      .info('Resolved custom cover configuration');

    return { org, frontTemplateBytes, backTemplateBytes, spineHex, spineImage };
  }

  /**
   * Resolves the optional spine artwork.
   *
   * Optional in the strongest sense: no URL means no network call, no decode,
   * and no cache entry. A URL that fails degrades to the same null — the spine
   * falls back to its flat color fill and the custom cover still ships. That is
   * deliberately weaker than the template path above, where a failure costs the
   * book its custom cover entirely.
   */
  private async resolveSpineImage(
    spineImageURL: string | undefined,
    bookID: PageID,
    org: CustomCoverOrg,
  ): Promise<SpineImage | null> {
    if (!spineImageURL?.trim()) return null;
    try {
      return await this.fetchSpineImage(spineImageURL.trim());
    } catch (error) {
      this.logger
        .withMetadata({
          bookID: bookID.toString(),
          org: org.name,
          spineImageURL,
          error: error instanceof Error ? error.message : String(error),
        })
        .warn('Could not load the custom cover spine image; using a flat spine');
      return null;
    }
  }

  /**
   * Asks Commons whether this book has an applicable custom cover.
   *
   * A 404 is the expected answer for most books: it covers "no such book", "no
   * applicable config", and "Commons couldn't decide". All of those mean the
   * same thing here, so they share one loud debug line and a null return.
   */
  private async fetchConfig(
    bookID: PageID,
  ): Promise<{ org: CustomCoverOrg; config: CustomCoverConfigResponse } | null> {
    const url = `${this.baseURL}/shapeshift/book/${bookID.toString()}/custom-cover-config`;
    try {
      const res = await fetch(url, {
        headers: { origin: ORIGIN_HEADER, 'User-Agent': USER_AGENT },
        signal: AbortSignal.timeout(CONFIG_FETCH_TIMEOUT_MS),
      });

      if (!res.ok) {
        this.logger
          .withMetadata({ bookID: bookID.toString(), url, status: res.status })
          .debug('No custom cover configuration for this book; using standard covers');
        return null;
      }

      const body = (await res.json()) as CustomCoverConfigEnvelope;
      const config = body?.customCoverConfig;
      const org = body?.org;

      if (body?.err || !config || !org?.name) {
        this.logger
          .withMetadata({ bookID: bookID.toString(), url, err: body?.err, msg: body?.msg })
          .debug('Commons returned no usable custom cover configuration; using standard covers');
        return null;
      }

      if (config.enabled !== true) {
        this.logger
          .withMetadata({ bookID: bookID.toString(), url, org: org.name })
          .debug('Custom cover configuration is disabled for this book; using standard covers');
        return null;
      }

      if (!config.frontTemplateURL || !config.backTemplateURL) {
        this.logger
          .withMetadata({
            bookID: bookID.toString(),
            url,
            org: org.name,
            frontTemplateURL: config.frontTemplateURL,
            backTemplateURL: config.backTemplateURL,
          })
          .debug('Custom cover configuration is missing a template URL; using standard covers');
        return null;
      }

      return { org, config };
    } catch (error) {
      // A network error or timeout here is indistinguishable from "no config"
      // as far as the compile is concerned, so it degrades the same way.
      this.logger
        .withMetadata({
          bookID: bookID.toString(),
          url,
          error: error instanceof Error ? error.message : String(error),
        })
        .debug('Could not reach the custom cover configuration endpoint; using standard covers');
      return null;
    }
  }

  /**
   * Accepts a spine color with or without a leading `#`, in 3- or 6-digit form,
   * and returns the canonical `#rrggbb`.
   *
   * `hexToRgb01` already tolerates both forms, so this exists to stop a value
   * that is malformed rather than merely differently-formatted from throwing in
   * the middle of cover assembly and taking the whole custom cover down with it.
   */
  private normalizeSpineHex(raw: string | undefined, bookID: PageID, org: CustomCoverOrg): string {
    const cleaned = (raw ?? '').trim().replace(/^#/, '');
    if (/^[0-9a-fA-F]{3}$/.test(cleaned)) {
      const [r, g, b] = cleaned;
      return `#${r}${r}${g}${g}${b}${b}`.toLowerCase();
    }
    if (/^[0-9a-fA-F]{6}$/.test(cleaned)) {
      return `#${cleaned.toLowerCase()}`;
    }
    this.logger
      .withMetadata({ bookID: bookID.toString(), org: org.name, spineHexColor: raw, fallback: FALLBACK_SPINE_HEX })
      .warn('Custom cover spine color is not a valid hex value; falling back');
    return FALLBACK_SPINE_HEX;
  }

  /**
   * Rejects any asset URL the processor should not dereference — the two
   * template PDFs and the spine image all come through here.
   *
   * Throws rather than returning a flag: every caller already treats a fetch
   * failure as a fallback ("standard covers" for a template, "flat spine" for
   * the image), so a refused URL degrades along exactly the same path as a 404
   * or a corrupt file.
   */
  private assertFetchableAssetURL(raw: string, role: AssetRole): void {
    let parsed: URL;
    try {
      parsed = new URL(raw);
    } catch {
      throw new Error(`The ${role} URL is not a valid URL (${raw})`);
    }

    if (this.allowsLocalTemplateHosts && (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1')) {
      return;
    }

    if (parsed.protocol !== 'https:') {
      throw new Error(`The ${role} URL must be https, got ${parsed.protocol} (${raw})`);
    }

    const host = parsed.hostname.toLowerCase();
    const allowed = ALLOWED_TEMPLATE_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
    if (!allowed) {
      throw new Error(`The ${role} host "${parsed.hostname}" is not an allowed LibreTexts host`);
    }
  }

  /** Downloads a template PDF, serving from and populating the shared cache. */
  private async fetchTemplate(url: string, role: 'front' | 'back'): Promise<Uint8Array> {
    this.assertFetchableAssetURL(url, `${role} cover template`);

    const now = Date.now();
    const cached = templateCache.get(url);
    if (cached) {
      if (cached.expiresAt > now) {
        this.logger.withMetadata({ url, role }).debug('Custom cover template served from cache');
        return cached.bytes;
      }
      templateCache.delete(url);
    }

    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(TEMPLATE_FETCH_TIMEOUT_MS),
    });
    if (!res.ok) {
      throw new Error(`Template fetch for the ${role} cover returned ${res.status} (${url})`);
    }

    const declaredLength = Number.parseInt(res.headers.get('content-length') ?? '', 10);
    if (Number.isFinite(declaredLength) && declaredLength > MAX_TEMPLATE_BYTES) {
      throw new Error(`The ${role} cover template is ${declaredLength} bytes, over the ${MAX_TEMPLATE_BYTES} cap`);
    }

    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.byteLength > MAX_TEMPLATE_BYTES) {
      throw new Error(`The ${role} cover template is ${bytes.byteLength} bytes, over the ${MAX_TEMPLATE_BYTES} cap`);
    }
    // A CDN that answers 200 with an HTML error page would otherwise reach
    // pdf-lib's parser as a much less legible failure.
    if (Buffer.from(bytes.subarray(0, 5)).toString('utf8') !== '%PDF-') {
      throw new Error(`The ${role} cover template at ${url} is not a PDF`);
    }

    evictExpiredAssets(now);
    templateCache.set(url, { bytes, expiresAt: now + cacheTtlMs() });
    this.logger.withMetadata({ url, role, bytes: bytes.byteLength }).debug('Fetched custom cover template');
    return bytes;
  }

  /**
   * Downloads and normalizes the spine artwork, serving from and populating the
   * shared cache.
   *
   * Caches the normalized PNG rather than the downloaded bytes, so a second book
   * from the same org skips both the transfer and the sharp re-encode.
   */
  private async fetchSpineImage(url: string): Promise<SpineImage> {
    this.assertFetchableAssetURL(url, 'spine image');

    const now = Date.now();
    const cached = spineImageCache.get(url);
    if (cached) {
      if (cached.expiresAt > now) {
        this.logger.withMetadata({ url }).debug('Custom cover spine image served from cache');
        return cached.image;
      }
      spineImageCache.delete(url);
    }

    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(TEMPLATE_FETCH_TIMEOUT_MS),
    });
    if (!res.ok) {
      throw new Error(`Spine image fetch returned ${res.status} (${url})`);
    }

    const declaredLength = Number.parseInt(res.headers.get('content-length') ?? '', 10);
    if (Number.isFinite(declaredLength) && declaredLength > MAX_SPINE_IMAGE_BYTES) {
      throw new Error(`The spine image is ${declaredLength} bytes, over the ${MAX_SPINE_IMAGE_BYTES} cap`);
    }

    const downloaded = new Uint8Array(await res.arrayBuffer());
    if (downloaded.byteLength > MAX_SPINE_IMAGE_BYTES) {
      throw new Error(`The spine image is ${downloaded.byteLength} bytes, over the ${MAX_SPINE_IMAGE_BYTES} cap`);
    }

    // No magic-byte check here the way `fetchTemplate` has one: sharp accepts
    // far more formats than we would want to enumerate, and it is the thing that
    // rejects a CDN error page — as a decode failure the caller already handles.
    const image = await normalizeSpineImage(downloaded);

    evictExpiredAssets(now);
    spineImageCache.set(url, { image, expiresAt: now + cacheTtlMs() });
    this.logger
      .withMetadata({
        url,
        downloadedBytes: downloaded.byteLength,
        normalizedBytes: image.bytes.byteLength,
        px: `${image.widthPx}x${image.heightPx}`,
      })
      .debug('Fetched and normalized the custom cover spine image');
    return image;
  }
}
