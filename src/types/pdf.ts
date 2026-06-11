import { PDF_COVER_TYPES } from '../util/pdfHelpers';

export type PDFCoverOpts = {
  extraPadding?: boolean;
  hardcover?: boolean;
  thin?: boolean;
};

export type PDFCoverType = (typeof PDF_COVER_TYPES)[number];

export type PDFCoverDimensions = {
  /** Spine width in inches */
  spineWidth: number;
  /** Total cover width in inches (back panel + spine + front panel) */
  totalWidth: number;
  /** Total cover height in inches */
  height: number;
};

// ---------- Cover template filler ----------
// Types for src/util/coverTemplateFiller.ts (filling AcroForm-based custom
// cover templates per docs/COVER_TEMPLATE_GUIDELINES.md).

export type RGB = [number, number, number];

export type CanonicalFieldName = 'TITLE' | 'AUTHOR' | 'COURSE' | 'LIBRARY' | 'SUBJECT' | 'LICENSE' | 'BOOK_ID';

export interface FieldOverride {
  font?: string;
  size?: number;
  color?: RGB;
  align?: number;
  multiline?: boolean;
}

export type CoverTemplateDebug = boolean | ((...args: unknown[]) => void);

/**
 * How a panel's template art is placed inside its destination panel region when
 * the template's aspect ratio doesn't match the panel:
 *  - `fill-crop` (default): scale uniformly to cover the whole panel, centering
 *    and clipping any overflow. Recommended for full-bleed covers — no blank
 *    margins, and the bleed edges absorb the crop.
 *  - `fit`: scale uniformly to show all art, leaving margins where aspect
 *    ratios differ. Use when nothing in the art may be cropped.
 * Either way the art is never stretched non-uniformly (the old behavior).
 */
export type CoverFitMode = 'fill-crop' | 'fit';

export interface FillCoverTemplateOptions {
  templateBytes: Uint8Array | ArrayBuffer | string;
  values: Record<string, unknown>;
  overrides?: Record<string, FieldOverride>;
  // When truthy, emit verbose diagnostic logs covering the document, every
  // discovered form field, font properties, /DA parsing, per-line layout
  // measurements, and the final appearance-stream geometry. Pass a function
  // to route the logs (e.g. to loglayer); pass `true` to log via console.
  debug?: CoverTemplateDebug;
}
