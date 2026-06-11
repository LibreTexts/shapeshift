// Debug CLI for the final wrap-cover assembler. Fills front + back templates
// from a minimal book-info JSON, assembles the wrap (back | spine | front),
// and writes both CaseWrap and PerfectBound outputs.
//
// Usage:
//   tsx src/buildFinalCover.ts <front.pdf> <back.pdf> <bookInfo.json> <numPages> <spineHex> <outDir>
//   npm run build-final-cover -- <front.pdf> <back.pdf> <bookInfo.json> <numPages> <spineHex> <outDir>
//
// bookInfo.json mirrors src/fillCoverTemplate.ts's values file. It may include:
//   - TITLE, AUTHOR, COURSE, LIBRARY, SUBJECT, LICENSE, BOOK_ID  (form fields)
//   - fonts: { FIELD: "PSName", ... }                            (per-field font overrides)
// TITLE and AUTHOR are also reused as the spine text.

import fs from 'node:fs';
import path from 'node:path';

// Stub required env vars so the shared `log` module (pulled in transitively by
// CoverTemplateService) doesn't bail out on env validation when running the
// CLI outside a worker bootstrap. Real workers populate these from .env / SSM.
for (const k of [
  'NODE_ENV',
  'AWS_REGION',
  'BUCKET',
  'CLOUDWATCH_BPI_METRIC_NAME',
  'CLOUDWATCH_BPI_METRIC_NAME_HP',
  'CLOUDWATCH_BPI_METRIC_NAMESPACE',
  'CLOUDFRONT_DISTRIBUTION_DOMAIN',
  'CLOUDFRONT_KEY_PAIR_ID',
  'CLOUDFRONT_PRIVATE_KEY',
  'ECS_CLUSTER_NAME',
  'ECS_SERVICE_NAME',
  'ECS_SERVICE_NAME_HP',
  'SQS_HIGH_PRIORITY_QUEUE_URL',
  'SQS_QUEUE_URL',
]) {
  if (!process.env[k]) process.env[k] = k === 'NODE_ENV' ? 'development' : 'cli-stub';
}

import type { BookPageInfo } from './types/book';
import type { FieldOverride } from './types/pdf';

const { CoverTemplateService } = await import('./services/coverTemplate');

const [frontPath, backPath, valuesPath, numPagesArg, spineHex, outDir] = process.argv.slice(2);
if (!frontPath || !backPath || !valuesPath || !numPagesArg || !spineHex || !outDir) {
  console.error(
    'Usage: tsx src/buildFinalCover.ts <front.pdf> <back.pdf> <bookInfo.json> <numPages> <spineHex> <outDir>',
  );
  process.exit(2);
}

const numPages = parseInt(numPagesArg, 10);
if (!Number.isFinite(numPages) || numPages <= 0) {
  console.error(`Invalid numPages: ${numPagesArg}`);
  process.exit(2);
}

function assertPdf(p: string, role: string) {
  const head = fs.readFileSync(p).slice(0, 5).toString('utf8');
  if (!head.startsWith('%PDF')) {
    console.error(`Expected a PDF for <${role}> but ${p} does not start with %PDF.`);
    console.error('Argument order is: <front.pdf> <back.pdf> <bookInfo.json> <numPages> <spineHex> <outDir>');
    process.exit(2);
  }
}
function assertJson(p: string, role: string): string {
  const head = fs.readFileSync(p).slice(0, 5).toString('utf8');
  if (head.startsWith('%PDF')) {
    console.error(`Expected a JSON file for <${role}> but ${p} appears to be a PDF.`);
    console.error('Argument order is: <front.pdf> <back.pdf> <bookInfo.json> <numPages> <spineHex> <outDir>');
    process.exit(2);
  }
  return fs.readFileSync(p, 'utf8');
}

assertPdf(frontPath, 'front.pdf');
assertPdf(backPath, 'back.pdf');
const valuesJson = assertJson(valuesPath, 'bookInfo.json');

const frontBytes = fs.readFileSync(frontPath);
const backBytes = fs.readFileSync(backPath);
const valuesFile = JSON.parse(valuesJson) as Record<string, unknown> & {
  fonts?: Record<string, string>;
  spineSize?: number;
  spineTitleSize?: number;
  spineAuthorSize?: number;
};

const { fonts: fontsMap, spineSize, spineTitleSize, spineAuthorSize, ...extraValues } = valuesFile;
const overrides: Record<string, FieldOverride> = {};
let spineFontName: string | undefined;
let spineTitleFontName: string | undefined;
let spineAuthorFontName: string | undefined;
const SPINE_KEYS = new Set(['SPINE', 'SPINE_TITLE', 'SPINE_AUTHOR']);
if (fontsMap && typeof fontsMap === 'object') {
  for (const [field, fontName] of Object.entries(fontsMap)) {
    if (typeof fontName !== 'string' || !fontName.trim()) continue;
    const upper = field.toUpperCase();
    if (SPINE_KEYS.has(upper)) {
      if (upper === 'SPINE') spineFontName = fontName;
      else if (upper === 'SPINE_TITLE') spineTitleFontName = fontName;
      else if (upper === 'SPINE_AUTHOR') spineAuthorFontName = fontName;
      continue;
    }
    overrides[field] = { font: fontName };
  }
}

// Synthesize a minimal BookPageInfo so fillFromBookInfo + spine text resolve
// title/author. The values map (extraValues) takes precedence over derived
// values when filling form fields.
const title = String(extraValues.TITLE ?? '');
const author = String(extraValues.AUTHOR ?? '');
const bookInfo = {
  title,
  printInfo: { title, authorName: author },
} as unknown as BookPageInfo;

const service = new CoverTemplateService({ debug: process.env.FILL_FORM_DEBUG !== '0' });

const { casewrap, perfectBound } = await service.buildFinalCoversBothBindings({
  frontTemplateBytes: frontBytes,
  backTemplateBytes: backBytes,
  bookInfo,
  numPages,
  spineHex,
  extraValues,
  overrides,
  spineText:
    spineFontName ||
    spineTitleFontName ||
    spineAuthorFontName ||
    typeof spineSize === 'number' ||
    typeof spineTitleSize === 'number' ||
    typeof spineAuthorSize === 'number'
      ? {
          spineFontName,
          titleFontName: spineTitleFontName,
          authorFontName: spineAuthorFontName,
          size: typeof spineSize === 'number' ? spineSize : undefined,
          titleSize: typeof spineTitleSize === 'number' ? spineTitleSize : undefined,
          authorSize: typeof spineAuthorSize === 'number' ? spineAuthorSize : undefined,
        }
      : undefined,
});

fs.mkdirSync(outDir, { recursive: true });
const casewrapPath = path.join(outDir, 'cover-casewrap.pdf');
const perfectBoundPath = path.join(outDir, 'cover-perfectbound.pdf');
fs.writeFileSync(casewrapPath, casewrap);
fs.writeFileSync(perfectBoundPath, perfectBound);
console.log(`Wrote ${casewrapPath} (${casewrap.byteLength} bytes)`);
console.log(`Wrote ${perfectBoundPath} (${perfectBound.byteLength} bytes)`);
