import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import type { Options } from 'qr-code-styling-node';
import { QRCodeStyling } from 'qr-code-styling-node/lib/qr-code-styling.common.js';

const QR_SIZE = 300;
const LOGO_FRACTION = 0.3;
const LOGO_PADDING = 8;

let iconDataUri: string | undefined;

function getIconDataUri(): string {
  if (iconDataUri !== undefined) return iconDataUri;

  const currentDirPath = path.dirname(fileURLToPath(import.meta.url));
  const filePath = path.resolve(currentDirPath, './qr_icon.png');
  if (!existsSync(filePath)) {
    throw new Error(`QR code icon not found (looked in: "${currentDirPath}")`);
  }

  iconDataUri = `data:image/png;base64,${readFileSync(filePath).toString('base64')}`;
  return iconDataUri;
}

/**
 * Generate a styled QR code with the LibreTexts favicon composited into the center. Returns an `<img>`-ready
 * `data:image/svg+xml;base64,...` URI.
 */
export async function generateQRCode(url: string): Promise<string> {
  const qr = new QRCodeStyling({
    backgroundOptions: { color: '#ffffff' },
    cornersDotOptions: { type: 'square', color: '#000000' },
    cornersSquareOptions: { type: 'square', color: '#000000' },
    data: url,
    dotsOptions: { type: 'dots', color: '#000000' },
    height: QR_SIZE,
    jsdom: JSDOM,
    margin: 5,
    qrOptions: { errorCorrectionLevel: 'H', mode: 'Byte', typeNumber: 0 },
    type: 'svg',
    width: QR_SIZE,
  } as unknown as Options);

  const raw = await qr.getRawData('svg');
  if (!raw) throw new Error('QR code generation returned no data');
  let svg = (raw as Buffer).toString('utf8');

  // Composite the icon over the center of the finished QR SVG
  const logoSize = Math.round(QR_SIZE * LOGO_FRACTION);
  const plateSize = logoSize + LOGO_PADDING * 2;
  const plateOffset = Math.round((QR_SIZE - plateSize) / 2);
  const logoOffset = Math.round((QR_SIZE - logoSize) / 2);
  const icon = getIconDataUri();
  const overlay =
    `<rect x="${plateOffset}" y="${plateOffset}" width="${plateSize}" height="${plateSize}" rx="8" fill="#fff"/>` +
    `<image x="${logoOffset}" y="${logoOffset}" width="${logoSize}" height="${logoSize}" ` +
    `preserveAspectRatio="xMidYMid meet" href="${icon}" xlink:href="${icon}"/>`;

  // Use viewBox so the graphic is scalable and CSS can control the rendered size
  const openTag =
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" ` +
    `viewBox="0 0 ${QR_SIZE} ${QR_SIZE}">`;
  svg = svg.replace(/<svg\b[^>]*>/, openTag).replace('</svg>', `${overlay}</svg>`);

  return `data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`;
}
