import fs from 'node:fs/promises';
import { join, resolve } from 'node:path';
import axios from 'axios';
import { CXOneRateLimiter } from '../lib/cxOneRateLimiter';
import { getLicense } from '../util/licensing';
import { assembleUrl, getPathFromURL, getSubdomainFromURL, isNonNullCXOneObject, omit } from '../helpers';
import { LibraryService } from './library';
import { GetPagesResponse, PageExtended, Tags } from '@libretexts/cxone-expert-node';
import { dynamicDetailedLicensingLayout, dynamicLicensingLayout, dynamicTOCLayout } from '../util/pageConstants';
import { BookPageInfoWithContent, BookPageProperty, BookPages } from '../types/book';
import { BookMatterType, BookPageInfo, BookPrintInfo } from '../types/book';
import PageID from '../util/pageID';
import { log as logService } from '../lib/log';
import { LogLayer } from 'loglayer';
import { Environment } from '../lib/environment';

export class BookService {
  private readonly logger: LogLayer;
  private readonly logName: 'BookService';
  private readonly DEFAULT_THUMBNAILS = {
    BACK_MATTER: 'https://cdn.libretexts.net/DefaultImages/Back%20matter.jpg',
    DEFAULT: 'https://cdn.libretexts.net/DefaultImages/default.png',
    FRONT_MATTER: 'https://cdn.libretexts.net/DefaultImages/Front%20Matter.jpg',
  };

  constructor() {
    this.logName = 'BookService';
    this.logger = logService.child().withContext({ logSource: this.logName });
  }

  /**
   * Creates the default LibreTexts back matter pages (Index, Glossary, Detailed Licensing, etc.) as subpages of the given cover page.
   * Provides an overwriteExisting option to control whether to only create pages if they don't already exist, or to overwrite existing pages,
   * which is useful for ensuring the correct structure and content for PDF generation, but should be used with caution as some authors have customized their back matter pages.
   * @param param0
   */
  public async createDefaultBackMatter({
    coverPageInfo,
    overwriteExisting = false,
  }: {
    coverPageInfo: BookPageInfo;
    overwriteExisting?: boolean;
  }) {
    const lib = new LibraryService({ lib: coverPageInfo.pageID.lib });
    await lib.init();
    await CXOneRateLimiter.waitUntilAPIAvailable(2);

    const basePath = this.getMatterRootPagePath(coverPageInfo.url, 'Back');

    // Index
    await lib.api.pages.postPageContents(
      assembleUrl([basePath, '10:_Index']),
      `
        <p class="mt-script-comment">Dynamic Index</p><pre class="script">template('DynamicIndex');</pre>
        <p class="template:tag-insert"><em>Tags recommended by the template: </em><a href="#">article:topic</a><a href="#">showtoc:no</a><a href="#">printoptions:no-header</a><a href="#">columns:three</a></p>
      `,
      {
        title: 'Index',
        edittime: 'now',
        ...(overwriteExisting ? {} : { abort: 'exists' }),
      },
    );

    // Dynamic Glossary
    const chemLib = new LibraryService({ lib: 'chem' });
    await chemLib.init();
    const dynamicGlossary = (
      await chemLib.api.pages.getPageContents(279134, {
        mode: 'edit',
      })
    ).body;
    if (dynamicGlossary) {
      await lib.api.pages.postPageContents(
        assembleUrl([basePath, '20:_Glossary']),
        `
        ${dynamicGlossary}
        \n<p class="template:tag-insert"><em>Tags recommended by the template: </em><a href="#">article:topic</a><a href="#">showtoc:no</a><a href="#">printoptions:no-header</a><a href="#">columns:three</a></p>
      `,
        {
          title: 'Glossary',
          edittime: 'now',
          ...(overwriteExisting ? {} : { abort: 'exists' }),
        },
      );
    }

    // Detailed Licensing
    await lib.api.pages.postPageContents(
      assembleUrl([basePath, '30:_Detailed_Licensing']),
      dynamicDetailedLicensingLayout,
      {
        title: 'Detailed Licensing',
        edittime: 'now',
        ...(overwriteExisting ? {} : { abort: 'exists' }),
      },
    );

    // Set thumbnail
    const thumbnailRes = await axios.get(this.DEFAULT_THUMBNAILS.BACK_MATTER, {
      responseType: 'arraybuffer',
    });
    const thumbnail = Buffer.from(thumbnailRes.data);
    await lib.api.pages.putPageFileName(basePath, '=mindtouch.page%2523thumbnail', thumbnail);
  }

  /**
   * Creates the default LibreTexts front matter pages (Title Page, Info Page, Table of Contents, Licensing, etc.)
   * as subpages of the given cover page. Provides an overwriteExisting option to control whether to only create pages if they don't already exist, or to overwrite existing pages,
   * which is useful for ensuring the correct structure and content for PDF generation, but should be used with caution as some authors have customized their front matter pages.
   * @param param0
   */
  public async createDefaultFrontMatter({
    coverPageInfo,
    overwriteExisting = false,
  }: {
    coverPageInfo: BookPageInfo;
    overwriteExisting?: boolean;
  }) {
    const lib = new LibraryService({ lib: coverPageInfo.pageID.lib });
    await lib.init();
    await CXOneRateLimiter.waitUntilAPIAvailable(2);

    // TitlePage
    const QRoptions = { errorCorrectionLevel: 'L', margin: 2, scale: 2 };
    await lib.api.pages.postPageContents(
      assembleUrl([coverPageInfo.url, 'Front_Matter', '01:_TitlePage']),
      `
        <div style="height:95vh; display:flex; flex-direction: column; position: relative; align-items: center">
        <div style=" display:flex; flex:1; flex-direction: column; justify-content: center">
        <p class="mt-align-center"><span class="mt-font-size-36">${coverPageInfo.printInfo.companyName || ''}</span></p>
        <p class="mt-align-center"><span class="mt-font-size-36">${coverPageInfo.printInfo.title || ''}</span></p></div>
        <p style="position: absolute; bottom: 0; right: 0"><canvas id="canvas"></canvas></p>
        <p class="mt-align-center" style="max-width: 70%"><span class="mt-font-size-24">${coverPageInfo.printInfo.authorName || ''}</span></p>
        <script>QRCode.toCanvas(document.getElementById('canvas'), '${coverPageInfo.url}', ${JSON.stringify(QRoptions)})</script>
        <p class="template:tag-insert"><em>Tags recommended by the template: </em><a href="#">article:topic</a><a href="#">printoptions:no-header-title</a></p></div>
      `,
      {
        title: 'TitlePage',
        edittime: 'now',
        ...(overwriteExisting ? {} : { abort: 'exists' }),
      },
    );

    // InfoPage
    await lib.api.pages.postPageContents(
      assembleUrl([coverPageInfo.url, 'Front_Matter', '02:_InfoPage']),
      `
        <p class=\\"mt-script-comment\\">Cross Library Transclusion</p><pre class=\\"script\\">template('CrossTransclude/Web',{'Library':'chem','PageID':170365});</pre>
        <p class=\\"template:tag-insert\\"><em>Tags recommended by the template: </em><a href=\\"#\\">article:topic</a><a href=\\"#\\">transcluded:yes</a><a href=\\"#\\">printoptions:no-header-title</a></p>
      `,
      {
        title: 'InfoPage',
        edittime: 'now',
        ...(overwriteExisting ? {} : { abort: 'exists' }),
      },
    );

    // Table of Contents
    await lib.api.pages.postPageContents(
      assembleUrl([coverPageInfo.url, 'Front_Matter', '03:_Table_of_Contents']),
      dynamicTOCLayout,
      {
        title: 'Table of Contents',
        edittime: 'now',
        ...(overwriteExisting ? {} : { abort: 'exists' }),
      },
    );

    // Licensing
    await lib.api.pages.postPageContents(
      assembleUrl([coverPageInfo.url, 'Front_Matter', '04:_Licensing']),
      dynamicLicensingLayout,
      {
        title: 'Licensing',
        edittime: 'now',
        ...(overwriteExisting ? {} : { abort: 'exists' }),
      },
    );

    // Set thumbnail
    const thumbnailRes = await axios.get(this.DEFAULT_THUMBNAILS.FRONT_MATTER, {
      responseType: 'arraybuffer',
    });
    const thumbnail = Buffer.from(thumbnailRes.data);
    await lib.api.pages.putPageFileName(
      assembleUrl([coverPageInfo.url, 'Front_Matter']),
      '=mindtouch.page%2523thumbnail',
      thumbnail,
    );
  }

  /**
   * Creates front or back matter pages for a book based on the provided cover page information.
   * This is important for ensuring the correct structure and content for PDF generation. By default,
   * this method will only create matter pages if they are missing, to avoid overwriting any customizations made by authors.
   * However, this behavior can be overridden by setting overwriteExisting to true, which will force the creation of matter pages even if they already exist.
   * Use with caution as some authors customize their matter pages.
   * @param param0
   */
  public async createMatter({
    mode,
    coverPageInfo,
    overwriteExisting = false,
  }: {
    mode: BookMatterType;
    coverPageInfo: BookPageInfo;
    overwriteExisting?: boolean;
  }) {
    try {
      const lib = new LibraryService({ lib: coverPageInfo.pageID.lib });
      await lib.init();

      await CXOneRateLimiter.waitUntilAPIAvailable(4);

      await lib.api.pages.postPageContents(
        this.getMatterRootPagePath(coverPageInfo.url, mode),
        `<p>{{template.ShowOrg()}}</p><p class="template:tag-insert"><em>Tags recommended by the template: </em><a href="#">article:topic-guide</a></p>`,
        {
          title: `${mode} Matter`,
          edittime: 'now',
          ...(overwriteExisting ? {} : { abort: 'exists' }),
        },
      );

      this.logger.debug(
        `Created ${mode} matter page for book ${coverPageInfo.pageID.lib}/${coverPageInfo.pageID.pageNum}`,
      );

      // await Promise.all(
      //   [
      //     { property: "mindtouch.idf#guideDisplay", value: "single" },
      //     { property: "mindtouch.page#welcomeHidden", value: "true" },
      //     {
      //       property: "mindtouch#idf.guideTabs",
      //       value:
      //         '[{"templateKey":"Topic_hierarchy","templateTitle":"Topic hierarchy","templatePath":"MindTouch/IDF3/Views/Topic_hierarchy","guid":"fc488b5c-f7e1-1cad-1a9a-343d5c8641f5"}]',
      //     },
      //   ].map((p) => {
      //     this.logger.debug(
      //       `Setting property ${p.property} for ${mode} matter page of book ${coverPageInfo.pageID.lib}/${coverPageInfo.pageID.pageID}`,
      //     );
      //     return lib.api.pages.putPageProperties(
      //       this.getMatterRootPagePath(coverPageInfo.url, mode),
      //       p.property,
      //       p.value,
      //     );
      //   }),
      // );

      mode === 'Front'
        ? await this.createDefaultFrontMatter({
            overwriteExisting,
            coverPageInfo,
          })
        : await this.createDefaultBackMatter({
            overwriteExisting,
            coverPageInfo,
          });
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.logger.error(`Error creating ${mode} matter: ${errorMsg}`);
      throw error; // re-throw the error after logging it, so that the calling function can handle it appropriately (e.g. fail the job)
    }
  }

  /**
   * Checks if front/back matter pages exist in the given list of book pages, based on the presence of "Front_Matter" or "Back_Matter" in the page URLs.
   * @param pages - the flat array of BookPageInfo objects representing all pages in the book
   * @param matterType - the type of matter to check for ("Front" or "Back")
   * @returns a promise that resolves to true if the matter pages exist, false otherwise
   */
  public checkMatterExists(pages: BookPages, matterType: BookMatterType): boolean {
    // Search for a page with 'Front_Matter' or 'Back_Matter' in the URL, depending on the matterType
    const searchTerm = matterType === 'Front' ? 'Front_Matter' : 'Back_Matter';
    for (const page of pages.flat) {
      if (page.url.includes(searchTerm)) {
        return true;
      }
    }
    return false;
  }

  public getMatterRootPagePath(basePath: string, matterType: BookMatterType): string {
    const rootPage = matterType === 'Front' ? '00:Front_Matter' : 'zz:Back_Matter';
    return assembleUrl([basePath, rootPage]);
  }

  /**
   * Discovers the page tree for a given book, starting from (and including) the root page. Can return either a nested structure or a flat array of pages.
   * @param libName - the subdomain/library name
   * @param pageID - the root page ID of the book
   * @param flat - whether to return a flat array of pages or a nested structure (default: false)
   */
  public async discoverPages(libName: string, pageID: number): Promise<BookPages> {
    try {
      const lib = new LibraryService({ lib: libName });
      await lib.init();
      await CXOneRateLimiter.waitUntilAPIAvailable(2);
      const pagesRespRaw = await lib.api.pages.getPageTree(pageID);
      const pagesRaw = pagesRespRaw.page;

      const pages = await this.getPageInfo(libName, pagesRaw, lib);
      return {
        flat: this.flattenPagesObj(pages),
        tree: pages,
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.logger.error(`Error discovering pages for ${libName}/${pageID}: ${errorMsg}`);
      throw error; // re-throw the error after logging it, so that the calling function can handle it appropriately (e.g. fail the job)
    }
  }

  /**
   * Builds a list of URLs to convert for the book, in the correct order for conversion. This includes handling special cases for pages that
   * should be treated as TOC entries, as well as ensuring front/back matter are indexed correctly.
   * @param libName - the subdomain/library name
   * @param p - the page object
   * @param libService - Optional LibraryService instance to avoid re-initializing for each page. If not provided, a new instance will be created.
   * @returns a Promise that resolves to a BookPageInfo object
   */
  public async getPageInfo(libName: string, p: GetPagesResponse, libService?: LibraryService): Promise<BookPageInfo> {
    if (!libService) {
      libService = new LibraryService({ lib: libName });
      await libService.init();
    }

    await CXOneRateLimiter.waitUntilAPIAvailable(2);
    const pageDetails = await libService.api.pages.getPage(Number(p['@id']), {
      format: 'html',
      include: 'contents',
      mode: 'view',
    });
    const url = pageDetails['uri.ui']!;

    const subpagesRaw = isNonNullCXOneObject(p.subpages) ? p.subpages : null;
    const subpages = Array.isArray(subpagesRaw?.page)
      ? subpagesRaw?.page
      : typeof subpagesRaw?.page === 'object'
        ? [subpagesRaw?.page]
        : [];

    const parsedProperties = this.parseProperties(pageDetails.properties!);
    const summaryProp = parsedProperties.find((p) => p.name === 'mindtouch.page#overview');

    const parsedTags = isNonNullCXOneObject(pageDetails.tags) ? this.parseTags(pageDetails.tags!) : [];

    const authorTag = parsedTags.find((t) => t.startsWith('authorname:'))?.replace('authorname:', '');

    const printInfo = await this.resolvePrintInfo({
      authorTag,
      lib: libName,
      tags: parsedTags,
    });

    return {
      ...(authorTag && { authorTag }),
      // @ts-expect-error needs fix upstream in cxone sdk
      body: pageDetails.content?.body ?? [],
      // @ts-expect-error needs fix upstream in cxone sdk
      head: pageDetails.content?.head ?? '',
      license: getLicense(parsedTags),
      pageID: new PageID({ lib: libName, pageNum: Number(p['@id']) }),
      // FIXME: how to support non-English texts?
      ...(['Back_Matter', 'Front_Matter'].some((s) => url.includes(s)) && {
        matterType: url.includes('Back_Matter') ? 'Back' : 'Front',
      }),
      printInfo,
      properties: parsedProperties,
      subdomain: libName,
      subpages: await Promise.all(subpages.map((s) => this.getPageInfo(libName, s, libService))),
      summary: summaryProp?.value ?? '',
      // @ts-expect-error needs fix upstream in cxone sdk
      tail: pageDetails.content?.tail ?? '',
      tags: parsedTags,
      title: pageDetails.title?.trim() || '',
      url,
    };
  }

  /**
   * For a given book ID (root page ID), discovers all pages in the book and retrieves their HTML content for conversion
   * Returns an array of page content objects, each containing the full page details and its head, body, and tail HTML content segments.
   * @param coverPageID - the PageID of the book's cover page (root page)
   * @param pages - optional pre-discovered pages to use instead of discovering again. This can be used to avoid redundant discovery when we already have the page structure,
   * such as when we're creating matter pages and then need to get contents for PDF generation.
   * @returns a Promise that resolves to an array of BookPageInfoWithContent objects
   */
  public async getBookContents(coverPageID: PageID, pages: BookPageInfo[]): Promise<BookPageInfoWithContent[]> {
    try {
      const lib = new LibraryService({ lib: coverPageID.lib });
      await lib.init();

      const bookContents: BookPageInfoWithContent[] = [];
      const htmlCacheDir = Environment.getOptional('HTML_CACHE_DIR');

      if (htmlCacheDir) {
        this.logger.withMetadata({ htmlCacheDir }).info('HTML caching enabled — cache hits will skip remote API calls');
      }

      // TODO: Add error handling and retries for individual page content retrieval, so that a failure to retrieve one page doesn't cause the entire process to fail.
      for (const page of pages) {
        const cacheKey = htmlCacheDir
          ? resolve(join(htmlCacheDir, `${page.pageID.lib}-${page.pageID.pageNum}.json`))
          : null;

        let pageContent: { head?: string; body?: string | string[]; tail?: string | string[] } | null = null;

        if (cacheKey) {
          try {
            const cached = await fs.readFile(cacheKey, 'utf-8');
            pageContent = JSON.parse(cached);
            this.logger.debug(`Cache hit for page ${page.pageID.lib}/${page.pageID.pageNum}`);
          } catch {
            // Cache miss — fall through to API
          }
        }

        if (!pageContent) {
          this.logger.debug(`Retrieving content for page ${page.pageID.lib}/${page.pageID.pageNum} (${page.url})...`);
          pageContent = await lib.api.pages.getPageContents(page.pageID.pageNum, {
            mode: 'view',
            format: 'html',
          });

          if (cacheKey) {
            try {
              await fs.mkdir(htmlCacheDir!, { recursive: true });
              await fs.writeFile(cacheKey, JSON.stringify(pageContent));
              this.logger.debug(`Cached page content for ${page.pageID.lib}/${page.pageID.pageNum}`);
            } catch (err) {
              this.logger.withMetadata({ err, cacheKey }).warn('Failed to write page content to HTML cache');
            }
          }

          // Delay between requests to avoid rate limits (only when hitting the API)
          await CXOneRateLimiter.waitUntilAPIAvailable(2);
        }

        bookContents.push({
          ...page,
          head: pageContent.head || '',
          body: Array.isArray(pageContent.body) ? pageContent.body : [pageContent.body || ''],
          tail: Array.isArray(pageContent.tail) ? pageContent.tail.join('') : pageContent.tail || '',
        });
      }

      return bookContents;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.logger.error(`Error getting book contents: ${errorMsg}`);
      throw error; // re-throw the error after logging it, so that the calling function can handle it appropriately (e.g. fail the job)
    }
  }

  public async getIDFromURL(urlRaw: string): Promise<PageID | null> {
    const lib = getSubdomainFromURL(urlRaw);
    const path = getPathFromURL(urlRaw);
    const libClient = new LibraryService({ lib });
    await libClient.init();

    const page = await libClient.api.pages.getPage(path);
    if (!page) return null;
    if (Number.isNaN(Number(page['@id']))) return null;

    return new PageID({ lib, pageNum: Number(page['@id']) });
  }

  public flattenPagesObj(pagesRaw: BookPageInfo) {
    if (!pagesRaw) return [];

    const recurse = (subpages: BookPageInfo[]) => {
      const pages: BookPageInfo[] = [];
      subpages.forEach((page) => {
        pages.push(omit(page, 'subpages'));
        if (!page.subpages?.length) return;
        pages.push(...recurse(page.subpages));
      });
      return pages;
    };

    const allPages: BookPageInfo[] = [omit(pagesRaw, 'subpages')];
    if (!pagesRaw.subpages?.length) return allPages;
    allPages.push(...recurse(pagesRaw.subpages));
    return allPages;
  }

  public parseProperties(input: PageExtended['properties']): BookPageProperty[] {
    if (typeof input !== 'object' || !input?.property) return [];

    const propertiesRaw = Array.isArray(input.property) ? input.property : [input.property];
    if (!propertiesRaw.length) return [];
    return propertiesRaw.map((p) => ({
      name: p['@name'],
      value: p.contents?.['#text'] ?? '',
    }));
  }

  public parseTags(input: Tags): string[] {
    if (!input?.tag) return [];

    const tagsRaw = Array.isArray(input.tag) ? input.tag : [input.tag];
    if (!tagsRaw.length) return [];
    return tagsRaw.map((t) => t?.['@value']).filter((t): t is string => !!t);
  }

  public async resolvePrintInfo({
    authorTag,
    lib,
    tags,
  }: {
    authorTag?: string;
    lib: string;
    tags: string[];
  }): Promise<BookPrintInfo> {
    const info: BookPrintInfo = {
      attributionPrefix: '',
      authorName: '',
      companyName: '',
      programName: '',
      programURL: '',
      spineTitle: '',
      title: 'null',
    };
    for (const tagRaw of tags) {
      const tag = tagRaw.replace(/\\\\/g, '\n');
      const items = tag.startsWith('lulu@')
        ? tag.split('@')
        : tag.startsWith('lulu|')
          ? tag.split('|')
          : tag.startsWith('lulu,')
            ? tag.split(',')
            : [];
      info.title = items[1] ?? '';
      info.authorName = items[2] ?? '';
      info.companyName = items[3] ?? '';
      info.spineTitle = items[4] ?? '';
    }
    if (!info.authorName && authorTag) {
      // TODO: cache or move this
      const authorsRaw = await fetch(`https://api.libretexts.org/endpoint/getAuthors/${lib}`, {
        headers: { origin: 'shapeshift.libretexts.org' },
      });
      const authors = await authorsRaw.json();
      const author = authors?.[authorTag];
      if (author) {
        info.authorName = author.name ?? '';
        info.companyName = author.companyname ?? '';
        if (author.attributionprefix) info.attributionPrefix = author.attributionprefix;
        if (author.programname) info.programName = author.programname;
        if (author.programurl) info.programURL = author.programurl;
      }
    }
    return info;
  }
}
