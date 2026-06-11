// Debug CLI for the cover-template filler. Mirrors the original
// pdf-modifier/fill-form.ts CLI: reads a template PDF and a values JSON file,
// fills the form fields, flattens, and writes the output.
//
// Usage:
//   npm run fill-cover-template -- <template.pdf> <values.json> <output.pdf>
//   tsx src/fillCoverTemplate.ts <template.pdf> <values.json> <output.pdf>
//
// The values JSON may include a top-level "fonts" map (mirrors the test
// fixture) that gets converted into per-field font overrides. Verbose
// debug logging is on by default; suppress with FILL_FORM_DEBUG=0.

import fs from 'node:fs';
import { fillCoverTemplate } from './util/coverTemplateFiller';
import { FieldOverride } from './types/pdf';

const [tplPath, valuesPath, outPath] = process.argv.slice(2);
if (!tplPath || !valuesPath || !outPath) {
  console.error('Usage: tsx src/fillCoverTemplate.ts <template.pdf> <values.json> <output.pdf>');
  process.exit(2);
}

const templateBytes = fs.readFileSync(tplPath);
const valuesFile = JSON.parse(fs.readFileSync(valuesPath, 'utf8')) as Record<string, unknown>;

const { fonts: fontsMap, ...values } = valuesFile as Record<string, unknown> & {
  fonts?: Record<string, string>;
};
const overrides: Record<string, FieldOverride> = {};
if (fontsMap && typeof fontsMap === 'object') {
  for (const [field, fontName] of Object.entries(fontsMap)) {
    if (typeof fontName !== 'string' || !fontName.trim()) continue;
    overrides[field] = { font: fontName };
  }
}

const debug = process.env.FILL_FORM_DEBUG !== '0';
const bytes = await fillCoverTemplate({ templateBytes, values, overrides, debug });
fs.writeFileSync(outPath, bytes);
console.log(`Wrote ${outPath}`);
