import { libraryNameKeysWDev } from './librariesmap';
import { LambdaBaseResponse } from './types';

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
