import { libraryNameKeysWDev } from './librariesmap';
import { Request } from 'express';

export type ErrorWithMessage = {
  message: string;
};

export function extractIPFromHeaders(req: Request) {
  const forwardFor = req.headers['x-forwarded-for'];
  if (forwardFor && typeof forwardFor === 'string') {
    const ips = forwardFor.split(',').map((ip) => ip.trim());
    if (ips.length > 0) {
      return ips[0]; // Use the first IP in the list
    }
  }

  return req.ip || ''; // Fallback to req.ip if no X-Forwarded-For header
}

export function getSubdomainFromLibrary(library: string): string | null {
  if (libraryNameKeysWDev.includes(library)) return library;
  return null;
}

export function getSubdomainFromURL(urlRaw: string) {
  const url = new URL(urlRaw);
  const parts = url.hostname.split('.');
  return parts.slice(0, -2).join('.');
}

export function getPathFromURL(urlRaw: string) {
  const url = new URL(urlRaw);
  return url.pathname;
}

// https://kentcdodds.com/blog/get-a-catch-block-error-message-with-typescript
function isErrorWithMessage(error: unknown): error is ErrorWithMessage {
  return (
    typeof error === 'object' &&
    error !== null &&
    'message' in error &&
    typeof (error as Record<string, unknown>).message === 'string'
  );
}

function toErrorWithMessage(maybeError: unknown): ErrorWithMessage {
  if (isErrorWithMessage(maybeError)) return maybeError;

  try {
    return new Error(JSON.stringify(maybeError));
  } catch {
    // fallback in case there's an error stringifying the maybeError
    // like with circular references for example.
    return new Error(String(maybeError));
  }
}

export function getErrorMessage(error: unknown) {
  return toErrorWithMessage(error).message;
}

export function omit<T extends object, U extends keyof T>(obj: T, ...keys: U[]): { [K in Exclude<keyof T, U>]: T[K] } {
  const retObj = {} as T;

  let key: keyof T;
  for (key in obj) {
    if (!keys.includes(key as U)) {
      retObj[key] = obj[key];
    }
  }

  return retObj;
}

export async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function isNonNullCXOneObject<T>(value: '' | T | undefined): value is T {
  return typeof value === 'object' && value !== null;
}

export const isEmptyString = (str: unknown) => {
  if (typeof str === 'string') return !str || str.trim().length === 0;
  return false;
};

export function assembleUrl(parts: string[]) {
  if (!Array.isArray(parts)) {
    return '';
  }
  let url = '';
  for (let i = 0, n = parts.length; i < n; i += 1) {
    const currPart = parts[i];
    if (!isEmptyString(currPart)) {
      if (!url.endsWith('/') && url.trim().length > 1) {
        url = `${url}/`;
      }
      if (currPart.startsWith('/')) {
        url = `${url}${currPart.slice(1, currPart.length)}`;
      } else {
        url = `${url}${currPart}`;
      }
    }
  }
  return url;
}

export function isNullOrUndefined(arg: any): arg is null | undefined {
  return typeof arg === 'undefined' || arg === null;
}
