import { NextFunction, Request, Response } from 'express';
import { Environment } from '../../lib/environment';

// X-Frame-Options has no wildcard or multi-origin form, so CSP frame-ancestors is the only way to
// allow every *commons.libretexts.org host. Browsers that support both ignore XFO when
// frame-ancestors is present, but Safari still honors XFO, so it is removed outright.
const DEFAULT_FRAME_ANCESTORS = "'self' https://libretexts.org https://*.libretexts.org";
const DEVELOPMENT_FRAME_ANCESTORS = 'http://localhost:* http://127.0.0.1:*';

export function frameAncestors(_req: Request, res: Response, next: NextFunction) {
  const configured = Environment.getOptional('FRAME_ANCESTORS', DEFAULT_FRAME_ANCESTORS).trim();
  const sources =
    Environment.getSystemEnvironment() === 'DEVELOPMENT' ? `${configured} ${DEVELOPMENT_FRAME_ANCESTORS}` : configured;

  res.removeHeader('X-Frame-Options');
  res.setHeader('Content-Security-Policy', `frame-ancestors ${sources}`);
  return next();
}
