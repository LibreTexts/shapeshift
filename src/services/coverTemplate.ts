import { readFile, writeFile } from 'node:fs/promises';
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
  PDFImage,
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
import { CoverFitMode, FieldOverride, PDFCoverType, SpineImage } from '../types/pdf';

const __dirname = dirname(fileURLToPath(import.meta.url));

const PT_PER_IN = 72;

/**
 * Below this spine width (inches), the spine carries nothing — no TITLE/AUTHOR
 * text and no artwork. A mark squeezed onto a spine too thin to letter would be
 * unreadable and would drift over the seam once the binding is trimmed.
 */
const MIN_SPINE_WIDTH_FOR_CONTENT_IN = 0.5;

/**
 * How far the panel art is pushed past the CaseWrap fold line, in inches. The art
 * is sized to the visible board face, so without this it would stop exactly on the
 * fold and any registration drift would show the canvas color on the finished
 * face. Small enough that nothing meaningful turns in.
 */
const CASEWRAP_ART_BLEED_IN = 0.0625;

/** Default font size (pt) for spine text. */
const DEFAULT_SPINE_FONT_SIZE = 10;

/**
 * Inset (pt) from the head and foot of the spine. Governs everything laid out
 * on the spine: the artwork's top edge, the title's start, and the author's
 * end. Raising it pulls all three inboard, away from the trim, at the cost of
 * an equal amount of run at each end.
 */
const SPINE_TEXT_PADDING_PT = 60;

/**
 * Spine artwork sizing. The mark spans a fraction of the spine's width so it
 * scales with the binding — the CaseWrap and PerfectBound editions of the same
 * book have different spine widths — but stops growing at
 * `SPINE_IMAGE_MAX_ACROSS_PT` so a very thick spine doesn't get a slab.
 * `SPINE_IMAGE_MAX_LENGTH_RATIO` then caps how far a wide wordmark may run down
 * the spine, which is what keeps room for the title beneath it.
 */
const SPINE_IMAGE_WIDTH_RATIO = 0.45;
const SPINE_IMAGE_MAX_ACROSS_PT = 0.75 * PT_PER_IN;
const SPINE_IMAGE_MAX_LENGTH_RATIO = 0.2;

/** Gap (pt) between the bottom of the spine artwork and the start of the title. */
const SPINE_IMAGE_TITLE_GAP_PT = 18;

/**
 * Clear space (pt) kept between the end of the title and the start of the
 * author. Also the margin the artwork has to leave behind: if the title and
 * author cannot both set at full length with this much room between them, the
 * artwork is dropped rather than squeezing the text. Losing the branding beats
 * truncating the title to an ellipsis.
 */
const SPINE_TEXT_MIN_SEPARATION_PT = 18;

type WrapCoverType = Extract<PDFCoverType, 'CaseWrap' | 'PerfectBound'>;

/**
 * Where the artwork sits on the spine, sized from the spine's own width so the
 * CaseWrap and PerfectBound editions of one book each get a mark in proportion
 * to their binding.
 *
 * Pure, and separate from the drawing, because the fit test needs `lengthPt`
 * before anything is committed to the page.
 */
function spineImageBox(spineImage: SpineImage, spineWidthPt: number, usableRunPt: number): SpineImageBox {
  const aspect = spineImage.widthPx / spineImage.heightPx;
  let acrossPt = Math.min(spineWidthPt * SPINE_IMAGE_WIDTH_RATIO, SPINE_IMAGE_MAX_ACROSS_PT);
  let lengthPt = acrossPt * aspect;

  // A wide wordmark would otherwise run most of the way down the spine. Scale
  // both edges back together so the aspect ratio survives the clamp.
  const maxLengthPt = usableRunPt * SPINE_IMAGE_MAX_LENGTH_RATIO;
  if (lengthPt > maxLengthPt) {
    lengthPt = maxLengthPt;
    acrossPt = lengthPt / aspect;
  }
  return { acrossPt, lengthPt };
}

/**
 * The title as it will be lettered on the spine. Shared by the artwork's fit
 * test and the text layout so the two can't drift apart on which title they
 * measured.
 */
function spineTitleOf(bookInfo: BookPageInfo): string {
  return (bookInfo.printInfo?.title || bookInfo.title || '').trim();
}

export interface SpineTextOptions {
  /** Force-disable spine text even on wide spines. */
  enabled?: boolean;
  /** Font BaseFont/shortName to look up in the front or back template, used for both lines unless overridden. */
  spineFontName?: string;
  /** Override font for the spine title. Falls back to spineFontName, then Atkinson. */
  titleFontName?: string;
  /** Override font for the spine author. Falls back to spineFontName, then Atkinson. */
  authorFontName?: string;
  /**
   * Title face used when no template-font name is set: a bundled name
   * (see BUNDLED_SPINE_FONT_NAMES) or a path to a .ttf. TrueType only.
   */
  titleTtfPath?: string;
  /** Author face, same accepted values as `titleTtfPath`. */
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
   * Optional artwork drawn at the top of the spine, above the title. Omit it
   * (or pass null) for a flat color spine — the common case.
   */
  spineImage?: SpineImage | null;
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

/**
 * One spine line resolved to a font: measurable before anything is committed to
 * the page, drawable afterwards. The split exists because the artwork can only
 * decide whether it fits once it knows how much room the text actually wants,
 * and resolving the fonts twice would embed them twice.
 */
interface PreparedSpineLine {
  text: string;
  /** Width in points if the line were set in full, with nothing clipping it. */
  naturalWidthPt: number;
  /** Draws the line, truncating to `maxRunPt`. `anchorY` is its starting edge. */
  draw(anchorY: number, maxRunPt: number): void;
}

interface PreparedSpineText {
  title: PreparedSpineLine | null;
  author: PreparedSpineLine | null;
}

/** Where the artwork lands on the spine, in points. */
interface SpineImageBox {
  /** Extent across the spine's width. */
  acrossPt: number;
  /** Extent down the spine's length. */
  lengthPt: number;
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
      debug: this.debug ? (...args: unknown[]) => log.withMetadata({ args }).debug('[fill-form]') : false,
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
      spineImage,
      coverFit = 'fill-crop',
    } = input;

    const [filledFront, filledBack] = await Promise.all([
      this.fillFromBookInfo(frontTemplateBytes, bookInfo, { extraValues, overrides }),
      this.tryFillOrPassthrough(backTemplateBytes, bookInfo, { extraValues, overrides }),
    ]);

    const { spineWidth, totalWidth, height, wrap } = getCoverDimensions(coverType, numPages);

    const pageWidthPt = totalWidth * PT_PER_IN;
    const pageHeightPt = height * PT_PER_IN;
    const spineWidthPt = spineWidth * PT_PER_IN;
    const panelWidthPt = ((totalWidth - spineWidth) / 2) * PT_PER_IN;

    // On a CaseWrap the wrap allowance folds around the board, so art sized to
    // the full panel loses its outer 0.625in from view. Sizing it to the visible
    // board face instead lets one PerfectBound-sized template serve both
    // bindings. The face is the panel pulled in by the wrap on its three OUTER
    // edges only — the spine edge is a hard edge, nothing turns in there. Every
    // other binding reports `wrap` 0, which collapses the face back onto the
    // panel and leaves the placement math exactly as it was.
    const wrapPt = wrap * PT_PER_IN;
    const bleedPt = wrap > 0 ? CASEWRAP_ART_BLEED_IN * PT_PER_IN : 0;

    const destDoc = await PDFDocument.create();
    destDoc.registerFontkit(fontkit);
    const page = destDoc.addPage([pageWidthPt, pageHeightPt]);

    const [backEmbed] = await destDoc.embedPdf(filledBack, [0]);
    const [frontEmbed] = await destDoc.embedPdf(filledFront, [0]);

    // Color-space seam fix: the panel art carries an embedded ICC (RGB) profile,
    // but a plain DeviceRGB fill is rendered through the viewer's default RGB,
    // which hue-shifts against the ICC-managed panels at the seam. If either
    // template exposes an ICC profile, reuse it so the flat fills are in the
    // SAME color space as the panels, and register it as a document OutputIntent
    // so the whole cover renders under one color pipeline. Safe to resolve here:
    // it only scans the objects `embedPdf` just brought in.
    const spineCs = setupIccColorSpace(destDoc, page, this.debug);

    fillRect(page, spineCs, spineHex, { x: panelWidthPt, y: 0, w: spineWidthPt, h: pageHeightPt });

    const backPanel: Rect = { x: 0, y: 0, w: panelWidthPt, h: pageHeightPt };
    const frontPanel: Rect = { x: panelWidthPt + spineWidthPt, y: 0, w: panelWidthPt, h: pageHeightPt };

    /** The part of a panel a reader actually sees once the wrap turns in. */
    const boardFace = (panel: Rect, outerSide: 'left' | 'right'): Rect => ({
      x: outerSide === 'left' ? panel.x + wrapPt : panel.x,
      y: panel.y + wrapPt,
      w: panel.w - wrapPt,
      h: panel.h - 2 * wrapPt,
    });
    /**
     * Grow the face by the bleed on all four sides to get the box the art is
     * sized and centered in. Symmetric on purpose: it keeps the design's own
     * center on the center of the visible face, which is what a centered layout
     * wants, and pushes the art past every fold so registration drift can't
     * expose the canvas. The spine-side overflow is trimmed by the panel clip.
     */
    const artBox = (face: Rect): Rect => ({
      x: face.x - bleedPt,
      y: face.y - bleedPt,
      w: face.w + 2 * bleedPt,
      h: face.h + 2 * bleedPt,
    });

    const backFace = boardFace(backPanel, 'left');
    const frontFace = boardFace(frontPanel, 'right');

    // Canvas for the wrap band. Painted as a frame, never as a solid panel: the
    // art leaves regions transparent that have to stay white — the De Anza back
    // cover's body-copy panel is one — and a solid fill would show through as
    // brand color and swamp the text. The art's bleed laps over the frame's
    // inner edge, so no seam can open up between the two.
    if (wrapPt > 0) {
      fillFrame(page, spineCs, spineHex, backPanel, backFace);
      fillFrame(page, spineCs, spineHex, frontPanel, frontFace);

      if (this.debug) {
        log.debug(
          `[buildFinalCover] ${coverType} wrap ${wrap}in: board face ` +
            `${backFace.w.toFixed(1)}x${backFace.h.toFixed(1)}pt inside a ` +
            `${panelWidthPt.toFixed(1)}x${pageHeightPt.toFixed(1)}pt panel; art sized to ` +
            `${artBox(backFace).w.toFixed(1)}x${artBox(backFace).h.toFixed(1)}pt ` +
            `(+${bleedPt.toFixed(1)}pt bleed past every fold)`,
        );
      }
    }

    // Each panel's art is scaled UNIFORMLY (never stretched) and centered in its
    // art box, then clipped to the full panel so overflow can't bleed into the
    // spine or the opposite panel. See `drawPanelClipped`.
    const backFit = artBox(backFace);
    const frontFit = artBox(frontFace);

    drawPanelClipped(page, backEmbed, backPanel, backFit, coverFit);

    // The artwork and the text share one width threshold: a spine too thin to
    // letter is too thin to brand.
    if (spineWidth >= MIN_SPINE_WIDTH_FOR_CONTENT_IN) {
      // Resolve and measure the text first. The artwork's own fit test needs to
      // know how much run the title and author want before it commits to a size
      // or a position, and this is also what fixes the title's start.
      const prepared: PreparedSpineText =
        spineText?.enabled === false
          ? { title: null, author: null }
          : await this.prepareSpineText({
              destDoc,
              page,
              spineLeftPt: panelWidthPt,
              spineWidthPt,
              bookInfo,
              frontTemplateBytes: filledFront,
              backTemplateBytes: filledBack,
              options: spineText ?? {},
            });

      if (spineText?.enabled === false && this.debug) {
        log.debug('[buildFinalCover] skipping spine text (disabled by caller)');
      }

      const imageBottomPt = spineImage
        ? await this.drawSpineImage({
            destDoc,
            page,
            spineLeftPt: panelWidthPt,
            spineWidthPt,
            pageHeightPt,
            spineImage,
            prepared,
          })
        : null;

      // The author is drawn upward from the bottom inset and always keeps the
      // full run; only the title gives ground to artwork above it.
      const titleAnchorY = imageBottomPt ?? pageHeightPt - SPINE_TEXT_PADDING_PT;
      prepared.title?.draw(titleAnchorY, titleAnchorY - SPINE_TEXT_PADDING_PT);
      prepared.author?.draw(SPINE_TEXT_PADDING_PT, pageHeightPt - 2 * SPINE_TEXT_PADDING_PT);
    } else if (this.debug) {
      log.debug(
        `[buildFinalCover] skipping spine content (spineWidth=${spineWidth.toFixed(3)}in is under the ` +
          `${MIN_SPINE_WIDTH_FOR_CONTENT_IN}in minimum)`,
      );
    }

    drawPanelClipped(page, frontEmbed, frontPanel, frontFit, coverFit);

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

  /**
   * Paints a filled front template over page 1 of an existing PDF, in place.
   *
   * This is how the custom front art reaches the digital `Full.pdf`. Prince
   * cannot render a PDF as an image (16.2 reports "Unknown image format"), and
   * the runtime container carries no rasterizer, so the art has to be composited
   * after the Prince run.
   *
   * It overlays rather than replacing the page on purpose. Removing and
   * re-inserting page 1 would leave the tagged PDF's structure tree pointing at
   * a page that no longer exists; drawing onto the page Prince already produced
   * leaves the page tree, the structure tree, and every other page untouched.
   * The caller renders that page blank (see `generateBlankCoverPageHTML`) so
   * there is nothing underneath the art.
   */
  async overlayOnFirstPage(
    targetPath: string,
    frontPageBytes: Uint8Array,
    coverFit: CoverFitMode = 'fill-crop',
  ): Promise<void> {
    const targetBytes = await readFile(targetPath);
    const doc = await PDFDocument.load(targetBytes);
    if (doc.getPageCount() === 0) {
      throw new Error(`Cannot overlay a cover onto ${targetPath}: the document has no pages.`);
    }

    const page = doc.getPage(0);
    const { width, height } = page.getSize();
    const [embed] = await doc.embedPdf(frontPageBytes, [0]);
    // A digital front page has no wrap allowance, so the fit box is the whole page.
    const box: Rect = { x: 0, y: 0, w: width, h: height };
    drawPanelClipped(page, embed, box, box, coverFit);

    await writeFile(targetPath, await doc.save());
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

  /**
   * Draws the org's mark at the top of the spine and returns the y coordinate
   * the title should start from (the bottom of the mark, less a gap). Returns
   * null when the mark is dropped, leaving the title its usual full run.
   *
   * Rotated -90 to match the spine text, so a wordmark reads top-to-bottom
   * alongside the title rather than lying on its side.
   *
   * The geometry follows from what pdf-lib's `drawImage` emits:
   * `translate(x,y) . rotate(θ) . scale(w,h)` over the unit square. At θ = -90 a
   * local point (u,v) lands at (x + h·v, y - w·u), so the `height` argument
   * becomes the ACROSS-spine extent and `width` becomes the DOWN-spine extent —
   * they read backwards from their names here, which is why the locals are named
   * `acrossPt` and `lengthPt` instead. Aspect is preserved by holding
   * `lengthPt / acrossPt` equal to the image's native pixel ratio.
   */
  private async drawSpineImage({
    destDoc,
    page,
    spineLeftPt,
    spineWidthPt,
    pageHeightPt,
    spineImage,
    prepared,
  }: {
    destDoc: PDFDocument;
    page: PDFPage;
    spineLeftPt: number;
    spineWidthPt: number;
    pageHeightPt: number;
    spineImage: SpineImage;
    prepared: PreparedSpineText;
  }): Promise<number | null> {
    const usableRunPt = pageHeightPt - 2 * SPINE_TEXT_PADDING_PT;
    const { acrossPt, lengthPt } = spineImageBox(spineImage, spineWidthPt, usableRunPt);

    // The text outranks the branding. Measure what the title and author want at
    // full length and drop the mark if it would force either of them to
    // truncate — the alternative is a book whose title ends in an ellipsis.
    const titleWidthPt = prepared.title?.naturalWidthPt ?? 0;
    const authorWidthPt = prepared.author?.naturalWidthPt ?? 0;
    const separationPt = titleWidthPt && authorWidthPt ? SPINE_TEXT_MIN_SEPARATION_PT : 0;
    const textWantsPt = titleWidthPt + authorWidthPt + separationPt;
    const roomWithImagePt = usableRunPt - lengthPt - SPINE_IMAGE_TITLE_GAP_PT;

    if (textWantsPt > roomWithImagePt) {
      if (this.debug) {
        log.debug(
          `[buildFinalCover] skipping spine image: text wants ${textWantsPt.toFixed(1)}pt ` +
            `(title ${titleWidthPt.toFixed(1)} + author ${authorWidthPt.toFixed(1)} + ${separationPt}pt apart) ` +
            `but only ${roomWithImagePt.toFixed(1)}pt would remain beside a ${lengthPt.toFixed(1)}pt mark`,
        );
      }
      return null;
    }

    const embedded: PDFImage = await destDoc.embedPng(spineImage.bytes);
    const topPt = pageHeightPt - SPINE_TEXT_PADDING_PT;
    const x = spineLeftPt + (spineWidthPt - acrossPt) / 2;

    // Clip to the spine band so a pathological aspect ratio can't bleed onto a
    // panel, the same guard `drawPanelClipped` puts around the cover art.
    page.pushOperators(pushGraphicsState(), rectangle(spineLeftPt, 0, spineWidthPt, pageHeightPt), clip(), endPath());
    page.drawImage(embedded, { x, y: topPt, width: lengthPt, height: acrossPt, rotate: degrees(-90) });
    page.pushOperators(popGraphicsState());

    if (this.debug) {
      log.debug(
        `[buildFinalCover] spine image ${spineImage.widthPx}x${spineImage.heightPx}px drawn ` +
          `${(acrossPt / PT_PER_IN).toFixed(3)}in across x ${(lengthPt / PT_PER_IN).toFixed(3)}in down, ` +
          `top at y=${topPt.toFixed(1)}pt; text wants ${textWantsPt.toFixed(1)}pt of ${roomWithImagePt.toFixed(1)}pt`,
      );
    }

    return topPt - lengthPt - SPINE_IMAGE_TITLE_GAP_PT;
  }

  /**
   * Resolves the spine title and author to embedded fonts and measures them,
   * without drawing anything.
   *
   * Split out from drawing so the artwork can consult the measurements before
   * claiming any of the spine. Resolving here also means each face is embedded
   * exactly once, however the fit test goes.
   */
  private async prepareSpineText({
    destDoc,
    page,
    spineLeftPt,
    spineWidthPt,
    bookInfo,
    frontTemplateBytes,
    backTemplateBytes,
    options,
  }: {
    destDoc: PDFDocument;
    page: ReturnType<PDFDocument['addPage']>;
    spineLeftPt: number;
    spineWidthPt: number;
    bookInfo: BookPageInfo;
    frontTemplateBytes: Uint8Array;
    backTemplateBytes: Uint8Array;
    options: SpineTextOptions;
  }): Promise<PreparedSpineText> {
    const title = spineTitleOf(bookInfo);
    const author = (bookInfo.printInfo?.authorName || '').trim();
    if (!title && !author) return { title: null, author: null };

    const titleSize = options.titleSize ?? options.size ?? DEFAULT_SPINE_FONT_SIZE;
    const authorSize = options.authorSize ?? options.size ?? DEFAULT_SPINE_FONT_SIZE;
    const { r, g, b } = options.color ? hexToRgb01(options.color) : { r: 1, g: 1, b: 1 };
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

    const resolveTemplateFont = (requestedName: string, role: 'title' | 'author'): ResolvedTemplateFont => {
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

    const prepareLine = async (
      text: string,
      role: 'title' | 'author',
      anchorAt: 'start' | 'end',
      size: number,
      fontName: string | undefined,
      ttfPath: string | undefined,
      variant: 'bold' | 'regular',
    ): Promise<PreparedSpineLine> => {
      if (fontName) {
        const resolved = resolveTemplateFont(fontName, role);
        const shortName = ensureFontOnPage(
          destDoc,
          page,
          resolved.destFontRef,
          role === 'title' ? '__SpineT' : '__SpineA',
        );
        let naturalWidthPt: number;
        try {
          const enc = encodeAndMeasure(
            text,
            resolved.reverseMap,
            resolved.widthLookup,
            `spine-${role}`,
            resolved.baseFont,
          );
          naturalWidthPt = (enc.widthUnits * size) / 1000;
        } catch {
          // A glyph the template font can't encode. `drawRotatedTemplateText`
          // treats that as unmeasurable and truncates its way down, so report
          // the line as needing everything and let the artwork stand aside.
          naturalWidthPt = Infinity;
        }
        return {
          text,
          naturalWidthPt,
          draw: (anchorY, maxRunPt) =>
            drawRotatedTemplateText({
              page,
              text,
              resolved,
              shortName,
              size,
              rgbColor: { r, g, b },
              spineCenterX,
              anchorY,
              anchorAt,
              usableHeight: maxRunPt,
              role,
            }),
        };
      }

      const font = await this.loadSpineFont(destDoc, ttfPath, variant);
      const baselineX = spineCenterX - size / 3;
      return {
        text,
        naturalWidthPt: font.widthOfTextAtSize(text, size),
        draw: (anchorY, maxRunPt) => {
          const truncated = truncateToWidthPdfFont(text, font, size, maxRunPt);
          // A line anchored at its `end` runs upward from `anchorY`, so its
          // baseline sits a full text-width above it.
          const y = anchorAt === 'start' ? anchorY : anchorY + font.widthOfTextAtSize(truncated, size);
          page.drawText(truncated, { x: baselineX, y, size, font, color: rgb(r, g, b), rotate: degrees(-90) });
        },
      };
    };

    return {
      title: title
        ? await prepareLine(title, 'title', 'start', titleSize, titleFontName, options.titleTtfPath, 'bold')
        : null,
      author: author
        ? await prepareLine(author, 'author', 'end', authorSize, authorFontName, options.authorTtfPath, 'regular')
        : null,
    };
  }

  private async loadSpineFont(
    destDoc: PDFDocument,
    ttfPathOrName: string | undefined,
    variant: 'bold' | 'regular',
  ): Promise<PDFFont> {
    const path = resolveSpineFontPath(ttfPathOrName, variant);
    // Reject CFF-outline fonts (.otf / OpenType-PostScript). pdf-lib's subsetter
    // emits a corrupt font program for them: the PDF still claims the font is
    // embedded, but renderers fail with "Embedded font file may be invalid" and
    // fall back to a substitute. A silently broken embed is worse than no embed,
    // so fail here rather than shipping a cover that dies at preflight.
    if (/\.(otf|pfb|pfa|t1)$/i.test(path)) {
      throw new Error(
        `Spine font "${path}" is not a TrueType file. pdf-lib cannot subset CFF/Type 1 outlines ` +
          `without corrupting them. Use a .ttf, or one of the bundled faces: ` +
          `${Object.keys(BUNDLED_SPINE_FONTS).join(', ')}.`,
      );
    }
    // Intentionally do not fall back to a StandardFonts (base-14) font: those
    // are not embedded by the PDF spec, which would silently produce a cover
    // that fails Lulu's "all fonts embedded" preflight. Fail loudly instead.
    const bytes = await readFile(path);
    return destDoc.embedFont(bytes, { subset: true });
  }
}

/**
 * Spine faces shipped in `src/styles/fonts` (copied to `build/styles` by the
 * build script), selectable by name so callers don't have to know a deploy
 * path. Both are TrueType — see the CFF guard in `loadSpineFont`.
 *
 * `liberation-sans` is metric-compatible with Arial, and therefore with
 * Helvetica, which makes it the stand-in when a template asks for a base-14
 * font it can never actually embed. SIL OFL 1.1 — see LiberationSans-OFL.txt.
 */
const BUNDLED_SPINE_FONTS: Record<string, { bold: string; regular: string }> = {
  'atkinson-hyperlegible': {
    bold: 'atkinson-hyperlegible-700.ttf',
    regular: 'atkinson-hyperlegible-400.ttf',
  },
  'liberation-sans': {
    bold: 'liberation-sans-700.ttf',
    regular: 'liberation-sans-400.ttf',
  },
};

const DEFAULT_BUNDLED_SPINE_FONT = 'atkinson-hyperlegible';

/**
 * Resolve a spine font selector to a file path. Accepts a bundled face name
 * ("liberation-sans"), an explicit path to a font file, or nothing (bundled
 * default). Exported so callers can validate a selector before doing work.
 */
export function resolveSpineFontPath(ttfPathOrName: string | undefined, variant: 'bold' | 'regular'): string {
  const name = ttfPathOrName ?? DEFAULT_BUNDLED_SPINE_FONT;
  const bundled = BUNDLED_SPINE_FONTS[name];
  if (bundled) return join(__dirname, '../styles/fonts', bundled[variant]);
  return name;
}

/** Names accepted by `resolveSpineFontPath` in place of a path. */
export const BUNDLED_SPINE_FONT_NAMES = Object.keys(BUNDLED_SPINE_FONTS);

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

/** An axis-aligned rectangle in page space, in points. */
interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Draw an embedded template page into a panel, scaled UNIFORMLY (so the art keeps
 * its aspect ratio — no non-uniform width/height stretching) and centered.
 *
 * `fit` and `clip` are separate rectangles because on a CaseWrap they genuinely
 * differ: the art is sized to the visible board face, which is the panel pulled in
 * by the wrap allowance on its three outer edges, while the clip still has to hold
 * the whole panel so the overflow has somewhere to land. Everywhere else the two
 * are the same rectangle and this behaves exactly as it always has.
 *
 * The clip is what stops a `fill-crop` aspect mismatch from spilling into the
 * spine or the opposite panel.
 */
function drawPanelClipped(
  page: PDFPage,
  embed: PDFEmbeddedPage,
  clipBox: Rect,
  fitBox: Rect,
  mode: CoverFitMode,
): void {
  const scale =
    mode === 'fit'
      ? Math.min(fitBox.w / embed.width, fitBox.h / embed.height)
      : Math.max(fitBox.w / embed.width, fitBox.h / embed.height);
  const drawW = embed.width * scale;
  const drawH = embed.height * scale;
  const x = fitBox.x + (fitBox.w - drawW) / 2;
  const y = fitBox.y + (fitBox.h - drawH) / 2;

  // `q  <clipBox re>  W  n` clips subsequent drawing to the panel rectangle; the
  // matching `Q` is pushed after the page is drawn.
  page.pushOperators(pushGraphicsState(), rectangle(clipBox.x, clipBox.y, clipBox.w, clipBox.h), clip(), endPath());
  page.drawPage(embed, { x, y, width: drawW, height: drawH });
  page.pushOperators(popGraphicsState());
}

/**
 * Paint a solid rectangle in the document's color space.
 *
 * Routed through here rather than `page.drawRectangle` so the spine and the
 * CaseWrap wrap canvas are painted the same way. If they took different paths one
 * would go through the embedded ICC profile and the other through the viewer's
 * default RGB, and the same hex would hue-shift where they meet at the head and
 * foot. `csName` is the ICC color space resource from `setupIccColorSpace`, or
 * null when the templates carry no profile and DeviceRGB is all there is.
 */
function fillRect(page: PDFPage, csName: string | null, hex: string, box: Rect): void {
  const { r, g, b } = hexToRgb01(hex);
  if (csName) {
    page.pushOperators(
      pushGraphicsState(),
      PDFOperator.of(PDFOperatorNames.NonStrokingColorspace, [PDFName.of(csName)]),
      PDFOperator.of(PDFOperatorNames.NonStrokingColorN, [PDFNumber.of(r), PDFNumber.of(g), PDFNumber.of(b)]),
      rectangle(box.x, box.y, box.w, box.h),
      fill(),
      popGraphicsState(),
    );
    return;
  }
  page.drawRectangle({ x: box.x, y: box.y, width: box.w, height: box.h, color: rgb(r, g, b), borderWidth: 0 });
}

/**
 * Paint the band between two nested rectangles and nothing else, via an even-odd
 * fill of both subpaths.
 *
 * The hole matters. Template art routinely leaves regions transparent and relies
 * on the page underneath being white — the De Anza back cover's body-copy panel
 * is one — so a solid fill under a panel would show through as brand color and
 * swamp the text. Painting only the frame keeps the canvas out from under the
 * art entirely.
 */
function fillFrame(page: PDFPage, csName: string | null, hex: string, outer: Rect, inner: Rect): void {
  const { r, g, b } = hexToRgb01(hex);
  const color: PDFOperator[] = csName
    ? [
        PDFOperator.of(PDFOperatorNames.NonStrokingColorspace, [PDFName.of(csName)]),
        PDFOperator.of(PDFOperatorNames.NonStrokingColorN, [PDFNumber.of(r), PDFNumber.of(g), PDFNumber.of(b)]),
      ]
    : [PDFOperator.of(PDFOperatorNames.NonStrokingColorRgb, [PDFNumber.of(r), PDFNumber.of(g), PDFNumber.of(b)])];

  page.pushOperators(
    pushGraphicsState(),
    ...color,
    rectangle(outer.x, outer.y, outer.w, outer.h),
    rectangle(inner.x, inner.y, inner.w, inner.h),
    PDFOperator.of(PDFOperatorNames.FillEvenOdd),
    popGraphicsState(),
  );
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
