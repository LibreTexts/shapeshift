import { BookPageInfo } from '../types/book';

export function isCoverpage(pageInfo: BookPageInfo): boolean;
export function isCoverpage(tags: string[]): boolean;
export function isCoverpage(input: BookPageInfo | string[]) {
  const tags = Array.isArray(input) ? input : input.tags;
  return tags?.includes('coverpage:yes') || tags?.includes('coverpage:nocommons');
}
