import axios from 'axios';
import { CXOneRateLimiter } from '../lib/cxOneRateLimiter';
import { getLicense, LicenseInfo } from '../util/licensing';
import { assembleUrl, getPathFromURL, getSubdomainFromURL, isNonNullCXOneObject, omit } from '../helpers';
import { LibraryService } from './library';
import { GetPagesResponse, PageExtended, Tags } from '@libretexts/cxone-expert-node';
import { dynamicDetailedLicensingLayout, dynamicLicensingLayout, dynamicTOCLayout } from '../util/pageConstants';

export type BookID = {
  lib: string;
  pageID: number;
};

export type BookMatterType = 'Back' | 'Front';

export type BookPageProperty = {
  name: string;
  value: string;
};

export type BookPageInfo = {
  authorTag?: string;
  id: number;
  lib: string;
  license: LicenseInfo | null;
  matterType?: BookMatterType;
  printInfo: BookPrintInfo;
  properties: BookPageProperty[];
  subdomain: string;
  subpages?: BookPageInfo[];
  summary?: string;
  tags: string[];
  title: string;
  url: string;
};

export type BookPrintInfo = {
  attributionPrefix: string;
  authorName: string;
  companyName: string;
  programName: string;
  programURL: string;
  spineTitle: string;
  title: string;
};

export class BookService {
  private readonly DEFAULT_THUMBNAILS = {
    BACK_MATTER: 'https://cdn.libretexts.net/DefaultImages/Back%20matter.jpg',
    DEFAULT: 'https://cdn.libretexts.net/DefaultImages/default.png',
    FRONT_MATTER: 'https://cdn.libretexts.net/DefaultImages/Front%20Matter.jpg',
  };

  public async createDefaultBackMatter({ createOnly, pageInfo }: { createOnly?: boolean; pageInfo: BookPageInfo }) {
    const lib = new LibraryService({ lib: pageInfo.lib });
    await lib.init();
    await CXOneRateLimiter.waitUntilAPIAvailable(2);

    // Index
    await lib.api.pages.postPageContents(
      assembleUrl([pageInfo.url, 'Back_Matter', '10:_Index']),
      { auth: lib.auth },
      `
        <p class="mt-script-comment">Dynamic Index</p><pre class="script">template('DynamicIndex');</pre>
        <p class="template:tag-insert"><em>Tags recommended by the template: </em><a href="#">article:topic</a><a href="#">showtoc:no</a><a href="#">printoptions:no-header</a><a href="#">columns:three</a></p>
      `,
      {
        title: 'Index',
        edittime: 'now',
        ...(!createOnly && { abort: 'exists' }),
      },
    );

    // Dynamic Glossary
    const chemLib = new LibraryService({ lib: 'chem' });
    await chemLib.init();
    const dynamicGlossary = (await chemLib.api.pages.getPageContents(279134, { auth: chemLib.auth }, { mode: 'edit' }))
      .body;
    if (dynamicGlossary) {
      await lib.api.pages.postPageContents(
        assembleUrl([pageInfo.url, 'Back_Matter', '20:_Glossary']),
        { auth: lib.auth },
        `
        ${dynamicGlossary}
        \n<p class="template:tag-insert"><em>Tags recommended by the template: </em><a href="#">article:topic</a><a href="#">showtoc:no</a><a href="#">printoptions:no-header</a><a href="#">columns:three</a></p>
      `,
        {
          title: 'Glossary',
          edittime: 'now',
          ...(!createOnly && { abort: 'exists' }),
        },
      );
    }

    // Detailed Licensing
    await lib.api.pages.postPageContents(
      assembleUrl([pageInfo.url, 'Back_Matter', '30:_Detailed_Licensing']),
      { auth: lib.auth },
      dynamicDetailedLicensingLayout,
      {
        title: 'Detailed Licensing',
        edittime: 'now',
        ...(!createOnly && { abort: 'exists' }),
      },
    );

    // Set thumbnail
    const thumbnailRes = await axios.get(this.DEFAULT_THUMBNAILS.BACK_MATTER, { responseType: 'arraybuffer' });
    const thumbnail = Buffer.from(thumbnailRes.data);
    await lib.api.pages.putPageFileName(
      assembleUrl([pageInfo.url, 'Back_Matter']),
      '=mindtouch.page%2523thumbnail',
      thumbnail,
      { auth: lib.auth },
    );
  }

  public async createDefaultFrontMatter({ createOnly, pageInfo }: { createOnly?: boolean; pageInfo: BookPageInfo }) {
    const lib = new LibraryService({ lib: pageInfo.lib });
    await lib.init();
    await CXOneRateLimiter.waitUntilAPIAvailable(2);

    // TitlePage
    const QRoptions = { errorCorrectionLevel: 'L', margin: 2, scale: 2 };
    await lib.api.pages.postPageContents(
      assembleUrl([pageInfo.url, 'Front_Matter', '01:_TitlePage']),
      { auth: lib.auth },
      `
        <div style="height:95vh; display:flex; flex-direction: column; position: relative; align-items: center">
        <div style=" display:flex; flex:1; flex-direction: column; justify-content: center">
        <p class="mt-align-center"><span class="mt-font-size-36">${pageInfo.printInfo.companyName || ''}</span></p>
        <p class="mt-align-center"><span class="mt-font-size-36">${pageInfo.printInfo.title || ''}</span></p></div>
        <p style="position: absolute; bottom: 0; right: 0"><canvas id="canvas"></canvas></p>
        <p class="mt-align-center" style="max-width: 70%"><span class="mt-font-size-24">${pageInfo.printInfo.authorName || ''}</span></p>
        <script>QRCode.toCanvas(document.getElementById('canvas'), '${pageInfo.url}', ${JSON.stringify(QRoptions)})</script>
        <p class="template:tag-insert"><em>Tags recommended by the template: </em><a href="#">article:topic</a><a href="#">printoptions:no-header-title</a></p></div>
      `,
      {
        title: 'TitlePage',
        edittime: 'now',
        ...(!createOnly && { abort: 'exists' }),
      },
    );

    // InfoPage
    await lib.api.pages.postPageContents(
      assembleUrl([pageInfo.url, 'Front_Matter', '02:_InfoPage']),
      { auth: lib.auth },
      `
        <p class=\\"mt-script-comment\\">Cross Library Transclusion</p><pre class=\\"script\\">template('CrossTransclude/Web',{'Library':'chem','PageID':170365});</pre>
        <p class=\\"template:tag-insert\\"><em>Tags recommended by the template: </em><a href=\\"#\\">article:topic</a><a href=\\"#\\">transcluded:yes</a><a href=\\"#\\">printoptions:no-header-title</a></p>
      `,
      {
        title: 'InfoPage',
        edittime: 'now',
        ...(!createOnly && { abort: 'exists' }),
      },
    );

    // Table of Contents
    await lib.api.pages.postPageContents(
      assembleUrl([pageInfo.url, 'Front_Matter', '03:_Table_of_Contents']),
      { auth: lib.auth },
      dynamicTOCLayout,
      {
        title: 'Table of Contents',
        edittime: 'now',
        ...(!createOnly && { abort: 'exists' }),
      },
    );

    // Licensing
    await lib.api.pages.postPageContents(
      assembleUrl([pageInfo.url, 'Front_Matter', '04:_Licensing']),
      { auth: lib.auth },
      dynamicLicensingLayout,
      {
        title: 'Licensing',
        edittime: 'now',
        ...(!createOnly && { abort: 'exists' }),
      },
    );

    // Set thumbnail
    const thumbnailRes = await axios.get(this.DEFAULT_THUMBNAILS.FRONT_MATTER, { responseType: 'arraybuffer' });
    const thumbnail = Buffer.from(thumbnailRes.data);
    await lib.api.pages.putPageFileName(
      assembleUrl([pageInfo.url, 'Front_Matter']),
      '=mindtouch.page%2523thumbnail',
      thumbnail,
      { auth: lib.auth },
    );
  }

  public async createMatter({
    createOnly,
    mode,
    pageInfo,
  }: {
    createOnly?: boolean;
    mode: BookMatterType;
    pageInfo: BookPageInfo;
  }) {
    const lib = new LibraryService({ lib: pageInfo.lib });
    await lib.init();
    await CXOneRateLimiter.waitUntilAPIAvailable(4);
    await lib.api.pages.postPageContents(
      pageInfo.id,
      { auth: lib.auth },
      `<p>{{template.ShowOrg()}}</p><p class="template:tag-insert"><em>Tags recommended by the template: </em><a href="#">article:topic-guide</a></p>`,
      {
        title: `${mode} Matter`,
        edittime: 'now',
        ...(!createOnly && { abort: 'exists' }),
      },
    );
    await Promise.all(
      [
        { property: 'mindtouch.idf#guideDisplay', value: 'single' },
        { property: 'mindtouch.page#welcomeHidden', value: 'true' },
        {
          property: 'mindtouch#idf.guideTabs',
          value:
            '[{"templateKey":"Topic_hierarchy","templateTitle":"Topic hierarchy","templatePath":"MindTouch/IDF3/Views/Topic_hierarchy","guid":"fc488b5c-f7e1-1cad-1a9a-343d5c8641f5"}]',
        },
      ].map((p) => lib.api.pages.putPageProperties(pageInfo.id, p.property, p.value, { auth: lib.auth })),
    );
    mode === 'Front'
      ? await this.createDefaultFrontMatter({ createOnly, pageInfo })
      : await this.createDefaultBackMatter({ createOnly, pageInfo });
  }

  public async discoverPages(libName: string, pageID: number, flat: true): Promise<BookPageInfo[]>;
  public async discoverPages(libName: string, pageID: number, flat?: false): Promise<BookPageInfo>;
  public async discoverPages(
    libName: string,
    pageID: number,
    flat: boolean | undefined,
  ): Promise<BookPageInfo | BookPageInfo[] | null> {
    const lib = new LibraryService({ lib: libName });
    await lib.init();
    await CXOneRateLimiter.waitUntilAPIAvailable(2);
    const pagesRespRaw = await lib.api.pages.getPageTree(pageID, { auth: lib.auth });
    const pagesRaw = pagesRespRaw.page;

    const getPageInfo = async (p: GetPagesResponse): Promise<BookPageInfo> => {
      await CXOneRateLimiter.waitUntilAPIAvailable(2);
      const pageDetails = await lib.api.pages.getPage(Number(p['@id']), { auth: lib.auth });
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
        id: Number(p['@id']),
        lib: libName,
        license: getLicense(parsedTags),
        // FIXME: how to support non-English texts?
        ...(['Back_Matter', 'Front_Matter'].some((s) => url.includes(s)) && {
          matterType: url.includes('Back_Matter') ? 'Back' : 'Front',
        }),
        printInfo,
        properties: parsedProperties,
        subdomain: libName,
        subpages: await Promise.all(subpages.map((s) => getPageInfo(s))),
        summary: summaryProp?.value ?? '',
        tags: parsedTags,
        title: pageDetails.title?.trim() || '',
        url,
      };
    };
    const pages = await getPageInfo(pagesRaw);
    return flat ? this.flattenPagesObj(pages) : pages;
  }

  public async getIDFromURL(urlRaw: string): Promise<BookID | null> {
    const lib = getSubdomainFromURL(urlRaw);
    const path = getPathFromURL(urlRaw);
    const libClient = new LibraryService({ lib });
    await libClient.init();

    const page = await libClient.api.pages.getPage(path, { auth: libClient.auth });
    if (!page) return null;
    if (Number.isNaN(Number(page['@id']))) return null;

    return {
      lib,
      pageID: Number(page['@id']),
    };
  }

  private flattenPagesObj(pagesRaw: BookPageInfo) {
    if (!pagesRaw) return null;

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
