import { libraryNameKeysWDev } from './librariesmap';
import { ErrorWithMessage, LambdaBaseResponse } from './types';

export function generateHTTPResponse(responseBody: LambdaBaseResponse, reqOrigin?: string) {
  let allowOrigin = false;
  if (reqOrigin && reqOrigin.endsWith('.libretexts.org')) {
    allowOrigin = true;
  }
  return {
    body: JSON.stringify(responseBody),
    statusCode: responseBody.status.toString(),
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': allowOrigin ? reqOrigin : 'https://api.libretexts.org',
      'Access-Control-Allow-Headers': 'Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token',
      'Access-Control-Allow-Methods': 'POST,OPTIONS',
    },
  };
}

export const getSubdomainFromLibrary = (library: string): string | null => {
  if (libraryNameKeysWDev.includes(library)) return library;
  return null;
};

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
