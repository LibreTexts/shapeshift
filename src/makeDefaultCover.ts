// Debug CLI for the generated (non-custom-template) Prince covers. Fetches a book's
// root page from CXOne and renders its default covers at a page count you
// choose, so spine width and wrap sizing can be checked without running a
// full export.
//
// Usage:
//   tsx src/makeDefaultCover.ts <bookURL> <numPages> [outDir] [--types CaseWrap,PerfectBound,...]
//   npm run make-default-cover -- <bookURL> <numPages> [outDir] [--types ...]
//
// <numPages> is the print interior page count (what a job passes as
// printContentPageCount). --types defaults to every cover type. Output files
// are named <CoverType>.pdf, matching the job's covers directory.
//
// Library credentials come from SSM exactly as they do for the processor, so
// the same .env that runs a local job runs this.

import 'dotenv/config';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Prince from 'prince';

// Stub required env vars so the shared `log` module doesn't bail out on env
// validation when running outside a worker bootstrap. Anything set in .env wins.
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

import type { GetPagesResponse } from '@libretexts/cxone-expert-node';
import type { PDFCoverType } from './types/pdf';

const { BookService } = await import('./services/book');
const { COVER_TYPE_CONFIG } = await import('./services/pdf');
const { PDF_COVER_TYPES, generatePDFCoverHTML, getCoverDimensions } = await import('./util/pdfHelpers');

const __dirname = dirname(fileURLToPath(import.meta.url));
const princePdfCssPath = join(__dirname, 'styles/prince-pdf.css');

const USAGE = 'Usage: tsx src/makeDefaultCover.ts <bookURL> <numPages> [outDir] [--types CaseWrap,PerfectBound,...]';

const positional: string[] = [];
let typesArg: string | undefined;
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--types') typesArg = argv[++i];
  else if (argv[i].startsWith('--types=')) typesArg = argv[i].slice('--types='.length);
  else positional.push(argv[i]);
}

const [bookURL, numPagesArg, outDirArg = 'out'] = positional;
if (!bookURL || !numPagesArg) {
  console.error(USAGE);
  process.exit(2);
}

const numPages = parseInt(numPagesArg, 10);
if (!Number.isFinite(numPages) || numPages <= 0) {
  console.error(`Invalid numPages: ${numPagesArg}`);
  process.exit(2);
}

const coverTypes = (typesArg ? typesArg.split(',').map((t) => t.trim()) : [...PDF_COVER_TYPES]) as PDFCoverType[];
const unknown = coverTypes.filter((t) => !(PDF_COVER_TYPES as readonly string[]).includes(t));
if (unknown.length) {
  console.error(`Unknown cover type(s): ${unknown.join(', ')}. Valid: ${PDF_COVER_TYPES.join(', ')}`);
  process.exit(2);
}

const bookService = new BookService();
const bookID = await bookService.getIDFromURL(bookURL);
if (!bookID) {
  console.error(`Could not resolve a page ID for ${bookURL}`);
  process.exit(1);
}

// Covers only read root-page fields (title, printInfo, tags, summary,
// subdomain), so skip the tree walk and fetch the root alone.
const bookInfo = await bookService.getPageInfo(bookID.lib, { '@id': String(bookID.pageNum) } as GetPagesResponse);
console.log(`Book ${bookID.toString()}: ${bookInfo.printInfo.title || bookInfo.title}`);

const outDir = resolve(outDirArg);
await mkdir(outDir, { recursive: true });
const workDir = await mkdtemp(join(tmpdir(), 'shapeshift-cover-'));

try {
  for (const coverType of coverTypes) {
    const { opt, usesPageCount } = COVER_TYPE_CONFIG[coverType];
    const pages = usesPageCount ? numPages : null;
    const html = generatePDFCoverHTML({ bookInfo, coverType, opt, numPages: pages });
    const inputPath = join(workDir, `${coverType}.html`);
    const outputPath = join(outDir, `${coverType}.pdf`);
    await writeFile(inputPath, html);

    await new Prince({ binary: process.env.PRINCE_BINARY_PATH || undefined })
      .timeout(60_000)
      .option('pdf-title', bookInfo.printInfo.title || bookInfo.title || 'Unknown')
      .option('style', princePdfCssPath)
      .option('tagged-pdf', true)
      .inputs(inputPath)
      .output(outputPath)
      .execute();

    const d = getCoverDimensions(coverType, pages);
    console.log(
      `Wrote ${outputPath}  ${d.totalWidth.toFixed(3)}in x ${d.height.toFixed(3)}in, spine ${d.spineWidth.toFixed(3)}in`,
    );
  }
} finally {
  await rm(workDir, { recursive: true, force: true });
}
