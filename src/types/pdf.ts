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
