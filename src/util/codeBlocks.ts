import * as cheerio from 'cheerio';
import { encode } from 'html-entities';
import hljs from 'highlight.js/lib/core';
import bash from 'highlight.js/lib/languages/bash';
import cpp from 'highlight.js/lib/languages/cpp';
import csharp from 'highlight.js/lib/languages/csharp';
import css from 'highlight.js/lib/languages/css';
import java from 'highlight.js/lib/languages/java';
import javascript from 'highlight.js/lib/languages/javascript';
import perl from 'highlight.js/lib/languages/perl';
import php from 'highlight.js/lib/languages/php';
import powershell from 'highlight.js/lib/languages/powershell';
import python from 'highlight.js/lib/languages/python';
import r from 'highlight.js/lib/languages/r';
import ruby from 'highlight.js/lib/languages/ruby';
import sql from 'highlight.js/lib/languages/sql';
import typescript from 'highlight.js/lib/languages/typescript';
import vbnet from 'highlight.js/lib/languages/vbnet';
import x86asm from 'highlight.js/lib/languages/x86asm';
import xml from 'highlight.js/lib/languages/xml';

hljs.registerLanguage('bash', bash);
hljs.registerLanguage('cpp', cpp);
hljs.registerLanguage('csharp', csharp);
hljs.registerLanguage('css', css);
hljs.registerLanguage('java', java);
hljs.registerLanguage('javascript', javascript);
hljs.registerLanguage('perl', perl);
hljs.registerLanguage('php', php);
hljs.registerLanguage('powershell', powershell);
hljs.registerLanguage('python', python);
hljs.registerLanguage('r', r);
hljs.registerLanguage('ruby', ruby);
hljs.registerLanguage('sql', sql);
hljs.registerLanguage('typescript', typescript);
hljs.registerLanguage('vbnet', vbnet);
hljs.registerLanguage('x86asm', x86asm);
hljs.registerLanguage('xml', xml);

/**
 * Language names CXOne writes on code blocks (DekiScript `function="syntax.x"`, or the older
 * SyntaxHighlighter `class="brush: x;"`) mapped to highlight.js language names. Anything absent (plain, text, asm, etc.) renders without
 * token colors. Auto-detection is deliberately not used: it guesses wrong on assembly
 * and pseudo-code, which is common in LibreTexts content.
 */
const LANGUAGE_ALIASES: Record<string, string> = {
  bash: 'bash',
  sh: 'bash',
  shell: 'bash',
  c: 'cpp',
  cpp: 'cpp',
  'c++': 'cpp',
  'c#': 'csharp',
  'c-sharp': 'csharp',
  csharp: 'csharp',
  cs: 'csharp',
  css: 'css',
  java: 'java',
  js: 'javascript',
  jscript: 'javascript',
  javascript: 'javascript',
  perl: 'perl',
  pl: 'perl',
  php: 'php',
  ps: 'powershell',
  powershell: 'powershell',
  py: 'python',
  python: 'python',
  r: 'r',
  rb: 'ruby',
  ruby: 'ruby',
  rails: 'ruby',
  sql: 'sql',
  ts: 'typescript',
  typescript: 'typescript',
  vb: 'vbnet',
  vbnet: 'vbnet',
  x86asm: 'x86asm',
  nasm: 'x86asm',
  html: 'xml',
  xhtml: 'xml',
  xml: 'xml',
  xslt: 'xml',
};

const ZERO_WIDTH_SPACE = '&#8203;';
const TAB_WIDTH = 8;

/**
 * Expands tabs to spaces on 8-column stops. Prince measures tab stops from the start of the
 * line box, which includes the line-number gutter, so literal tabs would misalign columns.
 */
function expandTabs(line: string): string {
  if (!line.includes('\t')) return line;
  let out = '';
  for (const ch of line) {
    out += ch === '\t' ? ' '.repeat(TAB_WIDTH - (out.length % TAB_WIDTH)) : ch;
  }
  return out;
}

function detectLanguage($pre: cheerio.Cheerio<any>): string | undefined {
  const fn = $pre.attr('function') ?? '';
  const className = $pre.attr('class') ?? '';
  const match =
    fn.match(/^\s*syntax\.([\w#+-]+)/i) ??
    className.match(/(?:^|[\s;])brush:\s*([\w#+-]+)/i) ??
    className.match(/\blang(?:uage)?-([\w#+-]+)/i);
  if (!match) return undefined;
  return LANGUAGE_ALIASES[match[1].toLowerCase()];
}

/**
 * Splits highlight.js output into per-line HTML strings. hljs spans can cross newlines
 * (block comments, multi-line strings), so open spans are closed at each line break and
 * reopened at the start of the next line to keep every line well-formed.
 */
function splitHighlightedLines(html: string): string[] {
  const lines: string[] = [];
  const openTags: string[] = [];
  let current = '';
  const tokenRe = /(<span[^>]*>)|(<\/span>)|(\n)|([^<\n]+)/g;
  let m: RegExpExecArray | null;
  while ((m = tokenRe.exec(html)) !== null) {
    if (m[1]) {
      openTags.push(m[1]);
      current += m[1];
    } else if (m[2]) {
      openTags.pop();
      current += m[2];
    } else if (m[3]) {
      lines.push(current + '</span>'.repeat(openTags.length));
      current = openTags.join('');
    } else {
      current += m[4];
    }
  }
  lines.push(current);
  return lines;
}

/**
 * Rewrites CMS `<pre>` code blocks into static markup Prince can style: one block span per
 * line (CSS adds the line-number gutter and zebra rows) and highlight.js token spans when the
 * block declares a known language. CXOne does this client-side with SyntaxHighlighter, which
 * never runs during PDF conversion.
 *
 * Skips DekiScript `pre.script` blocks and is idempotent on already-converted output.
 */
export function formatCodeBlocksForPDF(html: string): string {
  if (!html || !html.includes('<pre')) return html;

  const $ = cheerio.load(html, null, false);
  $('pre').each((_, el) => {
    const $pre = $(el);
    if ($pre.hasClass('script') || $pre.hasClass('pdf-code-body')) return;

    // CKEditor sometimes stores line breaks as <br> inside <pre>; .text() would drop them.
    $pre.find('br').replaceWith('\n');
    const code = $pre
      .text()
      .replace(/\r\n?/g, '\n')
      .replace(/^\n/, '')
      .replace(/\n$/, '')
      .split('\n')
      .map(expandTabs)
      .join('\n');

    const language = detectLanguage($pre);
    const lines = language
      ? splitHighlightedLines(hljs.highlight(code, { language, ignoreIllegals: true }).value)
      : code.split('\n').map((line) => encode(line));

    const body = lines
      .map((line) => `<span class="pdf-code-line">${line.length ? line : ZERO_WIDTH_SPACE}</span>`)
      .join('');

    const title = $pre.attr('title')?.trim();
    const titleHTML = title ? `<p class="pdf-code-title">${encode(title)}</p>` : '';
    const langAttr = language ? ` data-lang="${language}"` : '';

    $pre.replaceWith(
      `${titleHTML}<div class="pdf-code"${langAttr}><pre class="pdf-code-body${language ? ' hljs' : ''}">${body}</pre></div>`,
    );
  });

  return $.html();
}
