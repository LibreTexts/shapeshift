import { NextFunction, Request, Response } from 'express';
import { Environment } from '../../lib/environment';
import { log as logService } from '../../lib/log';

// X-Frame-Options has no wildcard or multi-origin form, so CSP frame-ancestors is the only way to
// allow every *commons.libretexts.org host. Browsers that support both ignore XFO when
// frame-ancestors is present, but Safari still honors XFO, so it is removed outright.
const DEFAULT_FRAME_ANCESTORS = "'self' https://libretexts.org https://*.libretexts.org";
const DEVELOPMENT_FRAME_ANCESTORS = 'http://localhost:* http://127.0.0.1:*';

const logger = logService.child().withContext({ logSource: 'FrameAncestors' });

/**
 * Source expressions accepted in FRAME_ANCESTORS: the three keywords the directive defines, or a
 * host source with an optional scheme, an optional leading `*.`, and an optional port or `:*`.
 */
const KEYWORD_SOURCES = new Set(["'self'", "'none'", '*']);
const HOST_SOURCE = /^(?:https?:\/\/)?(?:\*\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)*(?::(?:\d{1,5}|\*))?$/i;

/**
 * Validates the configured directive before it reaches a response header.
 *
 * The value is operator-supplied, so this is not defending against a request. It is defending
 * against a typo. A stray `;` would let the rest of the string be read as further CSP directives,
 * and a malformed token makes browsers drop the whole directive, which disables the clickjacking
 * protection silently and site-wide. Neither failure is visible from the outside, so the check has
 * to happen here and say so in the logs.
 *
 * A rejected value falls back to the default rather than serving nothing: an over-permissive header
 * assembled from a broken config is worse than the known-good one.
 */
function validate(configured: string): string {
  const tokens = configured.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) {
    logger.error('FRAME_ANCESTORS is empty. Falling back to the default frame-ancestors policy.');
    return DEFAULT_FRAME_ANCESTORS;
  }

  const invalid = tokens.filter((token) => !KEYWORD_SOURCES.has(token.toLowerCase()) && !HOST_SOURCE.test(token));
  if (invalid.length > 0) {
    logger
      .withMetadata({ configured, invalid })
      .error('FRAME_ANCESTORS contains invalid source expressions. Falling back to the default policy.');
    return DEFAULT_FRAME_ANCESTORS;
  }

  if (tokens.some((token) => token === '*')) {
    logger.warn('FRAME_ANCESTORS is set to "*". Any site is able to frame this API.');
  }
  return tokens.join(' ');
}

/**
 * Resolved once at module load. The value comes from the environment, which does not change while
 * the process runs, and rebuilding it per request bought nothing. Resolving it here also means a
 * bad value is reported at startup rather than on the first request that happens to arrive.
 */
const HEADER_VALUE = (() => {
  const sources = validate(Environment.getOptional('FRAME_ANCESTORS', DEFAULT_FRAME_ANCESTORS).trim());
  return Environment.getSystemEnvironment() === 'DEVELOPMENT'
    ? `frame-ancestors ${sources} ${DEVELOPMENT_FRAME_ANCESTORS}`
    : `frame-ancestors ${sources}`;
})();

export function frameAncestors(_req: Request, res: Response, next: NextFunction) {
  // Nothing in this app sets X-Frame-Options today (workers/api.ts uses only helmet.hidePoweredBy),
  // so this is a guard against a reverse proxy adding one, or helmet.frameguard being switched on
  // later. Either would override the policy above in Safari, which does not implement
  // frame-ancestors.
  res.removeHeader('X-Frame-Options');
  res.setHeader('Content-Security-Policy', HEADER_VALUE);
  return next();
}
