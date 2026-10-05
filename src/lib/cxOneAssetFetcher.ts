import axios, { AxiosError } from 'axios';
import { libraryNameKeysWDev } from '../librariesmap';
import { LibraryService } from '../services/library';
import { USER_AGENT } from '../util/util';
import { CXOneRateLimiter } from './cxOneRateLimiter';

const DEFAULT_TIMEOUT_MS = 30_000;
const LIBRARY_HOST = /^([a-z0-9-]+)\.libretexts\.org$/i;
const RATE_LIMITED_HOST = /(^|\.)libretexts\.org$/i;
const MAX_REDIRECTS = 5;

export interface FetchedAsset {
  /** True when the anonymous request was refused and the asset needed a server token. */
  authenticated: boolean;
  contentType: string | undefined;
  data: Buffer;
}

/**
 * One initialized client per library, shared across jobs. Init reads the token pair from
 * SSM, so it's done lazily and only for libraries that actually serve a restricted asset.
 */
const libraryClients = new Map<string, Promise<LibraryService>>();

function getLibraryClient(lib: string): Promise<LibraryService> {
  let client = libraryClients.get(lib);
  if (!client) {
    client = (async () => {
      const service = new LibraryService({ lib });
      await service.init();
      return service;
    })();
    // Drop failed inits so a transient SSM error doesn't poison the library for the worker's lifetime.
    client.catch(() => libraryClients.delete(lib));
    libraryClients.set(lib, client);
  }
  return client;
}

/** Returns the library key for a known LibreTexts library host, or null for anything else. */
function getLibraryFromURL(url: string): string | null {
  const match = LIBRARY_HOST.exec(new URL(url).hostname);
  const lib = match?.[1]?.toLowerCase();
  return lib && libraryNameKeysWDev.includes(lib) ? lib : null;
}

/** CXOne answers an anonymous request for a restricted file with a redirect to its login page. */
function isLoginRedirect(location: URL): boolean {
  return location.pathname.startsWith('/@app/auth/');
}

class AuthRequiredError extends Error {}

/**
 * Downloads an asset referenced by book content (typically an image under `/@api/deki/files`).
 *
 * The request is anonymous first, which is what public content needs and keeps CDN caching
 * intact. Files attached to pages with a Private (or otherwise restricted) CXOne permission
 * don't fail outright: they 302 to the login page, which axios would happily follow and return
 * as a 200 HTML document. Redirects are therefore followed by hand. A login redirect (or a
 * 401/403) from a known library host triggers one retry with the same server token used to
 * fetch the page content. The token is only ever sent to the original library host, never to
 * a redirect target such as a signed storage URL.
 */
export async function fetchCXOneAsset(url: string, opts: { timeout?: number } = {}): Promise<FetchedAsset> {
  const lib = getLibraryFromURL(url);
  const origin = new URL(url).origin;

  const download = async (headers: Record<string, string>): Promise<Omit<FetchedAsset, 'authenticated'>> => {
    let target = new URL(url);
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      // CXOne-hosted files count against the same API budget as page content; CDN assets don't.
      if (RATE_LIMITED_HOST.test(target.hostname)) await CXOneRateLimiter.waitUntilAPIAvailable();
      const response = await axios.get<ArrayBuffer>(target.toString(), {
        headers: { 'User-Agent': USER_AGENT, ...(target.origin === origin && headers) },
        maxRedirects: 0,
        responseType: 'arraybuffer',
        timeout: opts.timeout ?? DEFAULT_TIMEOUT_MS,
        validateStatus: (status) => status >= 200 && status < 400,
      });
      if (response.status >= 300) {
        const location = response.headers['location'];
        if (!location) throw new Error(`Redirect without location for ${target}`);
        const next = new URL(location, target);
        if (isLoginRedirect(next)) throw new AuthRequiredError(`Login required for ${url}`);
        target = next;
        continue;
      }
      const contentType = response.headers['content-type'] as string | undefined;
      // An HTML document is never a valid asset; it's an error or login page that slipped through.
      if (contentType?.startsWith('text/html'))
        throw new AuthRequiredError(`Received HTML instead of asset for ${url}`);
      return { contentType, data: Buffer.from(response.data as unknown as ArrayBuffer) };
    }
    throw new Error(`Too many redirects for ${url}`);
  };

  try {
    return { authenticated: false, ...(await download({})) };
  } catch (error) {
    const status = error instanceof AxiosError ? error.response?.status : undefined;
    const authRequired = error instanceof AuthRequiredError || status === 401 || status === 403;
    if (!lib || !authRequired) throw error;
  }

  const client = await getLibraryClient(lib);
  return { authenticated: true, ...(await download(client.getAuthHeaders())) };
}
