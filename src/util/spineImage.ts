import sharp from 'sharp';
import { SpineImage } from '../types/pdf';

/**
 * Longest edge, in pixels, kept after resampling. The mark is never drawn longer
 * than ~4in down the spine, so 1200px is 300 DPI at the largest size it can
 * reach — past that the extra samples are invisible in print and only inflate
 * the embedded object.
 */
const MAX_SPINE_IMAGE_EDGE_PX = 1200;

/**
 * Decodes an org's spine artwork and re-encodes it as a PNG that pdf-lib can
 * embed safely.
 *
 * The re-encode is the point, not the resize. A progressive JPEG (which is what
 * orgs export by default) embeds fine as far as pdf-lib is concerned — its
 * JpegEmbedder accepts the SOF2 marker — and then hands the raw bytes to
 * `DCTDecode`, which print RIPs and PDF/X preflight routinely reject. Going out
 * as PNG lands the image as lossless Flate instead, carries any alpha through
 * pdf-lib's SMask path, and normalizes CMYK JPEGs, WebP, and TIFF for free.
 *
 * Throws on undecodable input. Callers treat that as "no spine image" and fall
 * back to the flat color spine.
 */
export async function normalizeSpineImage(input: Uint8Array): Promise<SpineImage> {
  const buffer = Buffer.from(input.buffer, input.byteOffset, input.byteLength);

  // `rotate()` with no argument bakes in EXIF orientation before the metadata is
  // dropped, so a phone-camera export doesn't come out sideways on the spine.
  const { data, info } = await sharp(buffer, { failOn: 'none', animated: false })
    .rotate()
    .resize({
      fit: 'inside',
      height: MAX_SPINE_IMAGE_EDGE_PX,
      width: MAX_SPINE_IMAGE_EDGE_PX,
      withoutEnlargement: true,
    })
    .png({ compressionLevel: 9, effort: 7 })
    .toBuffer({ resolveWithObject: true });

  if (!info.width || !info.height) {
    throw new Error('Spine image decoded to zero dimensions');
  }

  return { bytes: new Uint8Array(data), widthPx: info.width, heightPx: info.height };
}
