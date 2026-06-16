import { LogLayer } from 'loglayer';
import { log as logService } from '../lib/log';
import axios from 'axios';
import PageID from '../util/pageID';
import { BookService } from './book';
import { Environment } from '../lib/environment';

export class LegacyAPIService {
  private readonly logger: LogLayer;
  private readonly logName: 'LegacyAPIService';

  constructor() {
    this.logName = 'LegacyAPIService';
    this.logger = logService.child().withContext({ logSource: this.logName });
  }

  async updateBookInfo({ bookID, pageCount }: { bookID: PageID; pageCount: number }) {
    try {
      if (!Environment.getOptional('LEGACY_API_KEY')) {
        this.logger.warn('LEGACY_API_KEY is not set. Skipping legacy API update.');
        return;
      }

      this.logger.info(`Updating book info for book ID: ${bookID.toString()}`);

      const bookService = new BookService();
      const coverPageInfo = await bookService.getPageInfo(bookID.lib, { '@id': bookID.pageNum.toString() });

      if (!coverPageInfo?.pageID) {
        this.logger.error(`Failed to retrieve cover page info for book ID: ${bookID.toString()}`);
        return;
      }

      const subdomain = bookID.lib;
      const path = coverPageInfo.url.replace(`https://${subdomain}.libretexts.org/`, '');

      const authorAndInstitution = await this.processTagsForLegacyInfo(coverPageInfo.tags, subdomain);

      const bookInfo = {
        title: coverPageInfo.title,
        author: authorAndInstitution?.author || '',
        zipFileName: bookID.toString(),
        institution: authorAndInstitution?.institution || '',
        link: coverPageInfo.url,
        tags: coverPageInfo.tags,
        summary: coverPageInfo.summary,
        failed: false,
        numPages: pageCount,
        lastModified: new Date().toISOString(),
        isShapeshiftConversion: true,
      };

      await axios.put(
        'https://api.libretexts.org/endpoint/refreshListAdd',
        {
          subdomain,
          path: path.match(/^.*?(?=\/)/)?.[0] || path, // extract the first segment of the path as
          identifier: Environment.getOptional('LEGACY_API_KEY') || 'unknown_key',
          content: bookInfo,
        },
        {
          headers: {
            origin: 'print.libretexts.org',
          },
        },
      );
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.logger.error(`Failed to update book info for book ID: ${bookID.toString()}. Error: ${errorMsg}`);
    }
  }

  private async processTagsForLegacyInfo(
    tags: string[] | undefined,
    subdomain: string,
  ): Promise<
    | {
        author: string;
        institution: string;
      }
    | undefined
  > {
    if (!tags) return undefined;

    let author = '';
    let institution = '';

    for (let i = 0; i < tags?.length; i++) {
      let tag = tags[i];
      let items;
      if (tag) tag = tag.replace(/\\\\/g, '\n');
      if (tag.startsWith('lulu@')) {
        items = tag.split('@');
      } else if (tag.startsWith('lulu|')) {
        items = tag.split('|');
      } else if (tag.startsWith('lulu,')) {
        items = tag.split(',');
      }

      if (items) {
        // if (items[1])
        //   current.title = items[1];
        if (items[2]) author = items[2];
        if (items[3]) institution = items[3];
        // if (items[4])
        //   current.spineTitle = items[4];
      } else if (tag.startsWith('authorname:')) {
        const authorTag = tag.replace('authorname:', '');

        if (!author) {
          // if (typeof getInformation.libreAuthors === 'undefined')
          //   getInformation.libreAuthors = {};
          // if (!getInformation.libreAuthors[current.subdomain]) {
          //   let authors = await fetch(`https://api.libretexts.org/endpoint/getAuthors/${current.subdomain}`, { headers: { 'origin': 'print.libretexts.org' } });
          //   getInformation.libreAuthors[current.subdomain] = await authors.json();
          // }

          const authorsData = await axios.get(`https://api.libretexts.org/endpoint/getAuthors/${subdomain}`, {
            headers: {
              origin: 'print.libretexts.org',
            },
          });
          const authors = authorsData.data;

          // let information = getInformation.libreAuthors[current.subdomain][current.authorTag];
          // if (information) {
          //   Object.assign(current, information);
          // }

          if (authors[authorTag]) {
            author = authors[authorTag].name || '';
            institution = authors[authorTag].institution || '';
          }
        }
      }
    }

    return { author, institution };
  }
}
