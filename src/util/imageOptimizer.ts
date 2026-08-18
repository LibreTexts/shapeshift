import sharp from 'sharp';

/**
 * Result of a successful optimization pass. `extension` and `mimeType` describe the
 * *output* encoding, which may differ from the input (e.g. a photographic PNG re-encoded
 * as JPEG), so callers must use these rather than the source URL's extension or the
 * response's Content-Type.
 */
export interface OptimizedImage {
  data: Buffer;
  /** Constrained to the two encodings we emit, so it can be safely used in a file name. */
  extension: 'jpg' | 'png';
  format: 'jpeg' | 'png';
  height: number;
  mimeType: string;
  width: number;
}

export interface ImageOptimizeOptions {
  /** Longest permitted height, in pixels. Aspect ratio is always preserved. */
  maxHeight: number;
  /** Longest permitted width, in pixels. Aspect ratio is always preserved. */
  maxWidth: number;
  /** JPEG quality (1-100) used for photographic content. */
  jpegQuality: number;
}

/**
 * Shannon entropy above which an image is treated as photographic (and therefore a good
 * candidate for lossy JPEG). Photographs typically land at 6.0+; charts, line art, and
 * screenshots of text sit well below.
 */
const PHOTOGRAPHIC_ENTROPY_THRESHOLD = 5.0;

/**
 * Safety valve: an opaque image classified as line art whose lossless encoding still
 * exceeds this size is re-encoded as JPEG. Prevents a pathological "screenshot" (really a
 * photo with a flat border) from re-introducing multi-megabyte FlateDecode objects.
 */
const MAX_LOSSLESS_OUTPUT_BYTES = 1024 * 1024;

/**
 * Formats we deliberately leave untouched. SVG is vector (it scales for free and is tiny),
 * and animated images would lose their frames on re-encode.
 */
const PASSTHROUGH_FORMATS = new Set(['svg']);

function describe(format: 'jpeg' | 'png'): { extension: 'jpg' | 'png'; mimeType: string } {
  return format === 'jpeg' ? { extension: 'jpg', mimeType: 'image/jpeg' } : { extension: 'png', mimeType: 'image/png' };
}

/**
 * Resamples an image down to the largest size the output medium can actually display and
 * re-encodes it with a content-aware codec choice.
 *
 * Prince embeds raster images at their *source* pixel dimensions and never resamples —
 * a 4000x3000 photo rendered into a 3in box is embedded at 4000x3000 (and re-encoded as
 * FlateDecode if it wasn't already a JPEG). This function is what keeps the embedded data
 * proportional to the rendered size.
 *
 * Returns `null` when the image should be used as-is (vector, animated, undecodable, or
 * already smaller than the cap in a format we wouldn't improve). Callers must treat `null`
 * as "keep the original" rather than as an error.
 */
export async function optimizeImageBuffer(
  input: Buffer,
  { jpegQuality, maxHeight, maxWidth }: ImageOptimizeOptions,
): Promise<OptimizedImage | null> {
  try {
    const metadata = await sharp(input, { failOn: 'none', animated: false }).metadata();
    if (!metadata.format || PASSTHROUGH_FORMATS.has(metadata.format)) return null;
    // `pages` > 1 means an animated GIF/WebP or a multi-page TIFF — re-encoding would drop frames.
    if ((metadata.pages ?? 1) > 1) return null;
    if (!metadata.width || !metadata.height) return null;

    const needsResize = metadata.width > maxWidth || metadata.height > maxHeight;

    // `rotate()` with no argument bakes in EXIF orientation before metadata is stripped,
    // so images don't come out sideways once the EXIF tag is gone.
    let pipeline = sharp(input, { failOn: 'none', animated: false }).rotate();
    if (needsResize) {
      pipeline = pipeline.resize({ fit: 'inside', height: maxHeight, width: maxWidth, withoutEnlargement: true });
    }

    const stats = await pipeline.clone().stats();
    const hasTransparency = Boolean(metadata.hasAlpha) && !stats.isOpaque;
    const isPhotographic = stats.entropy >= PHOTOGRAPHIC_ENTROPY_THRESHOLD;

    // Encoder choice, in priority order:
    //  1. Transparency must survive — JPEG has no alpha, and flattening onto white breaks
    //     any figure not sitting on a white background.
    //  2. A source that is already JPEG stays JPEG. Re-encoding it losslessly would bloat
    //     it, and quantizing it to a palette risks banding in gradients the codec smoothed.
    //  3. Otherwise entropy decides: photographs compress far better as JPEG, while charts,
    //     line art, and screenshots of text keep their crisp edges only in a lossless format.
    let format: 'jpeg' | 'png';
    if (hasTransparency) {
      format = 'png';
    } else if (metadata.format === 'jpeg' || isPhotographic) {
      format = 'jpeg';
    } else {
      format = 'png';
    }

    const encode = (target: 'jpeg' | 'png') =>
      target === 'jpeg'
        ? pipeline
            .clone()
            .flatten({ background: '#ffffff' })
            .jpeg({ chromaSubsampling: '4:2:0', mozjpeg: true, quality: jpegQuality })
            .toBuffer({ resolveWithObject: true })
        : pipeline.clone().png({ compressionLevel: 9, effort: 7, palette: true }).toBuffer({ resolveWithObject: true });

    let encoded = await encode(format);

    // Line-art classification that still produces a huge lossless file was probably wrong.
    if (format === 'png' && !hasTransparency && encoded.data.length > MAX_LOSSLESS_OUTPUT_BYTES) {
      const jpeg = await encode('jpeg');
      if (jpeg.data.length < encoded.data.length) {
        encoded = jpeg;
        format = 'jpeg';
      }
    }

    // Re-encoding an already-small, already-efficient image can make it bigger. If we
    // didn't need to resize and gained nothing, tell the caller to keep the original.
    if (!needsResize && encoded.data.length >= input.length) return null;

    return {
      data: encoded.data,
      format,
      height: encoded.info.height,
      width: encoded.info.width,
      ...describe(format),
    };
  } catch {
    // Undecodable or otherwise hostile input — the caller keeps the original bytes.
    return null;
  }
}
