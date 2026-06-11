// Fill a LibreTexts custom cover-template PDF that conforms to
// docs/COVER_TEMPLATE_GUIDELINES.md. Reads each form field's appearance
// defaults (font, size, color, alignment, multi-line flag) from the template,
// lays text out inside the widget rectangle with 2 pt padding, builds a
// custom /AP /N appearance stream per field, and flattens the form.
//
// Usage (programmatic):
//   import { fillCoverTemplate } from '../util/coverTemplateFiller';
//   const bytes = await fillCoverTemplate({ templateBytes, values, overrides });
//
// CLI usage lives in src/fillCoverTemplate.ts.

import {
  PDFDocument,
  PDFName,
  PDFDict,
  PDFRef,
  PDFArray,
  PDFNumber,
  PDFString,
  PDFHexString,
  PDFRawStream,
  PDFAcroText,
  PDFField,
  PDFWidgetAnnotation,
  PDFObject,
} from 'pdf-lib';
import zlib from 'node:zlib';
import { CanonicalFieldName, CoverTemplateDebug, FieldOverride, FillCoverTemplateOptions, RGB } from '../types/pdf';

// ---------- module-private types ----------

interface ParsedDA {
  fontName: string | null;
  size: number | null;
  color: RGB;
}

export interface ReverseMapEntry {
  hex: string;
  code: number;
}

export type ReverseMap = Map<string, ReverseMapEntry>;
export type WidthLookup = (code: number) => number;

interface FontBundle {
  reverseMap: ReverseMap;
  widthLookup: WidthLookup;
  ascentRatio: number;
  baseFont: string;
  shortName: string;
  fontRef: PDFRef;
}

interface LineLayout {
  text: string;
  hex: string;
  widthPt: number;
}

export interface EncodedText {
  hex: string;
  widthUnits: number;
  perCharAdvance: number[];
}

// ---------- spec constants ----------

// Per COVER_TEMPLATE_GUIDELINES.md §"Supported Dynamic Content":
// only TITLE and AUTHOR must be present in the template itself. LIBRARY/
// BOOK_ID are "always present in book metadata" — that's about data
// availability at fill time, not about what the template must contain.
const REQUIRED_FIELDS: CanonicalFieldName[] = ['TITLE', 'AUTHOR'];
const OPTIONAL_FIELDS: CanonicalFieldName[] = ['COURSE', 'LIBRARY', 'SUBJECT', 'LICENSE', 'BOOK_ID'];
const ALL_FIELDS: CanonicalFieldName[] = [...REQUIRED_FIELDS, ...OPTIONAL_FIELDS];

// Canonicalize a field name to its uppercase spec form if it matches one of
// the supported names case-insensitively. Returns null for unknown names.
function canonicalFieldName(name: string | null | undefined): CanonicalFieldName | null {
  if (!name) return null;
  const upper = String(name).trim().toUpperCase();
  return (ALL_FIELDS as string[]).includes(upper) ? (upper as CanonicalFieldName) : null;
}

// Look up a key in an object case-insensitively. Used so callers can pass
// `values` and `overrides` keyed in any case (TITLE / title / Title).
function getCaseInsensitive<T = unknown>(obj: Record<string, T> | null | undefined, key: string): T | undefined {
  if (!obj) return undefined;
  if (Object.prototype.hasOwnProperty.call(obj, key)) return obj[key];
  const target = String(key).toLowerCase();
  for (const k of Object.keys(obj)) {
    if (k.toLowerCase() === target) return obj[k];
  }
  return undefined;
}

const MAX_CHARS: Record<CanonicalFieldName, number> = {
  TITLE: 120,
  AUTHOR: 120,
  SUBJECT: 75,
  COURSE: 75,
  LIBRARY: 50,
  LICENSE: 50,
  BOOK_ID: 50,
};

// Per-field max lines for multi-line fields (spec §"Multi-line vs single-line").
// Single-line-only fields are forced to 1 regardless of the /Ff multi-line bit.
const MAX_LINES: Record<CanonicalFieldName, number> = {
  TITLE: 3,
  AUTHOR: 2,
  SUBJECT: Infinity,
  COURSE: Infinity,
  LIBRARY: 1,
  LICENSE: 1,
  BOOK_ID: 1,
};

const PADDING_PT = 2;
const LINE_GAP = 1.2;
const DEFAULT_ASCENT_RATIO = 0.8;

// ---------- debug logging ----------

type Dbg = (...args: unknown[]) => void;

function makeDebugger(debug: CoverTemplateDebug | undefined): Dbg {
  if (!debug) return () => {};
  if (typeof debug === 'function') return debug;
  return (...args: unknown[]) => console.log('[fill-form]', ...args);
}

// Inspect a font dict and produce a structured summary for logging. Reports
// the properties Shapeshift relies on to encode and measure text: subtype,
// BaseFont (with subset prefix detection), encoding, presence of ToUnicode,
// width-table shape, ascent, and the FontDescriptor /Flags symbolic bit.
function describeFont(pdfDoc: PDFDocument, fontObj: PDFDict): Record<string, unknown> {
  const subtype = fontObj.lookup(PDFName.of('Subtype'));
  const baseFont = fontObj.lookup(PDFName.of('BaseFont'));
  const baseFontStr = baseFont ? baseFont.toString().replace(/^\//, '') : null;
  // Subset prefix per PDF 1.7 §9.6.4: 6 uppercase letters + '+'.
  const subsetMatch = baseFontStr ? baseFontStr.match(/^([A-Z]{6})\+(.+)$/) : null;

  const encoding = fontObj.lookup(PDFName.of('Encoding'));
  let encodingDesc: string;
  if (encoding instanceof PDFName) {
    encodingDesc = encoding.toString();
  } else if (encoding instanceof PDFDict) {
    const base = encoding.lookup(PDFName.of('BaseEncoding'));
    const diffs = encoding.lookup(PDFName.of('Differences'));
    encodingDesc = `dict(base=${base ? base.toString() : 'none'}, differences=${diffs instanceof PDFArray ? diffs.asArray().length + ' entries' : 'none'})`;
  } else {
    encodingDesc = '(implicit)';
  }

  const toUnicode = fontObj.lookup(PDFName.of('ToUnicode'));
  const hasToUnicode = toUnicode instanceof PDFRawStream;

  let widths: string;
  const widthsArr = fontObj.lookup(PDFName.of('Widths'));
  const firstChar = fontObj.lookup(PDFName.of('FirstChar'));
  const lastChar = fontObj.lookup(PDFName.of('LastChar'));
  if (widthsArr instanceof PDFArray && firstChar instanceof PDFNumber) {
    widths = `simple(/Widths[${widthsArr.asArray().length}], FirstChar=${firstChar.asNumber()}, LastChar=${lastChar instanceof PDFNumber ? lastChar.asNumber() : '?'})`;
  } else {
    const descendants = fontObj.lookup(PDFName.of('DescendantFonts'));
    if (descendants instanceof PDFArray) {
      const cid = pdfDoc.context.lookup(descendants.get(0));
      if (cid instanceof PDFDict) {
        const dw = cid.lookup(PDFName.of('DW'));
        const w = cid.lookup(PDFName.of('W'));
        widths = `Type0(DW=${dw instanceof PDFNumber ? dw.asNumber() : 'default 1000'}, W=${w instanceof PDFArray ? w.asArray().length + ' entries' : 'none'})`;
      } else {
        widths = 'Type0(no CIDFont)';
      }
    } else {
      widths = 'none (using 500-unit fallback)';
    }
  }

  // FontDescriptor: ascent + /Flags symbolic bit (3 = symbolic).
  let descriptor = fontObj.lookup(PDFName.of('FontDescriptor'));
  if (!(descriptor instanceof PDFDict)) {
    const dfs = fontObj.lookup(PDFName.of('DescendantFonts'));
    if (dfs instanceof PDFArray) {
      const cid = pdfDoc.context.lookup(dfs.get(0));
      if (cid instanceof PDFDict) {
        const d = cid.lookup(PDFName.of('FontDescriptor'));
        if (d instanceof PDFDict) descriptor = d;
      }
    }
  }
  let ascent: number | null = null;
  let flags: number | null = null;
  if (descriptor instanceof PDFDict) {
    const a = descriptor.lookup(PDFName.of('Ascent'));
    if (a instanceof PDFNumber) ascent = a.asNumber();
    const f = descriptor.lookup(PDFName.of('Flags'));
    if (f instanceof PDFNumber) flags = f.asNumber();
  }

  return {
    subtype: subtype ? subtype.toString().replace(/^\//, '') : null,
    baseFont: baseFontStr,
    subset: subsetMatch ? { prefix: subsetMatch[1], family: subsetMatch[2] } : null,
    encoding: encodingDesc,
    hasToUnicode,
    widths,
    ascent,
    flags,
    symbolic: flags != null ? (flags & 0x4) !== 0 : null,
  };
}

// ---------- font discovery & registration ----------

export function collectFormFontResources(pdfDoc: PDFDocument): Map<string, PDFObject> {
  const acroForm = pdfDoc.catalog.lookup(PDFName.of('AcroForm'));
  if (!(acroForm instanceof PDFDict)) return new Map();
  const dr = acroForm.lookup(PDFName.of('DR'));
  if (!(dr instanceof PDFDict)) return new Map();
  const fonts = dr.lookup(PDFName.of('Font'));
  if (!(fonts instanceof PDFDict)) return new Map();
  const out = new Map<string, PDFObject>();
  for (const [key, val] of fonts.entries()) {
    const name = key.toString().replace(/^\//, '');
    out.set(name, val);
  }
  return out;
}

export function collectPageFontResources(pdfDoc: PDFDocument): Map<string, PDFObject> {
  const out = new Map<string, PDFObject>();
  for (const page of pdfDoc.getPages()) {
    const resources = page.node.Resources();
    if (!resources) continue;
    const fontDict = resources.lookup(PDFName.of('Font'));
    if (!(fontDict instanceof PDFDict)) continue;
    for (const [key, val] of fontDict.entries()) {
      const name = key.toString().replace(/^\//, '');
      if (!out.has(name)) out.set(name, val);
    }
  }
  return out;
}

export function resolveFontRef(maybeRef: PDFObject | undefined, pdfDoc: PDFDocument): PDFRef | null {
  // Page font dicts may store either a PDFRef or an inline PDFDict.
  if (maybeRef instanceof PDFRef) return maybeRef;
  if (maybeRef instanceof PDFDict) return pdfDoc.context.register(maybeRef);
  return null;
}

function registerFontInForm(pdfDoc: PDFDocument, shortName: string, fontRef: PDFRef): string {
  let acroForm = pdfDoc.catalog.lookup(PDFName.of('AcroForm'));
  if (!(acroForm instanceof PDFDict)) {
    acroForm = pdfDoc.context.obj({}) as PDFDict;
    pdfDoc.catalog.set(PDFName.of('AcroForm'), acroForm);
  }
  const acroFormDict = acroForm as PDFDict;
  let dr = acroFormDict.lookup(PDFName.of('DR'));
  if (!(dr instanceof PDFDict)) {
    dr = pdfDoc.context.obj({}) as PDFDict;
    acroFormDict.set(PDFName.of('DR'), dr);
  }
  const drDict = dr as PDFDict;
  let drFonts = drDict.lookup(PDFName.of('Font'));
  if (!(drFonts instanceof PDFDict)) {
    drFonts = pdfDoc.context.obj({}) as PDFDict;
    drDict.set(PDFName.of('Font'), drFonts);
  }
  (drFonts as PDFDict).set(PDFName.of(shortName), fontRef);
  return shortName;
}

// ---------- /DA parsing ----------

// /DA is a content-stream snippet. Typical: "/HelvB 12 Tf 0 0 0 rg"
function parseDA(daString: string | null | undefined): ParsedDA {
  const out: ParsedDA = { fontName: null, size: null, color: [0, 0, 0] };
  if (!daString) return out;

  const tf = daString.match(/\/([^\s]+)\s+([\d.]+)\s+Tf/);
  if (tf) {
    out.fontName = tf[1];
    out.size = parseFloat(tf[2]);
  }

  // Find the LAST color operator (rg / RG / g / G / k / K).
  const colorOps = [
    ...daString.matchAll(
      /(?:([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([kK])|([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+(rg|RG)|([\d.]+)\s+([gG]))/g,
    ),
  ];
  if (colorOps.length) {
    const m = colorOps[colorOps.length - 1];
    if (m[5]) {
      // CMYK
      const [c, mg, y, k] = [m[1], m[2], m[3], m[4]].map(parseFloat);
      out.color = cmykToRgb(c, mg, y, k);
    } else if (m[9]) {
      const [r, g, b] = [m[6], m[7], m[8]].map(parseFloat);
      out.color = [r, g, b];
    } else if (m[11]) {
      const v = parseFloat(m[10]);
      out.color = [v, v, v];
    }
  }
  return out;
}

function cmykToRgb(c: number, m: number, y: number, k: number): RGB {
  const r = (1 - c) * (1 - k);
  const g = (1 - m) * (1 - k);
  const b = (1 - y) * (1 - k);
  return [r, g, b];
}

// ---------- standard PDF encodings ----------
//
// Used when a simple TrueType/Type1 font has no ToUnicode CMap. The encoding
// table maps a 1-byte character code (0x00-0xFF) to a Unicode code point.

// WinAnsiEncoding: matches Windows-1252 in the 0x80-0x9F range, otherwise
// identical to ISO-8859-1 for 0xA0-0xFF and ASCII for 0x20-0x7E.
const WIN_ANSI_EXTRAS: Record<number, number> = {
  0x80: 0x20ac,
  0x82: 0x201a,
  0x83: 0x0192,
  0x84: 0x201e,
  0x85: 0x2026,
  0x86: 0x2020,
  0x87: 0x2021,
  0x88: 0x02c6,
  0x89: 0x2030,
  0x8a: 0x0160,
  0x8b: 0x2039,
  0x8c: 0x0152,
  0x8e: 0x017d,
  0x91: 0x2018,
  0x92: 0x2019,
  0x93: 0x201c,
  0x94: 0x201d,
  0x95: 0x2022,
  0x96: 0x2013,
  0x97: 0x2014,
  0x98: 0x02dc,
  0x99: 0x2122,
  0x9a: 0x0161,
  0x9b: 0x203a,
  0x9c: 0x0153,
  0x9e: 0x017e,
  0x9f: 0x0178,
};

function buildEncodingTable(encodingName: string | null | undefined): Map<number, number> {
  const table = new Map<number, number>();
  // ASCII range is identical across WinAnsi/MacRoman/Standard.
  for (let c = 0x20; c <= 0x7e; c++) table.set(c, c);
  if (encodingName === 'WinAnsiEncoding' || !encodingName) {
    for (let c = 0xa0; c <= 0xff; c++) table.set(c, c); // Latin-1 supplement
    for (const [c, u] of Object.entries(WIN_ANSI_EXTRAS)) table.set(+c, u);
  } else if (encodingName === 'MacRomanEncoding' || encodingName === 'StandardEncoding') {
    // Best-effort: cover the Latin-1 supplement with identity. For full
    // fidelity a complete MacRoman table would be needed, but most templates
    // ship WinAnsi.
    for (let c = 0xa0; c <= 0xff; c++) table.set(c, c);
  }
  return table;
}

// Apply a /Differences array on top of a base encoding table. Each entry is
// either a number (the next code to assign) or a name (the glyph name to map
// at the current code). We translate glyph names to Unicode via a small
// lookup of common names; unknown names are skipped.
const GLYPH_NAME_TO_UNICODE: Record<string, number> = {
  space: 0x20,
  exclam: 0x21,
  quotedbl: 0x22,
  numbersign: 0x23,
  dollar: 0x24,
  percent: 0x25,
  ampersand: 0x26,
  quoteright: 0x2019,
  parenleft: 0x28,
  parenright: 0x29,
  asterisk: 0x2a,
  plus: 0x2b,
  comma: 0x2c,
  hyphen: 0x2d,
  period: 0x2e,
  slash: 0x2f,
  colon: 0x3a,
  semicolon: 0x3b,
  less: 0x3c,
  equal: 0x3d,
  greater: 0x3e,
  question: 0x3f,
  at: 0x40,
  bracketleft: 0x5b,
  backslash: 0x5c,
  bracketright: 0x5d,
  asciicircum: 0x5e,
  underscore: 0x5f,
  quoteleft: 0x2018,
  braceleft: 0x7b,
  bar: 0x7c,
  braceright: 0x7d,
  asciitilde: 0x7e,
  endash: 0x2013,
  emdash: 0x2014,
  quotedblleft: 0x201c,
  quotedblright: 0x201d,
  bullet: 0x2022,
  ellipsis: 0x2026,
  trademark: 0x2122,
  copyright: 0x00a9,
  registered: 0x00ae,
  sterling: 0x00a3,
  Euro: 0x20ac,
  fi: 0xfb01,
  fl: 0xfb02,
  AE: 0x00c6,
  ae: 0x00e6,
  OE: 0x0152,
  oe: 0x0153,
  Oslash: 0x00d8,
  oslash: 0x00f8,
  Lslash: 0x0141,
  lslash: 0x0142,
  germandbls: 0x00df,
};
for (let i = 0; i <= 9; i++) GLYPH_NAME_TO_UNICODE['' + i] = 0x30 + i;
for (let i = 0; i < 26; i++) {
  GLYPH_NAME_TO_UNICODE[String.fromCharCode(0x41 + i)] = 0x41 + i;
  GLYPH_NAME_TO_UNICODE[String.fromCharCode(0x61 + i)] = 0x61 + i;
}
// Accented letters: common patterns like "eacute" → é, "ntilde" → ñ, etc.
const ACCENT_SUFFIXES: Record<string, number> = {
  acute: 0x0301,
  grave: 0x0300,
  circumflex: 0x0302,
  tilde: 0x0303,
  dieresis: 0x0308,
  ring: 0x030a,
  cedilla: 0x0327,
  caron: 0x030c,
};
function glyphNameToUnicode(name: string): number | null {
  if (GLYPH_NAME_TO_UNICODE[name] != null) return GLYPH_NAME_TO_UNICODE[name];
  // letter + accent suffix: compose then NFC-normalize.
  for (const [suffix, combining] of Object.entries(ACCENT_SUFFIXES)) {
    if (name.endsWith(suffix) && name.length > suffix.length) {
      const base = name.slice(0, -suffix.length);
      if (base.length === 1 && /[A-Za-z]/.test(base)) {
        const composed = String.fromCodePoint(base.charCodeAt(0)) + String.fromCodePoint(combining);
        const nfc = composed.normalize('NFC');
        if (nfc.length === 1) return nfc.codePointAt(0) ?? null;
      }
    }
  }
  // uniXXXX or uXXXX hex form
  const m = name.match(/^uni([0-9A-F]{4})$/) || name.match(/^u([0-9A-F]{4,6})$/);
  if (m) return parseInt(m[1], 16);
  return null;
}

function applyDifferences(baseTable: Map<number, number>, differencesArr: PDFObject[]): Map<number, number> {
  let code = 0;
  for (const entry of differencesArr) {
    if (entry instanceof PDFNumber) {
      code = entry.asNumber();
    } else {
      const name = entry.toString().replace(/^\//, '');
      const u = glyphNameToUnicode(name);
      if (u != null) baseTable.set(code, u);
      code++;
    }
  }
  return baseTable;
}

function buildEncodingReverseMap(pdfDoc: PDFDocument, fontObj: PDFDict): ReverseMap {
  const encoding = fontObj.lookup(PDFName.of('Encoding'));
  let encodingName = 'WinAnsiEncoding'; // PDF spec default for non-symbolic TrueType
  let differences: PDFObject[] | null = null;
  if (encoding instanceof PDFName) {
    encodingName = encoding.toString().replace(/^\//, '');
  } else if (encoding instanceof PDFDict) {
    const base = encoding.lookup(PDFName.of('BaseEncoding'));
    if (base) encodingName = base.toString().replace(/^\//, '');
    const diffs = encoding.lookup(PDFName.of('Differences'));
    if (diffs instanceof PDFArray) differences = diffs.asArray();
  }

  const table = buildEncodingTable(encodingName);
  if (differences) applyDifferences(table, differences);

  const reverse: ReverseMap = new Map();
  for (const [code, unicode] of table.entries()) {
    const char = String.fromCodePoint(unicode);
    const hex = code.toString(16).padStart(2, '0');
    if (!reverse.has(char)) reverse.set(char, { hex, code });
  }
  return reverse;
}

// ---------- ToUnicode + widths ----------

function inflateStream(stream: PDFRawStream): Uint8Array {
  const filter = stream.dict.lookup(PDFName.of('Filter'));
  const bytes = stream.contents;
  if (filter && filter.toString().replace(/^\//, '') === 'FlateDecode') {
    return zlib.inflateSync(bytes);
  }
  return bytes;
}

export function buildToUnicodeReverseMap(pdfDoc: PDFDocument, fontRef: PDFRef): ReverseMap {
  const fontObj = pdfDoc.context.lookup(fontRef);
  if (!(fontObj instanceof PDFDict)) return new Map();
  const toUnicode = fontObj.lookup(PDFName.of('ToUnicode'));
  if (!(toUnicode instanceof PDFRawStream)) {
    // Simple fonts (TrueType/Type1) with no ToUnicode rely on /Encoding to
    // map 1-byte character codes to glyphs. Build a reverse map from that.
    return buildEncodingReverseMap(pdfDoc, fontObj);
  }

  const cmap = new TextDecoder('latin1').decode(inflateStream(toUnicode));
  const map: ReverseMap = new Map();

  for (const section of cmap.match(/beginbfchar([\s\S]*?)endbfchar/g) ?? []) {
    for (const [, code, uni] of section.matchAll(/<([0-9A-Fa-f]+)>\s+<([0-9A-Fa-f]+)>/g)) {
      const char = decodeUnicodeHex(uni);
      const codeHex = code.toLowerCase().padStart(code.length + (code.length % 2), '0');
      if (!map.has(char)) map.set(char, { hex: codeHex, code: parseInt(code, 16) });
    }
  }

  for (const section of cmap.match(/beginbfrange([\s\S]*?)endbfrange/g) ?? []) {
    for (const [, start, end, startUni] of section.matchAll(
      /<([0-9A-Fa-f]+)>\s+<([0-9A-Fa-f]+)>\s+<([0-9A-Fa-f]+)>/g,
    )) {
      const startCode = parseInt(start, 16);
      const endCode = parseInt(end, 16);
      const startUnicode = parseInt(startUni, 16);
      const codeLen = start.length + (start.length % 2);
      for (let i = 0; i <= endCode - startCode; i++) {
        const char = String.fromCodePoint(startUnicode + i);
        const codeHex = (startCode + i).toString(16).padStart(codeLen, '0');
        if (!map.has(char)) map.set(char, { hex: codeHex, code: startCode + i });
      }
    }
  }
  return map;
}

function decodeUnicodeHex(hex: string): string {
  // ToUnicode targets are big-endian UTF-16 surrogate pairs if needed.
  if (hex.length <= 4) return String.fromCodePoint(parseInt(hex, 16));
  let out = '';
  for (let i = 0; i < hex.length; i += 4) out += String.fromCharCode(parseInt(hex.slice(i, i + 4), 16));
  return out;
}

// Returns a function (charCode) → advance width in glyph-space (1/1000 em).
export function buildWidthLookup(pdfDoc: PDFDocument, fontRef: PDFRef): WidthLookup {
  const fontObj = pdfDoc.context.lookup(fontRef);
  if (!(fontObj instanceof PDFDict)) return () => 500;

  // Simple font: /FirstChar /LastChar /Widths [...]
  const widthsArr = fontObj.lookup(PDFName.of('Widths'));
  const firstChar = fontObj.lookup(PDFName.of('FirstChar'));
  if (widthsArr instanceof PDFArray && firstChar instanceof PDFNumber) {
    const first = firstChar.asNumber();
    const widths = widthsArr.asArray().map((n) => (n instanceof PDFNumber ? n.asNumber() : 0));
    const missing = (() => {
      const desc = fontObj.lookup(PDFName.of('FontDescriptor'));
      if (desc instanceof PDFDict) {
        const mw = desc.lookup(PDFName.of('MissingWidth'));
        if (mw instanceof PDFNumber) return mw.asNumber();
      }
      return 0;
    })();
    return (code: number) => {
      const idx = code - first;
      return idx >= 0 && idx < widths.length ? widths[idx] : missing;
    };
  }

  // Type0 / CIDFont: /DescendantFonts [<<CIDFont>>] with /W array.
  const desc = fontObj.lookup(PDFName.of('DescendantFonts'));
  if (desc instanceof PDFArray) {
    const cidFontRef = desc.get(0);
    const cidFont = pdfDoc.context.lookup(cidFontRef);
    if (cidFont instanceof PDFDict) {
      const dw = cidFont.lookup(PDFName.of('DW'));
      const defaultW = dw instanceof PDFNumber ? dw.asNumber() : 1000;
      const w = cidFont.lookup(PDFName.of('W'));
      const table = new Map<number, number>();
      if (w instanceof PDFArray) {
        const arr = w.asArray();
        let i = 0;
        while (i < arr.length) {
          const first = arr[i] instanceof PDFNumber ? (arr[i] as PDFNumber).asNumber() : 0;
          const second = arr[i + 1];
          if (second instanceof PDFArray) {
            const widths = second.asArray().map((n) => (n instanceof PDFNumber ? n.asNumber() : defaultW));
            for (let j = 0; j < widths.length; j++) table.set(first + j, widths[j]);
            i += 2;
          } else if (second instanceof PDFNumber) {
            const last = second.asNumber();
            const width = arr[i + 2] instanceof PDFNumber ? (arr[i + 2] as PDFNumber).asNumber() : defaultW;
            for (let c = first; c <= last; c++) table.set(c, width);
            i += 3;
          } else {
            i += 1;
          }
        }
      }
      return (code: number) => (table.has(code) ? (table.get(code) as number) : defaultW);
    }
  }

  return () => 500;
}

export function getAscentRatio(pdfDoc: PDFDocument, fontRef: PDFRef): number {
  const fontObj = pdfDoc.context.lookup(fontRef);
  if (!(fontObj instanceof PDFDict)) return DEFAULT_ASCENT_RATIO;
  let desc = fontObj.lookup(PDFName.of('FontDescriptor'));
  if (!(desc instanceof PDFDict)) {
    const dfs = fontObj.lookup(PDFName.of('DescendantFonts'));
    if (dfs instanceof PDFArray) {
      const cid = pdfDoc.context.lookup(dfs.get(0));
      if (cid instanceof PDFDict) {
        const d = cid.lookup(PDFName.of('FontDescriptor'));
        if (d instanceof PDFDict) desc = d;
      }
    }
  }
  if (!(desc instanceof PDFDict)) return DEFAULT_ASCENT_RATIO;
  const ascent = desc.lookup(PDFName.of('Ascent'));
  if (ascent instanceof PDFNumber) return ascent.asNumber() / 1000;
  return DEFAULT_ASCENT_RATIO;
}

export function getBaseFont(pdfDoc: PDFDocument, fontRef: PDFRef): string {
  const fontObj = pdfDoc.context.lookup(fontRef);
  if (!(fontObj instanceof PDFDict)) return '(unknown)';
  const bf = fontObj.lookup(PDFName.of('BaseFont'));
  return bf ? bf.toString().replace(/^\//, '') : '(unknown)';
}

// ---------- encoding & measurement ----------

export function encodeAndMeasure(
  text: string,
  reverseMap: ReverseMap,
  widthLookup: WidthLookup,
  fieldName: string,
  baseFont: string,
): EncodedText {
  const missing: string[] = [];
  let hex = '';
  let widthUnits = 0;
  const perCharAdvance: number[] = [];
  for (const char of text) {
    const entry = reverseMap.get(char);
    if (!entry) {
      missing.push(char);
      perCharAdvance.push(0);
      continue;
    }
    hex += entry.hex;
    const adv = widthLookup(entry.code);
    widthUnits += adv;
    perCharAdvance.push(adv);
  }
  if (missing.length) {
    const unique = [...new Set(missing)].join('');
    throw new Error(
      `Field "${fieldName}": font "${baseFont}" is missing glyph(s) for character(s) "${unique}". ` +
        `Re-export the template with font subsetting set to 0% so the full font is embedded.`,
    );
  }
  return { hex, widthUnits, perCharAdvance };
}

function wrapLines(
  text: string,
  reverseMap: ReverseMap,
  widthLookup: WidthLookup,
  sizePt: number,
  innerWidth: number,
  maxLines: number,
  fieldName: string,
  baseFont: string,
): LineLayout[] {
  if (maxLines === 1) {
    const enc = encodeAndMeasure(text, reverseMap, widthLookup, fieldName, baseFont);
    return [{ text, hex: enc.hex, widthPt: (enc.widthUnits * sizePt) / 1000 }];
  }
  const words = text.split(/(\s+)/); // keep separators
  const lines: string[] = [];
  let current = '';
  for (const token of words) {
    const candidate = current + token;
    const enc = encodeAndMeasure(candidate, reverseMap, widthLookup, fieldName, baseFont);
    const widthPt = (enc.widthUnits * sizePt) / 1000;
    if (widthPt <= innerWidth || current.length === 0) {
      current = candidate;
    } else {
      lines.push(current.replace(/\s+$/, ''));
      current = token.replace(/^\s+/, '');
      if (lines.length >= maxLines) break;
    }
  }
  if (current && lines.length < maxLines) lines.push(current.replace(/\s+$/, ''));
  return lines.slice(0, maxLines).map((line) => {
    const enc = encodeAndMeasure(line, reverseMap, widthLookup, fieldName, baseFont);
    return { text: line, hex: enc.hex, widthPt: (enc.widthUnits * sizePt) / 1000 };
  });
}

// ---------- appearance stream ----------

function buildAppearance(
  pdfDoc: PDFDocument,
  widget: PDFWidgetAnnotation,
  lines: LineLayout[],
  fontShortName: string,
  fontRef: PDFRef,
  sizePt: number,
  color: RGB,
  align: number,
  ascentRatio: number,
): void {
  const rect = widget.getRectangle();
  const { width, height } = rect;
  const innerW = width - 2 * PADDING_PT;
  const innerH = height - 2 * PADDING_PT;
  const lineHeight = sizePt * LINE_GAP;
  const blockHeight = lines.length * lineHeight;
  const topPad = Math.max(0, (innerH - blockHeight) / 2);
  const ascentPt = sizePt * ascentRatio;
  const firstBaselineFromBottom = PADDING_PT + innerH - topPad - ascentPt;

  const [r, g, b] = color;
  const ops: string[] = ['/Tx BMC', 'q', 'BT', `/${fontShortName} ${sizePt} Tf`, `${fmt(r)} ${fmt(g)} ${fmt(b)} rg`];

  let prevX = 0;
  let prevY = 0;
  lines.forEach((line, idx) => {
    let x: number;
    if (align === 1) x = PADDING_PT + (innerW - line.widthPt) / 2;
    else if (align === 2) x = PADDING_PT + innerW - line.widthPt;
    else x = PADDING_PT;
    const y = firstBaselineFromBottom - idx * lineHeight;
    const dx = x - prevX;
    const dy = y - prevY;
    ops.push(`${fmt(dx)} ${fmt(dy)} Td`);
    ops.push(`<${line.hex}> Tj`);
    prevX = x;
    prevY = y;
  });
  ops.push('ET', 'Q', 'EMC');

  const xObject = pdfDoc.context.stream(ops.join('\n'), {
    Type: 'XObject',
    Subtype: 'Form',
    BBox: pdfDoc.context.obj([0, 0, width, height]),
    Resources: pdfDoc.context.obj({ Font: pdfDoc.context.obj({ [fontShortName]: fontRef }) }),
  });
  widget.dict.set(PDFName.of('AP'), pdfDoc.context.obj({ N: pdfDoc.context.register(xObject) }));
}

function fmt(n: number): string {
  return Number.isFinite(n) ? +n.toFixed(4) + '' : '0';
}

// Resolve a font reference by either short name (key in /DR /Font or a page's
// /Font dict) or by /BaseFont. Designers writing font overrides naturally
// reach for the BaseFont they see in their PDF inspector (e.g. "UniversLTStd-
// Bold"), not the short name Acrobat assigned in /DR (which is *usually* the
// same but not guaranteed). On miss, throws an error listing every embedded
// font in both forms so the user can pick a valid name.
function resolveFontByNameOrBaseFont(
  requested: string,
  formFonts: Map<string, PDFObject>,
  pageFonts: Map<string, PDFObject>,
  pdfDoc: PDFDocument,
  fieldName: string,
  isExplicitOverride: boolean,
): PDFRef {
  // 1) exact short-name match (existing behavior).
  const candidate: PDFObject | undefined = formFonts.get(requested) ?? pageFonts.get(requested);
  let ref = resolveFontRef(candidate, pdfDoc);
  if (ref) return ref;

  // 2) /BaseFont match across every embedded font. Subset prefixes (the
  //    "ABCDEF+" PDF-spec prefix that signals a subsetted font) are stripped
  //    on both sides so callers can write "UniversLTStd-Bold" even if the
  //    embedded font shows up as "ABCDEF+UniversLTStd-Bold".
  const stripPrefix = (s: string): string => s.replace(/^[A-Z]{6}\+/, '');
  const target = stripPrefix(requested).toLowerCase();
  const catalog: { shortName: string; baseFont: string; ref: PDFRef }[] = [];
  for (const source of [formFonts, pageFonts]) {
    for (const [shortName, val] of source.entries()) {
      const r = resolveFontRef(val, pdfDoc);
      if (!r) continue;
      const baseFont = getBaseFont(pdfDoc, r);
      catalog.push({ shortName, baseFont, ref: r });
      if (stripPrefix(baseFont).toLowerCase() === target) {
        ref = r;
      }
    }
  }
  if (ref) return ref;

  // 3) Miss. Build a helpful error listing what *is* available.
  const seen = new Set<string>();
  const lines = catalog
    .filter((c) => {
      const k = `${c.shortName}|${c.baseFont}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .map((c) => `  - shortName="${c.shortName}", baseFont="${c.baseFont}"`)
    .join('\n');
  const sourceLabel = isExplicitOverride ? 'font override' : '/DA';
  throw new Error(
    `Field "${fieldName}": ${sourceLabel} requested font "${requested}", which is not embedded ` +
      `in this PDF.\nEmbedded fonts (match by either shortName or baseFont):\n${lines || '  (none)'}`,
  );
}

// ---------- main entry point ----------

export async function fillCoverTemplate({
  templateBytes,
  values,
  overrides = {},
  debug = false,
}: FillCoverTemplateOptions): Promise<Uint8Array> {
  const dbg = makeDebugger(debug);
  const pdfDoc = await PDFDocument.load(templateBytes);
  const form = pdfDoc.getForm();
  const fields = form.getFields();

  // Document-level diagnostics.
  const pages = pdfDoc.getPages();
  dbg('document loaded', {
    pageCount: pages.length,
    pageSizes: pages.map((p) => {
      const { width, height } = p.getSize();
      return { widthPt: +width.toFixed(2), heightPt: +height.toFixed(2) };
    }),
    pdfVersion: (() => {
      const v = pdfDoc.catalog.lookup(PDFName.of('Version'));
      return v ? v.toString().replace(/^\//, '') : '(default 1.7 per pdf-lib)';
    })(),
    valueKeys: Object.keys(values),
    overrideKeys: Object.keys(overrides),
  });

  // Validate field set. Names are matched case-insensitively and stored
  // under the canonical uppercase form (`seen` is keyed by canonical name).
  const seen = new Map<CanonicalFieldName, PDFField>();
  dbg(
    `discovered ${fields.length} form field(s):`,
    fields.map((f) => JSON.stringify(f.getName())).join(', ') || '(none)',
  );
  for (const field of fields) {
    const rawName = field.getName();
    const canonical = canonicalFieldName(rawName);
    if (!canonical) {
      console.warn(`Skipping unknown field "${rawName}" (not in COVER_TEMPLATE_GUIDELINES.md).`);
      continue;
    }
    if (seen.has(canonical)) {
      throw new Error(
        `Template has duplicate field name "${rawName}" (matches existing "${canonical}" case-insensitively).`,
      );
    }
    if (!(field.acroField instanceof PDFAcroText)) {
      console.warn(
        `Skipping non-text field "${rawName}" (only /Tx fields are supported; got ${field.acroField?.constructor?.name ?? 'unknown'}).`,
      );
      continue;
    }
    seen.set(canonical, field);
  }
  for (const req of REQUIRED_FIELDS) {
    if (!seen.has(req)) {
      throw new Error(
        `Template is missing required field "${req}". Found: [${[...seen.keys()].join(', ') || 'none'}].`,
      );
    }
  }

  // AcroForm hygiene: we provide /AP so disable auto-regeneration.
  const acroForm = pdfDoc.catalog.lookup(PDFName.of('AcroForm'));
  if (acroForm instanceof PDFDict) {
    acroForm.set(PDFName.of('NeedAppearances'), pdfDoc.context.obj(false));
  }

  const formFonts = collectFormFontResources(pdfDoc);
  const pageFonts = collectPageFontResources(pdfDoc);

  if (debug) {
    const describeRefMap = (label: string, m: Map<string, PDFObject>) => {
      if (m.size === 0) {
        dbg(`${label}: (none)`);
        return;
      }
      dbg(`${label}: ${m.size} font(s)`);
      for (const [shortName, val] of m.entries()) {
        const ref = resolveFontRef(val, pdfDoc);
        if (!ref) {
          dbg(`  /${shortName} -> (unresolved)`);
          continue;
        }
        const obj = pdfDoc.context.lookup(ref);
        if (obj instanceof PDFDict) {
          dbg(`  /${shortName} ->`, describeFont(pdfDoc, obj));
        } else {
          dbg(`  /${shortName} -> (not a font dict)`);
        }
      }
    };
    describeRefMap('AcroForm /DR /Font resources', formFonts);
    describeRefMap('Page /Font resources', pageFonts);
  }

  // Cache reverse maps / width lookups / ascent per font ref (keyed by ref string).
  const fontCache = new Map<string, FontBundle>();
  const registeredShortNames = new Map<string, string>(); // refKey → short name registered in /DR

  // Reverse lookup: ref → existing short name in /DR /Font. Used so that when
  // a BaseFont-style override resolves to a ref already in /DR, we reuse the
  // ref's real short name instead of overwriting /DR with a new binding.
  const formFontShortByRef = new Map<string, string>();
  for (const [shortName, val] of formFonts.entries()) {
    const r = resolveFontRef(val, pdfDoc);
    if (r) formFontShortByRef.set(`${r.objectNumber} ${r.generationNumber}`, shortName);
  }

  let shortCounter = 0;
  const getFontBundle = (fontRef: PDFRef, preferredShortName: string | null): FontBundle => {
    const key = `${fontRef.objectNumber} ${fontRef.generationNumber}`;
    const cached = fontCache.get(key);
    if (cached) return cached;
    const reverseMap = buildToUnicodeReverseMap(pdfDoc, fontRef);
    const widthLookup = buildWidthLookup(pdfDoc, fontRef);
    const ascentRatio = getAscentRatio(pdfDoc, fontRef);
    const baseFont = getBaseFont(pdfDoc, fontRef);
    let shortName = registeredShortNames.get(key) ?? formFontShortByRef.get(key);
    if (!shortName) {
      shortName = preferredShortName && !formFonts.has(preferredShortName) ? preferredShortName : `F${++shortCounter}`;
      registerFontInForm(pdfDoc, shortName, fontRef);
      registeredShortNames.set(key, shortName);
    }
    const bundle: FontBundle = { reverseMap, widthLookup, ascentRatio, baseFont, shortName, fontRef };
    fontCache.set(key, bundle);
    return bundle;
  };

  for (const fieldName of ALL_FIELDS) {
    const field = seen.get(fieldName);
    if (!field) {
      dbg(`field ${fieldName}: not in template, skipping`);
      continue;
    }
    if (!(field.acroField instanceof PDFAcroText)) continue;

    const raw = getCaseInsensitive(values, fieldName);
    if (raw == null || raw === '') {
      dbg(`field ${fieldName}: no value supplied, skipping`);
      continue;
    }

    const rawStr = String(raw);
    const truncated = rawStr.slice(0, MAX_CHARS[fieldName]);
    if (rawStr.length > MAX_CHARS[fieldName]) {
      dbg(`field ${fieldName}: value length ${rawStr.length} exceeds max ${MAX_CHARS[fieldName]} — truncated`);
    }

    const widget = field.acroField.getWidgets()[0];
    if (!widget) {
      dbg(`field ${fieldName}: no widget annotation, skipping`);
      continue;
    }
    const rectForLog = widget.getRectangle();
    dbg(`field ${fieldName}:`, {
      rawName: field.getName(),
      valueLength: rawStr.length,
      effectiveLength: truncated.length,
      widgetRect: {
        x: +rectForLog.x.toFixed(2),
        y: +rectForLog.y.toFixed(2),
        widthPt: +rectForLog.width.toFixed(2),
        heightPt: +rectForLog.height.toFixed(2),
      },
    });

    // Read /DA — falls back to AcroForm-level /DA if widget lacks one.
    const widgetDA = field.acroField.dict.lookup(PDFName.of('DA'));
    let daStr: string | null = null;
    if (widgetDA instanceof PDFString || widgetDA instanceof PDFHexString) daStr = widgetDA.decodeText();
    if (!daStr && acroForm instanceof PDFDict) {
      const formDA = acroForm.lookup(PDFName.of('DA'));
      if (formDA instanceof PDFString || formDA instanceof PDFHexString) daStr = formDA.decodeText();
    }
    const da = parseDA(daStr);
    dbg(`field ${fieldName}: /DA`, { raw: daStr, parsed: da });

    // Read /Q (alignment).
    let q = 0;
    const widgetQ = field.acroField.dict.lookup(PDFName.of('Q'));
    if (widgetQ instanceof PDFNumber) q = widgetQ.asNumber();

    // Read /Ff (multi-line bit 13 = 0x1000).
    let ff = 0;
    const widgetFf = field.acroField.dict.lookup(PDFName.of('Ff'));
    if (widgetFf instanceof PDFNumber) ff = widgetFf.asNumber();
    const isMultiline = (ff & 0x1000) !== 0;
    dbg(`field ${fieldName}: /Q`, q, `/Ff`, ff, `multiline=${isMultiline}`);

    // Apply overrides.
    const ovr = (getCaseInsensitive(overrides, fieldName) ?? {}) as FieldOverride;
    const fontShortNameDA = ovr.font ?? da.fontName;
    const sizePt = ovr.size ?? da.size;
    const color = ovr.color ?? da.color;
    const align = ovr.align ?? q;
    const multilineEffective = ovr.multiline ?? isMultiline;

    if (!fontShortNameDA) {
      throw new Error(`Field "${fieldName}" has no font in /DA (and no override provided).`);
    }
    if (!sizePt || sizePt <= 0) {
      throw new Error(
        `Field "${fieldName}" has no explicit font size — set a numeric size in Acrobat ` +
          `(never "Auto") per COVER_TEMPLATE_GUIDELINES.md Step 3.`,
      );
    }

    // Resolve font ref. Try short-name match first (the /DR-style identifier
    // used in /DA strings, e.g. "Arial,Bold"). If that misses and an override
    // was supplied, try matching against /BaseFont across every embedded font
    // — designers typically think in BaseFont terms ("UniversLTStd-Bold")
    // rather than the short name Acrobat happens to have assigned.
    const fontRef = resolveFontByNameOrBaseFont(
      fontShortNameDA,
      formFonts,
      pageFonts,
      pdfDoc,
      fieldName,
      ovr.font != null,
    );

    const bundle = getFontBundle(fontRef, fontShortNameDA);

    const rect = widget.getRectangle();
    const innerWidth = rect.width - 2 * PADDING_PT;
    const maxLines = multilineEffective ? MAX_LINES[fieldName] : 1;

    dbg(`field ${fieldName}: resolved render config`, {
      fontShortNameInDA: fontShortNameDA,
      registeredShortName: bundle.shortName,
      baseFont: bundle.baseFont,
      fontRef: `${bundle.fontRef.objectNumber} ${bundle.fontRef.generationNumber} R`,
      sizePt,
      colorRGB: color,
      align,
      maxLines: maxLines === Infinity ? 'unbounded' : maxLines,
      ascentRatio: +bundle.ascentRatio.toFixed(4),
      reverseMapSize: bundle.reverseMap.size,
      innerWidthPt: +innerWidth.toFixed(2),
      innerHeightPt: +(rect.height - 2 * PADDING_PT).toFixed(2),
      overrideApplied: Object.keys(ovr).length > 0 ? ovr : null,
    });

    const lines = wrapLines(
      truncated,
      bundle.reverseMap,
      bundle.widthLookup,
      sizePt,
      innerWidth,
      maxLines,
      fieldName,
      bundle.baseFont,
    );

    dbg(
      `field ${fieldName}: wrapped to ${lines.length} line(s)`,
      lines.map((l, i) => ({
        line: i + 1,
        text: l.text,
        widthPt: +l.widthPt.toFixed(2),
        fits: l.widthPt <= innerWidth,
      })),
    );

    // Width sanity check on single-line fields.
    if (maxLines === 1 && lines[0] && lines[0].widthPt > innerWidth) {
      console.warn(
        `Field "${fieldName}": rendered width ${lines[0].widthPt.toFixed(1)}pt exceeds inner ` +
          `width ${innerWidth.toFixed(1)}pt — widget rectangle is undersized for max-length content.`,
      );
    }

    buildAppearance(pdfDoc, widget, lines, bundle.shortName, bundle.fontRef, sizePt, color, align, bundle.ascentRatio);
    dbg(`field ${fieldName}: appearance stream built and assigned to widget /AP /N`);
  }

  // pdf-lib's flatten() requires every widget to have a /AP /N appearance.
  // Fields we didn't fill (no value supplied, or unknown field name) may still
  // be lacking one if the template never generated appearances. Stamp an
  // empty Form XObject so flatten can erase them cleanly.
  let emptyStamped = 0;
  for (const field of fields) {
    for (const widget of field.acroField.getWidgets?.() ?? []) {
      const ap = widget.dict.lookup(PDFName.of('AP'));
      const hasN = ap instanceof PDFDict && ap.lookup(PDFName.of('N'));
      if (hasN) continue;
      const rect = widget.getRectangle();
      const empty = pdfDoc.context.stream('', {
        Type: 'XObject',
        Subtype: 'Form',
        BBox: pdfDoc.context.obj([0, 0, rect.width, rect.height]),
        Resources: pdfDoc.context.obj({}),
      });
      widget.dict.set(PDFName.of('AP'), pdfDoc.context.obj({ N: pdfDoc.context.register(empty) }));
      emptyStamped++;
      dbg(`stamped empty /AP /N for unfilled widget on field "${field.getName()}"`);
    }
  }
  dbg(`flatten: stamped ${emptyStamped} empty appearance(s); calling form.flatten()`);

  form.flatten({ updateFieldAppearances: false });
  const out = await pdfDoc.save();
  dbg(`done: saved ${out.byteLength} bytes`);
  return out;
}

/**
 * Parse a CSS-style hex color (`#rgb`, `#rrggbb`, or without the leading `#`)
 * into pdf-lib's 0–1 float channels. Throws on malformed input.
 */
export function hexToRgb01(hex: string): { r: number; g: number; b: number } {
  const m = hex.trim().replace(/^#/, '');
  let r: number, g: number, b: number;
  if (/^[0-9a-fA-F]{3}$/.test(m)) {
    r = parseInt(m[0] + m[0], 16);
    g = parseInt(m[1] + m[1], 16);
    b = parseInt(m[2] + m[2], 16);
  } else if (/^[0-9a-fA-F]{6}$/.test(m)) {
    r = parseInt(m.slice(0, 2), 16);
    g = parseInt(m.slice(2, 4), 16);
    b = parseInt(m.slice(4, 6), 16);
  } else {
    throw new Error(`Invalid hex color: ${hex}`);
  }
  return { r: r / 255, g: g / 255, b: b / 255 };
}
