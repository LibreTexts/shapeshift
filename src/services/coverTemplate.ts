import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PDFDocument,
  PDFName,
  PDFDict,
  PDFRef,
  PDFArray,
  PDFRawStream,
  PDFString,
  PDFObject,
  PDFObjectCopier,
  PDFOperator,
  PDFOperatorNames,
  PDFHexString,
  PDFNumber,
  PDFEmbeddedPage,
  PDFPage,
  clip,
  endPath,
  fill,
  rectangle,
  pushGraphicsState,
  popGraphicsState,
  degrees,
  rgb,
  PDFFont,
} from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';

import { log } from '../lib/log';
import {
  buildToUnicodeReverseMap,
  buildWidthLookup,
  collectFormFontResources,
  collectPageFontResources,
  encodeAndMeasure,
  fillCoverTemplate,
  getBaseFont,
  hexToRgb01,
  resolveFontRef,
  ReverseMap,
  WidthLookup,
} from '../util/coverTemplateFiller';
import { buildCoverValues, getCoverDimensions } from '../util/pdfHelpers';
import { BookPageInfo } from '../types/book';
import { CoverFitMode, FieldOverride, PDFCoverType } from '../types/pdf';

const __dirname = dirname(fileURLToPath(import.meta.url));

const PT_PER_IN = 72;

/** Below this spine width (inches), skip rendering TITLE/AUTHOR on the spine. */
const MIN_SPINE_WIDTH_FOR_TEXT_IN = 0.5;

/** Default font size (pt) for spine text. */
const DEFAULT_SPINE_FONT_SIZE = 10;

/** Inset from top/bottom of the spine (pt) when laying out spine text. */
const SPINE_TEXT_PADDING_PT = 18;

type WrapCoverType = Extract<PDFCoverType, 'CaseWrap' | 'PerfectBound'>;

export interface SpineTextOptions {
  /** Force-disable spine text even on wide spines. */
  enabled?: boolean;
  /** Font BaseFont/shortName to look up in the front or back template, used for both lines unless overridden. */
  spineFontName?: string;
  /** Override font for the spine title. Falls back to spineFontName, then Atkinson. */
  titleFontName?: string;
  /** Override font for the spine author. Falls back to spineFontName, then Atkinson. */
  authorFontName?: string;
  /** Escape hatch: explicit TTF path for the title (only used when no template-font name is set). */
  titleTtfPath?: string;
  /** Escape hatch: explicit TTF path for the author (only used when no template-font name is set). */
  authorTtfPath?: string;
  /** Font size in points applied to both lines unless overridden by titleSize/authorSize. */
  size?: number;
  /** Font size in points for the title. Falls back to `size`, then DEFAULT_SPINE_FONT_SIZE. */
  titleSize?: number;
  /** Font size in points for the author. Falls back to `size`, then DEFAULT_SPINE_FONT_SIZE. */
  authorSize?: number;
  /** Hex color for the text. Defaults to white. */
  color?: string;
}

export interface BuildFinalCoverInput {
  frontTemplateBytes: Uint8Array | ArrayBuffer;
  backTemplateBytes: Uint8Array | ArrayBuffer;
  bookInfo: BookPageInfo;
  /** Interior page count. Drives spine width. */
  numPages: number;
  coverType: WrapCoverType;
  /** Spine fill color, e.g. "#1a3d8f". */
  spineHex: string;
  extraValues?: Record<string, unknown>;
  overrides?: Record<string, FieldOverride>;
  spineText?: SpineTextOptions;
  /**
   * How to place each panel's template art within its panel region when the
   * template aspect ratio doesn't match the panel. Defaults to `fill-crop`.
   * The art is always scaled uniformly (never stretched).
   */
  coverFit?: CoverFitMode;
}

interface FontInTemplate {
  sourceDoc: PDFDocument;
  sourceLabel: 'front' | 'back';
  fontRef: PDFRef;
  baseFont: string;
  shortName: string;
}

interface ResolvedTemplateFont {
  destFontRef: PDFRef;
  reverseMap: ReverseMap;
  widthLookup: WidthLookup;
  baseFont: string;
}

export class CoverTemplateService {
  private readonly debug: boolean;

  constructor({ debug = false }: { debug?: boolean } = {}) {
    this.debug = debug;
  }

  async fill(
    templateBytes: Uint8Array | ArrayBuffer,
    values: Record<string, unknown>,
    overrides?: Record<string, FieldOverride>,
  ): Promise<Uint8Array> {
    return fillCoverTemplate({
      templateBytes,
      values,
      overrides,
      debug: this.debug ? (...args) => log.withMetadata({ args }).debug('[fill-form]') : false,
    });
  }

  async fillFromBookInfo(
    templateBytes: Uint8Array | ArrayBuffer,
    bookInfo: BookPageInfo,
    {
      extraValues,
      overrides,
    }: { extraValues?: Record<string, unknown>; overrides?: Record<string, FieldOverride> } = {},
  ): Promise<Uint8Array> {
    const values = { ...buildCoverValues(bookInfo), ...(extraValues ?? {}) };
    return this.fill(templateBytes, values, overrides);
  }

  async buildFinalCover(input: BuildFinalCoverInput): Promise<Uint8Array> {
    const {
      frontTemplateBytes,
      backTemplateBytes,
      bookInfo,
      numPages,
      coverType,
      spineHex,
      extraValues,
      overrides,
      spineText,
      coverFit = 'fill-crop',
    } = input;

    const [filledFront, filledBack] = await Promise.all([
      this.fillFromBookInfo(frontTemplateBytes, bookInfo, { extraValues, overrides }),
      this.tryFillOrPassthrough(backTemplateBytes, bookInfo, { extraValues, overrides }),
    ]);

    const { spineWidth, totalWidth, height } = getCoverDimensions(coverType, numPages);

    const pageWidthPt = totalWidth * PT_PER_IN;
    const pageHeightPt = height * PT_PER_IN;
    const spineWidthPt = spineWidth * PT_PER_IN;
    const panelWidthPt = ((totalWidth - spineWidth) / 2) * PT_PER_IN;

    const destDoc = await PDFDocument.create();
    destDoc.registerFontkit(fontkit);
    const page = destDoc.addPage([pageWidthPt, pageHeightPt]);

    const [backEmbed] = await destDoc.embedPdf(filledBack, [0]);
    const [frontEmbed] = await destDoc.embedPdf(filledFront, [0]);

    // Place each panel's art scaled UNIFORMLY into its panel region (never
    // stretched), centered, and clipped to the region so overflow can't bleed
    // into the spine or the opposite panel. See `drawPanelClipped`.
    drawPanelClipped(page, backEmbed, 0, 0, panelWidthPt, pageHeightPt, coverFit);

    // Color-space seam fix: the panel art carries an embedded ICC (RGB) profile,
    // but a plain DeviceRGB spine fill is rendered through the viewer's default
    // RGB, which hue-shifts against the ICC-managed panels at the seam. If the
    // front template exposes an ICC profile, reuse it so the spine fill is in
    // the SAME color space as the panels, and register it as a document
    // OutputIntent so the whole cover renders under one color pipeline.
    const spineCs = setupIccColorSpace(destDoc, page, this.debug);

    const { r: sr, g: sg, b: sb } = hexToRgb01(spineHex);
    if (spineCs) {
      page.pushOperators(
        pushGraphicsState(),
        PDFOperator.of(PDFOperatorNames.NonStrokingColorspace, [PDFName.of(spineCs)]),
        PDFOperator.of(PDFOperatorNames.NonStrokingColorN, [PDFNumber.of(sr), PDFNumber.of(sg), PDFNumber.of(sb)]),
        rectangle(panelWidthPt, 0, spineWidthPt, pageHeightPt),
        fill(),
        popGraphicsState(),
      );
    } else {
      page.drawRectangle({
        x: panelWidthPt,
        y: 0,
        width: spineWidthPt,
        height: pageHeightPt,
        color: rgb(sr, sg, sb),
        borderWidth: 0,
      });
    }

    if (spineWidth >= MIN_SPINE_WIDTH_FOR_TEXT_IN && spineText?.enabled !== false) {
      await this.drawSpineText({
        destDoc,
        page,
        spineLeftPt: panelWidthPt,
        spineWidthPt,
        pageHeightPt,
        bookInfo,
        frontTemplateBytes: filledFront,
        backTemplateBytes: filledBack,
        options: spineText ?? {},
      });
    } else if (this.debug) {
      log.debug(
        `[buildFinalCover] skipping spine text (spineWidth=${spineWidth.toFixed(3)}in, enabled=${spineText?.enabled})`,
      );
    }

    drawPanelClipped(page, frontEmbed, panelWidthPt + spineWidthPt, 0, panelWidthPt, pageHeightPt, coverFit);

    return destDoc.save();
  }

  async buildFinalCoversBothBindings(
    input: Omit<BuildFinalCoverInput, 'coverType'>,
  ): Promise<{ casewrap: Uint8Array; perfectBound: Uint8Array }> {
    const [casewrap, perfectBound] = await Promise.all([
      this.buildFinalCover({ ...input, coverType: 'CaseWrap' }),
      this.buildFinalCover({ ...input, coverType: 'PerfectBound' }),
    ]);
    return { casewrap, perfectBound };
  }

  private async tryFillOrPassthrough(
    templateBytes: Uint8Array | ArrayBuffer,
    bookInfo: BookPageInfo,
    opts: { extraValues?: Record<string, unknown>; overrides?: Record<string, FieldOverride> },
  ): Promise<Uint8Array> {
    try {
      return await this.fillFromBookInfo(templateBytes, bookInfo, opts);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/missing required field/i.test(msg)) {
        if (this.debug) log.debug(`[buildFinalCover] back template has no fillable fields; using as-is`);
        return templateBytes instanceof Uint8Array ? templateBytes : new Uint8Array(templateBytes);
      }
      throw err;
    }
  }

  private async drawSpineText({
    destDoc,
    page,
    spineLeftPt,
    spineWidthPt,
    pageHeightPt,
    bookInfo,
    frontTemplateBytes,
    backTemplateBytes,
    options,
  }: {
    destDoc: PDFDocument;
    page: ReturnType<PDFDocument['addPage']>;
    spineLeftPt: number;
    spineWidthPt: number;
    pageHeightPt: number;
    bookInfo: BookPageInfo;
    frontTemplateBytes: Uint8Array;
    backTemplateBytes: Uint8Array;
    options: SpineTextOptions;
  }): Promise<void> {
    const title = (bookInfo.printInfo?.title || bookInfo.title || '').trim();
    const author = (bookInfo.printInfo?.authorName || '').trim();
    if (!title && !author) return;

    const titleSize = options.titleSize ?? options.size ?? DEFAULT_SPINE_FONT_SIZE;
    const authorSize = options.authorSize ?? options.size ?? DEFAULT_SPINE_FONT_SIZE;
    const { r, g, b } = options.color ? hexToRgb01(options.color) : { r: 1, g: 1, b: 1 };
    const usableHeight = pageHeightPt - 2 * SPINE_TEXT_PADDING_PT;
    const spineCenterX = spineLeftPt + spineWidthPt / 2;

    const titleFontName = options.titleFontName ?? options.spineFontName;
    const authorFontName = options.authorFontName ?? options.spineFontName;
    const anyTemplateFontRequested = !!(titleFontName || authorFontName);

    // Lazy-load source docs only if a template font is requested.
    let sourceFront: PDFDocument | null = null;
    let sourceBack: PDFDocument | null = null;
    if (anyTemplateFontRequested) {
      [sourceFront, sourceBack] = await Promise.all([
        PDFDocument.load(frontTemplateBytes),
        PDFDocument.load(backTemplateBytes),
      ]);
    }

    const resolveTemplateFont = async (
      requestedName: string,
      role: 'title' | 'author',
    ): Promise<ResolvedTemplateFont> => {
      const sources: { label: 'front' | 'back'; doc: PDFDocument }[] = [
        { label: 'front', doc: sourceFront! },
        { label: 'back', doc: sourceBack! },
      ];
      const hit = findEmbeddedFontAcrossDocs(requestedName, sources);
      if (!hit) {
        const catalog = listTemplateFontsForError(sources);
        throw new Error(
          `Spine ${role} font "${requestedName}" is not referenced by either template.\n` +
            `Template fonts (match by either shortName or baseFont; only entries marked [embedded] are usable):\n` +
            `${catalog || '  (none)'}`,
        );
      }
      if (!fontHasEmbeddedProgram(hit.sourceDoc, hit.fontRef)) {
        // The source template references the font by name but does not embed
        // the font program. Copying it forward would produce an unembedded
        // font reference in the output and trip Lulu's preflight.
        throw new Error(
          `Spine ${role} font "${requestedName}" (baseFont "${hit.baseFont}") is referenced by the ${hit.sourceLabel} ` +
            `template but its font program is not embedded. Either embed the font in the source template or pick a ` +
            `spine font whose program is embedded.`,
        );
      }
      const destFontRef = copyFontIntoDest(destDoc, hit.sourceDoc, hit.fontRef);
      const reverseMap = buildToUnicodeReverseMap(hit.sourceDoc, hit.fontRef);
      const widthLookup = buildWidthLookup(hit.sourceDoc, hit.fontRef);
      return { destFontRef, reverseMap, widthLookup, baseFont: hit.baseFont };
    };

    const drawAtkinson = async (
      text: string,
      yTop: boolean,
      ttfPath: string | undefined,
      variant: 'bold' | 'regular',
      size: number,
    ) => {
      const font = await this.loadSpineFont(destDoc, ttfPath, variant);
      const truncated = truncateToWidthPdfFont(text, font, size, usableHeight);
      const baselineX = spineCenterX - size / 3;
      if (yTop) {
        page.drawText(truncated, {
          x: baselineX,
          y: pageHeightPt - SPINE_TEXT_PADDING_PT,
          size,
          font,
          color: rgb(r, g, b),
          rotate: degrees(-90),
        });
      } else {
        const wPt = font.widthOfTextAtSize(truncated, size);
        page.drawText(truncated, {
          x: baselineX,
          y: SPINE_TEXT_PADDING_PT + wPt,
          size,
          font,
          color: rgb(r, g, b),
          rotate: degrees(-90),
        });
      }
    };

    if (title) {
      if (titleFontName) {
        const resolved = await resolveTemplateFont(titleFontName, 'title');
        const shortName = ensureFontOnPage(destDoc, page, resolved.destFontRef, '__SpineT');
        drawRotatedTemplateText({
          page,
          text: title,
          resolved,
          shortName,
          size: titleSize,
          rgbColor: { r, g, b },
          spineCenterX,
          anchorY: pageHeightPt - SPINE_TEXT_PADDING_PT,
          anchorAt: 'start',
          usableHeight,
          role: 'title',
        });
      } else {
        await drawAtkinson(title, true, options.titleTtfPath, 'bold', titleSize);
      }
    }
    if (author) {
      if (authorFontName) {
        const resolved = await resolveTemplateFont(authorFontName, 'author');
        const shortName = ensureFontOnPage(destDoc, page, resolved.destFontRef, '__SpineA');
        drawRotatedTemplateText({
          page,
          text: author,
          resolved,
          shortName,
          size: authorSize,
          rgbColor: { r, g, b },
          spineCenterX,
          anchorY: SPINE_TEXT_PADDING_PT,
          anchorAt: 'end',
          usableHeight,
          role: 'author',
        });
      } else {
        await drawAtkinson(author, false, options.authorTtfPath, 'regular', authorSize);
      }
    }
  }

  private async loadSpineFont(
    destDoc: PDFDocument,
    ttfPath: string | undefined,
    variant: 'bold' | 'regular',
  ): Promise<PDFFont> {
    const defaultPath = join(
      __dirname,
      '../styles/fonts',
      variant === 'bold' ? 'atkinson-hyperlegible-700.ttf' : 'atkinson-hyperlegible-400.ttf',
    );
    const path = ttfPath ?? defaultPath;
    // Intentionally do not fall back to a StandardFonts (base-14) font: those
    // are not embedded by the PDF spec, which would silently produce a cover
    // that fails Lulu's "all fonts embedded" preflight. Fail loudly instead.
    const bytes = await readFile(path);
    return destDoc.embedFont(bytes, { subset: true });
  }
}

/**
 * Returns true iff the font dict at `fontRef` carries an embedded font program
 * (FontFile / FontFile2 / FontFile3) in its FontDescriptor. For Type 0
 * composite fonts the descriptor lives on the descendant CIDFont.
 */
function fontHasEmbeddedProgram(doc: PDFDocument, fontRef: PDFRef): boolean {
  const fontObj = doc.context.lookup(fontRef);
  if (!(fontObj instanceof PDFDict)) return false;
  const descriptor = resolveFontDescriptor(doc, fontObj);
  if (!descriptor) return false;
  for (const key of ['FontFile', 'FontFile2', 'FontFile3']) {
    if (descriptor.get(PDFName.of(key))) return true;
  }
  return false;
}

function resolveFontDescriptor(doc: PDFDocument, fontObj: PDFDict): PDFDict | null {
  const direct = fontObj.lookup(PDFName.of('FontDescriptor'));
  if (direct instanceof PDFDict) return direct;
  const descendants = fontObj.lookup(PDFName.of('DescendantFonts'));
  if (descendants && 'get' in descendants && typeof (descendants as { get: unknown }).get === 'function') {
    const first = (descendants as { get: (i: number) => unknown }).get(0);
    const cid = first instanceof PDFRef ? doc.context.lookup(first) : first;
    if (cid instanceof PDFDict) {
      const d = cid.lookup(PDFName.of('FontDescriptor'));
      if (d instanceof PDFDict) return d;
    }
  }
  return null;
}

// ---------- panel placement (module-private) ----------

/**
 * Draw an embedded template page into a panel region, scaled UNIFORMLY (so the
 * art keeps its aspect ratio — no more non-uniform width/height stretching),
 * centered in the region, and clipped to the region's rectangle so any overflow
 * from a `fill-crop` aspect mismatch can't spill into the spine or the opposite
 * panel.
 */
function drawPanelClipped(
  page: PDFPage,
  embed: PDFEmbeddedPage,
  panelX: number,
  panelY: number,
  panelW: number,
  panelH: number,
  mode: CoverFitMode,
): void {
  const scale =
    mode === 'fit'
      ? Math.min(panelW / embed.width, panelH / embed.height)
      : Math.max(panelW / embed.width, panelH / embed.height);
  const drawW = embed.width * scale;
  const drawH = embed.height * scale;
  const x = panelX + (panelW - drawW) / 2;
  const y = panelY + (panelH - drawH) / 2;

  // `q  <panelX panelY panelW panelH re>  W  n` clips subsequent drawing to the
  // panel rectangle; the matching `Q` is pushed after the page is drawn.
  page.pushOperators(pushGraphicsState(), rectangle(panelX, panelY, panelW, panelH), clip(), endPath());
  page.drawPage(embed, { x, y, width: drawW, height: drawH });
  page.pushOperators(popGraphicsState());
}

// ---------- color-space seam fix (module-private) ----------

/**
 * Reuse an RGB ICC profile already embedded in the assembled document (it came
 * along with a panel's artwork via `embedPdf`) so the injected spine fill can be
 * painted in the SAME color space as the panels instead of raw DeviceRGB — which
 * is what causes the visible hue mismatch at the spine/panel seam. Also registers
 * the profile as a document OutputIntent so conforming readers/RIPs color-manage
 * every DeviceRGB element (e.g. white spine text) through one consistent pipeline.
 *
 * Returns the page-resource name to use with the `cs`/`scn` operators, or null
 * when no 3-component ICC profile is present (e.g. DeviceRGB templates — in which
 * case a plain DeviceRGB spine fill matches the panels anyway, so there is no seam).
 */
function setupIccColorSpace(destDoc: PDFDocument, page: PDFPage, debug: boolean): string | null {
  const iccRef = findIccBasedProfileRef(destDoc, 3);
  if (!iccRef) {
    if (debug) log.debug('[buildFinalCover] no embedded RGB ICC profile found; spine uses DeviceRGB');
    return null;
  }
  const csArray = destDoc.context.obj([PDFName.of('ICCBased'), iccRef]);
  const csName = ensureColorSpaceOnPage(destDoc, page, csArray, 'CsSpine');
  addOutputIntent(destDoc, iccRef);
  if (debug) log.debug(`[buildFinalCover] spine fill tagged ICCBased via /${csName}; OutputIntent added`);
  return csName;
}

/**
 * Scan every indirect object for an `[/ICCBased <stream>]` color space whose
 * profile declares `N === components`, returning an indirect ref to that profile
 * stream (registering one if the array held the stream inline).
 */
function findIccBasedProfileRef(doc: PDFDocument, components: number): PDFRef | null {
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFArray) || obj.size() !== 2) continue;
    const head = obj.get(0);
    if (!(head instanceof PDFName) || head.toString() !== '/ICCBased') continue;
    const second = obj.get(1);
    const stream = second instanceof PDFRef ? doc.context.lookup(second) : second;
    if (!(stream instanceof PDFRawStream)) continue;
    const n = stream.dict.lookup(PDFName.of('N'));
    if (!(n instanceof PDFNumber) || n.asNumber() !== components) continue;
    return second instanceof PDFRef ? second : doc.context.register(stream);
  }
  return null;
}

/**
 * Register a color space value under `/Resources /ColorSpace` on `page`,
 * returning the (uniquified) resource name. Mirrors `ensureFontOnPage`.
 */
function ensureColorSpaceOnPage(destDoc: PDFDocument, page: PDFPage, csValue: PDFObject, desiredName: string): string {
  const existingResources = page.node.Resources();
  let resources: PDFDict;
  if (existingResources instanceof PDFDict) {
    resources = existingResources;
  } else {
    resources = destDoc.context.obj({}) as PDFDict;
    page.node.set(PDFName.of('Resources'), resources);
  }
  const existing = resources.lookup(PDFName.of('ColorSpace'));
  let csDict: PDFDict;
  if (existing instanceof PDFDict) {
    csDict = existing;
  } else {
    csDict = destDoc.context.obj({}) as PDFDict;
    resources.set(PDFName.of('ColorSpace'), csDict);
  }
  let name = desiredName;
  let counter = 1;
  while (csDict.lookup(PDFName.of(name))) name = `${desiredName}${++counter}`;
  csDict.set(PDFName.of(name), csValue);
  return name;
}

/**
 * Attach a single OutputIntent referencing the embedded ICC profile. No-op if
 * the document already carries one. The `/S /GTS_PDFX` subtype is the standard
 * print marker; note this does not by itself make the file fully PDF/X-conformant
 * (that needs TrimBox/BleedBox, no transparency, etc.) — it only declares the
 * destination color space so DeviceRGB content is rendered consistently.
 */
function addOutputIntent(destDoc: PDFDocument, iccRef: PDFRef): void {
  const existing = destDoc.catalog.lookup(PDFName.of('OutputIntents'));
  if (existing instanceof PDFArray && existing.size() > 0) return;
  const intent = destDoc.context.obj({
    Type: 'OutputIntent',
    S: 'GTS_PDFX',
    OutputConditionIdentifier: PDFString.of('Custom'),
    Info: PDFString.of('Embedded template RGB profile'),
    DestOutputProfile: iccRef,
  });
  destDoc.catalog.set(PDFName.of('OutputIntents'), destDoc.context.obj([intent]));
}

// ---------- spine font helpers (module-private) ----------

function stripSubsetPrefix(name: string): string {
  return name.replace(/^[A-Z]{6}\+/, '');
}

/**
 * Search both source documents (AcroForm /DR /Font + page /Font dicts) for a
 * font matching `requestedName` by short-name OR /BaseFont (subset-prefix
 * stripped, case-insensitive). Returns the first hit across both docs.
 */
function findEmbeddedFontAcrossDocs(
  requestedName: string,
  sources: { label: 'front' | 'back'; doc: PDFDocument }[],
): FontInTemplate | null {
  const target = stripSubsetPrefix(requestedName).toLowerCase();
  for (const { label, doc } of sources) {
    const candidates: Map<
      string,
      ReturnType<typeof collectFormFontResources> extends Map<string, infer V> ? V : never
    >[] = [collectFormFontResources(doc), collectPageFontResources(doc)];
    for (const source of candidates) {
      // 1) short-name match
      const direct = source.get(requestedName);
      if (direct) {
        const ref = resolveFontRef(direct, doc);
        if (ref)
          return {
            sourceDoc: doc,
            sourceLabel: label,
            fontRef: ref,
            baseFont: getBaseFont(doc, ref),
            shortName: requestedName,
          };
      }
      // 2) BaseFont match across all entries
      for (const [shortName, val] of source.entries()) {
        const ref = resolveFontRef(val, doc);
        if (!ref) continue;
        const baseFont = getBaseFont(doc, ref);
        if (stripSubsetPrefix(baseFont).toLowerCase() === target) {
          return { sourceDoc: doc, sourceLabel: label, fontRef: ref, baseFont, shortName };
        }
      }
    }
  }
  return null;
}

function listTemplateFontsForError(sources: { label: 'front' | 'back'; doc: PDFDocument }[]): string {
  const lines: string[] = [];
  const seen = new Set<string>();
  for (const { label, doc } of sources) {
    for (const m of [collectFormFontResources(doc), collectPageFontResources(doc)]) {
      for (const [shortName, val] of m.entries()) {
        const ref = resolveFontRef(val, doc);
        if (!ref) continue;
        const baseFont = getBaseFont(doc, ref);
        const k = `${label}|${shortName}|${baseFont}`;
        if (seen.has(k)) continue;
        seen.add(k);
        const status = fontHasEmbeddedProgram(doc, ref) ? '[embedded]' : '[NOT embedded]';
        lines.push(`  - ${status} [${label}] shortName="${shortName}", baseFont="${baseFont}"`);
      }
    }
  }
  return lines.join('\n');
}

/**
 * Deep-copy the font dict (and its entire object graph) from the source PDF
 * into the destination PDF, returning the new ref inside destDoc.context.
 * Uses pdf-lib's PDFObjectCopier — the same machinery embedPdf uses to
 * deep-copy pages — so font descriptors, font file streams, and ToUnicode
 * CMaps all come along automatically.
 */
function copyFontIntoDest(destDoc: PDFDocument, sourceDoc: PDFDocument, sourceFontRef: PDFRef): PDFRef {
  const copier = PDFObjectCopier.for(sourceDoc.context, destDoc.context);
  const sourceFontDict = sourceDoc.context.lookup(sourceFontRef);
  if (!(sourceFontDict instanceof PDFDict)) {
    throw new Error(`copyFontIntoDest: source ref ${sourceFontRef.toString()} did not resolve to a PDFDict.`);
  }
  const copied = copier.copy(sourceFontDict);
  return destDoc.context.register(copied);
}

function ensureFontOnPage(
  destDoc: PDFDocument,
  page: ReturnType<PDFDocument['addPage']>,
  fontRef: PDFRef,
  desiredShortName: string,
): string {
  const existingResources = page.node.Resources();
  let resources: PDFDict;
  if (existingResources instanceof PDFDict) {
    resources = existingResources;
  } else {
    resources = destDoc.context.obj({}) as PDFDict;
    page.node.set(PDFName.of('Resources'), resources);
  }
  const existingFonts = resources.lookup(PDFName.of('Font'));
  let fonts: PDFDict;
  if (existingFonts instanceof PDFDict) {
    fonts = existingFonts;
  } else {
    fonts = destDoc.context.obj({}) as PDFDict;
    resources.set(PDFName.of('Font'), fonts);
  }
  // If the desired short name already exists and points at a different ref,
  // pick a unique name. (Unlikely on a freshly created page, but safe.)
  let name = desiredShortName;
  let counter = 1;
  while (fonts.lookup(PDFName.of(name))) {
    const existing = fonts.lookup(PDFName.of(name));
    if (existing instanceof PDFRef && existing === fontRef) return name;
    name = `${desiredShortName}${++counter}`;
  }
  fonts.set(PDFName.of(name), fontRef);
  return name;
}

function drawRotatedTemplateText({
  page,
  text,
  resolved,
  shortName,
  size,
  rgbColor,
  spineCenterX,
  anchorY,
  anchorAt,
  usableHeight,
  role,
}: {
  page: ReturnType<PDFDocument['addPage']>;
  text: string;
  resolved: ResolvedTemplateFont;
  shortName: string;
  size: number;
  rgbColor: { r: number; g: number; b: number };
  spineCenterX: number;
  anchorY: number;
  anchorAt: 'start' | 'end';
  usableHeight: number;
  role: string;
}): void {
  // Truncate to fit on the spine. Use ellipsis '…' if available; otherwise '...'.
  let truncated = text;
  const measure = (s: string): number => {
    try {
      const enc = encodeAndMeasure(s, resolved.reverseMap, resolved.widthLookup, `spine-${role}`, resolved.baseFont);
      return (enc.widthUnits * size) / 1000;
    } catch {
      return Infinity;
    }
  };
  let widthPt = measure(truncated);
  if (widthPt > usableHeight) {
    const ellipsis = resolved.reverseMap.has('…') ? '…' : '...';
    let lo = 0;
    let hi = text.length;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      const candidate = text.slice(0, mid) + ellipsis;
      const w = measure(candidate);
      if (w <= usableHeight) lo = mid;
      else hi = mid - 1;
    }
    truncated = text.slice(0, lo) + ellipsis;
    widthPt = measure(truncated);
  }

  const enc = encodeAndMeasure(
    truncated,
    resolved.reverseMap,
    resolved.widthLookup,
    `spine-${role}`,
    resolved.baseFont,
  );
  const finalWidthPt = (enc.widthUnits * size) / 1000;

  // Rotation matrix [0 -1 1 0 tx ty] maps text-space (tx, ty) where +x runs
  // down the page and +y runs right across the page. Glyph cap-height extends
  // along text-space +y (i.e. rightward in page-space after rotation).
  // Visually center the glyphs on the spine: shift text-space origin LEFT of
  // spine center by ~0.35 * size so the cap-height occupies the spine band.
  const tx = spineCenterX - size * 0.35;
  const ty = anchorAt === 'start' ? anchorY : anchorY + finalWidthPt;

  const { r, g, b } = rgbColor;
  const num = (n: number) => PDFNumber.of(n);
  page.pushOperators(
    PDFOperator.of(PDFOperatorNames.PushGraphicsState),
    PDFOperator.of(PDFOperatorNames.ConcatTransformationMatrix, [num(0), num(-1), num(1), num(0), num(tx), num(ty)]),
    PDFOperator.of(PDFOperatorNames.BeginText),
    PDFOperator.of(PDFOperatorNames.SetFontAndSize, [PDFName.of(shortName), num(size)]),
    PDFOperator.of(PDFOperatorNames.NonStrokingColorRgb, [num(r), num(g), num(b)]),
    PDFOperator.of(PDFOperatorNames.ShowText, [PDFHexString.of(enc.hex)]),
    PDFOperator.of(PDFOperatorNames.EndText),
    PDFOperator.of(PDFOperatorNames.PopGraphicsState),
  );
}

function truncateToWidthPdfFont(text: string, font: PDFFont, size: number, maxWidth: number): string {
  if (font.widthOfTextAtSize(text, size) <= maxWidth) return text;
  const ellipsis = '…';
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    const candidate = text.slice(0, mid) + ellipsis;
    if (font.widthOfTextAtSize(candidate, size) <= maxWidth) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  return text.slice(0, lo) + ellipsis;
}
