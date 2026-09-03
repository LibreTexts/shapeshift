// Dev utility: generate a placeholder PDF with an exact number of pages.
// Useful for exercising page-count-dependent code (spine width, cover
// assembly, chunked page extraction) without waiting on a real book export.
//
// Usage:
//   tsx src/makeTestPDF.ts <numPages> [outPath] [--size 6x9|letter|a4|WxH] [--seed N] [--blank] [--font NAME|path.ttf]
//   npm run make-test-pdf -- 250 out/test-250.pdf --size 6x9
//
// Sizes are in inches. "WxH" accepts decimals, e.g. --size 8.5x11.
// --blank skips text entirely (fastest, smallest file).
// --seed makes the lorem shuffle reproducible; the same seed always yields
// byte-identical text.
//
// Fonts are embedded in full, with subsetting off, to match Lulu's print
// requirement (the same rule custom cover templates must satisfy, enforced in
// util/coverTemplateFiller.ts). That rules out the PDF base-14 faces
// (Helvetica, Times, Courier): the spec has viewers supply those locally, so a
// base-14 document carries no font program and fails preflight. Bundled TTFs
// are used instead. TrueType only, since pdf-lib mishandles CFF (.otf)
// outlines.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import fontkit from '@pdf-lib/fontkit';
import { PDFDocument, rgb } from 'pdf-lib';

const __dirname = dirname(fileURLToPath(import.meta.url));

const PT_PER_IN = 72;

/** Mirrors BUNDLED_SPINE_FONTS in services/coverTemplate.ts. */
const BUNDLED_FONTS: Record<string, { regular: string; bold: string }> = {
  'liberation-sans': { regular: 'liberation-sans-400.ttf', bold: 'liberation-sans-700.ttf' },
  'atkinson-hyperlegible': {
    regular: 'atkinson-hyperlegible-400.ttf',
    bold: 'atkinson-hyperlegible-700.ttf',
  },
};

const DEFAULT_FONT = 'liberation-sans';

const NAMED_SIZES: Record<string, [number, number]> = {
  '6x9': [6, 9],
  letter: [8.5, 11],
  legal: [8.5, 14],
  a4: [8.27, 11.69],
  a5: [5.83, 8.27],
};

const LOREM = [
  'Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.',
  'Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat.',
  'Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur.',
  'Excepteur sint occaecat cupidatat non proident, sunt in culpa qui officia deserunt mollit anim id est laborum.',
  'Sed ut perspiciatis unde omnis iste natus error sit voluptatem accusantium doloremque laudantium.',
  'Totam rem aperiam, eaque ipsa quae ab illo inventore veritatis et quasi architecto beatae vitae dicta sunt explicabo.',
  'Nemo enim ipsam voluptatem quia voluptas sit aspernatur aut odit aut fugit, sed quia consequuntur magni dolores.',
  'Neque porro quisquam est, qui dolorem ipsum quia dolor sit amet, consectetur, adipisci velit.',
  'At vero eos et accusamus et iusto odio dignissimos ducimus qui blanditiis praesentium voluptatum deleniti atque corrupti.',
  'Nam libero tempore, cum soluta nobis est eligendi optio cumque nihil impedit quo minus id quod maxime placeat.',
];

/** Mulberry32 — small deterministic PRNG so --seed reproduces the same document. */
function makeRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Resolves a bundled face name or a .ttf path to a file path. Bold falls back
 * to the given path when a raw path is supplied, since one file is one weight.
 */
function resolveFontPath(nameOrPath: string, variant: 'regular' | 'bold'): string {
  const bundled = BUNDLED_FONTS[nameOrPath];
  if (bundled) return join(__dirname, 'styles/fonts', bundled[variant]);
  if (/\.(otf|pfb|pfa|t1)$/i.test(nameOrPath)) {
    throw new Error(
      `Font "${nameOrPath}" is not TrueType. pdf-lib corrupts CFF/Type 1 outlines on embed. ` +
        `Use a .ttf, or one of: ${Object.keys(BUNDLED_FONTS).join(', ')}.`,
    );
  }
  return nameOrPath;
}

function parseSize(value: string): [number, number] {
  const named = NAMED_SIZES[value.toLowerCase()];
  if (named) return named;
  const match = /^(\d+(?:\.\d+)?)x(\d+(?:\.\d+)?)$/i.exec(value);
  if (!match) {
    throw new Error(
      `Unrecognized --size "${value}". Use one of ${Object.keys(NAMED_SIZES).join(', ')} or WxH in inches (e.g. 8.5x11).`,
    );
  }
  return [Number(match[1]), Number(match[2])];
}

function flagValue(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  if (i !== -1) return argv[i + 1];
  const inline = argv.find((a) => a.startsWith(`--${name}=`));
  return inline?.slice(name.length + 3);
}

/** Greedy wrap against real glyph widths so lines never overflow the text column. */
function wrapText(text: string, maxWidth: number, fontSize: number, measure: (s: string) => number): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/)) {
    const candidate = line ? `${line} ${word}` : word;
    if (line && measure(candidate) > maxWidth) {
      lines.push(line);
      line = word;
    } else {
      line = candidate;
    }
  }
  if (line) lines.push(line);
  return lines;
}

async function main() {
  const argv = process.argv.slice(2);
  const positional = argv.filter((a, i) => !a.startsWith('--') && !argv[i - 1]?.match(/^--(size|seed|font)$/));

  const numPages = Number(positional[0]);
  if (!Number.isInteger(numPages) || numPages < 1) {
    console.error('Usage: tsx src/makeTestPDF.ts <numPages> [outPath] [--size 6x9|letter|a4|WxH] [--seed N] [--blank]');
    process.exit(1);
  }

  const outPath = resolve(positional[1] ?? `out/test-${numPages}p.pdf`);
  const [widthIn, heightIn] = parseSize(flagValue(argv, 'size') ?? '6x9');
  const seed = Number(flagValue(argv, 'seed') ?? 1);
  const blank = argv.includes('--blank');
  const fontName = flagValue(argv, 'font') ?? DEFAULT_FONT;

  const pageWidth = widthIn * PT_PER_IN;
  const pageHeight = heightIn * PT_PER_IN;
  const margin = 0.75 * PT_PER_IN;
  const bodySize = 11;
  const leading = bodySize * 1.45;
  const columnWidth = pageWidth - margin * 2;

  const doc = await PDFDocument.create();
  doc.setTitle(`Test document (${numPages} pages)`);
  doc.setProducer('shapeshift makeTestPDF');

  doc.registerFontkit(fontkit);
  // subset: false embeds the complete font program (pdf-lib's default, stated
  // here because the whole point of this script's output is passing preflight).
  const body = await doc.embedFont(await readFile(resolveFontPath(fontName, 'regular')), {
    subset: false,
  });
  const heading = await doc.embedFont(await readFile(resolveFontPath(fontName, 'bold')), {
    subset: false,
  });
  const random = makeRandom(seed);

  for (let pageNum = 1; pageNum <= numPages; pageNum++) {
    const page = doc.addPage([pageWidth, pageHeight]);
    if (blank) continue;

    let y = pageHeight - margin;

    const title = `Section ${pageNum}`;
    page.drawText(title, { x: margin, y: y - 16, size: 16, font: heading });
    y -= 16 + leading;

    while (y > margin + leading * 2) {
      const paragraph = LOREM[Math.floor(random() * LOREM.length)];
      const lines = wrapText(paragraph, columnWidth, bodySize, (s) => body.widthOfTextAtSize(s, bodySize));
      for (const line of lines) {
        if (y <= margin + leading * 2) break;
        page.drawText(line, { x: margin, y: y - bodySize, size: bodySize, font: body });
        y -= leading;
      }
      y -= leading * 0.5; // paragraph gap
    }

    const label = String(pageNum);
    page.drawText(label, {
      x: (pageWidth - body.widthOfTextAtSize(label, 9)) / 2,
      y: margin / 2,
      size: 9,
      font: body,
      color: rgb(0.4, 0.4, 0.4),
    });
  }

  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, await doc.save());

  console.log(`Wrote ${outPath}: ${numPages} page(s) at ${widthIn}x${heightIn}in${blank ? ' (blank)' : ''}`);
}

await main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
