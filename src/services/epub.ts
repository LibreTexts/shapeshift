import { LogLayer } from 'loglayer';
import { log as logService } from '../lib/log';
import { StorageService } from '../lib/storageService';
import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { BookPageInfo, BookPages } from '../types/book';
import { Environment } from '../lib/environment';
import { resolve } from 'node:path';
import { v4 as uuid } from 'uuid';
import { XMLBuilder } from 'fast-xml-parser';
import Archiver from 'archiver';
import * as cheerio from 'cheerio';
import { runBatchedPromises } from '../util/util';
import axios, { AxiosError } from 'axios';
import mime from 'mime';
import beautify from 'js-beautify';
import { decode } from 'html-entities';
import PageID from '../util/pageID';
import { PassThrough } from 'node:stream';
import { Upload } from '@aws-sdk/lib-storage';

type BookPageInfoForEPUB = BookPageInfo & {
  sectionId: string;
};

export class EPUBService {
  private readonly logger: LogLayer;
  private readonly logName = 'EPUBService';
  private readonly noVisibleTitlePages = ['_InfoPage', '_ProgramInfo'];
  private readonly storageService: StorageService;
  private readonly titleOverridePages = [
    { urlEnd: '_InfoPage', title: 'About LibreTexts' },
    { urlEnd: '_ProgramInfo', title: 'Program Information' },
  ];

  constructor() {
    this.logger = logService.child().withContext({ logSource: this.logName });
    this.storageService = new StorageService();
  }

  private cleanPagesListForProcessing(inputPages: BookPageInfo[]): BookPageInfo[] {
    const denyEndsWith = ['_Front_Matter', '_Back_Matter', '_TitlePage'];
    const filtered = structuredClone(inputPages).filter((page) => !denyEndsWith.some((e) => page.url.endsWith(e)));
    return filtered.map((f) => {
      const foundOverride = this.titleOverridePages.find((o) => f.url.endsWith(o.urlEnd));
      if (foundOverride) {
        f.title = foundOverride.title;
      }
      return f;
    });
  }

  private async cleanupTempFiles(bookID: PageID): Promise<void> {
    const tmpDir = Environment.getOptional('TMP_OUT_DIR', './.tmp');
    const workdirPath = resolve(`${tmpDir}/epub/${bookID.toString()}/workdir`);
    this.logger.withMetadata({ workdirPath }).info('Cleaning up workdir');

    try {
      await fs.rm(workdirPath, { recursive: true, force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.logger.withMetadata({ error, workdirPath }).warn('Error deleting workdir');
      }
    }
  }

  public async convertBook(pagesInput: BookPages, opt?: { useLocalStorage?: boolean }) {
    if (!pagesInput?.flat?.length) return null;
    const { flat: pagesRaw } = pagesInput;
    const coverPage = pagesRaw[0];
    const bookID = coverPage.pageID;
    const xmlBuilder = new XMLBuilder({ attributeNamePrefix: '$', ignoreAttributes: false });
    const pages: BookPageInfoForEPUB[] = this.cleanPagesListForProcessing(pagesRaw).map((p, i) => ({
      ...p,
      sectionId: `section${`${i + 1}`.padStart(4, '0')}`,
    }));
    const today = new Date();
    const uniqueIdentifier = `${bookID.toString()}_${today.getUTCFullYear()}-${today.getUTCMonth() + 1}-${today.getUTCDate()}`;
    const title = coverPage.printInfo.title || coverPage.title || 'Unknown';
    const author = coverPage.printInfo.authorName || 'Unknown';
    const language = 'en'; // TODO: multi-language support
    const modifiedDate = today.toISOString();
    const { images, pages: writtenPages } = await this.processContentPages({ bookID, pages: pages.slice(1) });
    const containerXMLDataStr = xmlBuilder.build({
      container: {
        $version: '1.0',
        $xmlns: 'urn:oasis:names:tc:opendocument:xmlns:container',
        rootfiles: {
          rootfile: {
            '$full-path': 'OEBPS/content.opf',
            '$media-type': 'application/oebps-package+xml',
          },
        },
      },
    });
    const opfXMLDataStr = xmlBuilder.build({
      '?xml': {
        $version: '1.0',
        $encoding: 'UTF-8',
      },
      package: {
        $version: '3.0',
        $xmlns: 'http://www.idpf.org/2007/opf',
        '$xml:lang': 'en', // TODO: multi-language support
        '$xmlns:dc': 'http://purl.org/dc/elements/1.1/',
        '$xmlns:dcterms': 'http://purl.org/dc/terms/',
        '$xmlns:opf': 'http://www.idpf.org/2007/opf',
        '$unique-identifier': uniqueIdentifier,
        metadata: {
          '$xmlns:dc': 'http://purl.org/dc/elements/1.1/',
          'dc:identifier': {
            $id: uniqueIdentifier,
            '#text': uniqueIdentifier,
          },
          'dc:title': title,
          'dc:creator': author,
          'dc:language': language,
          meta: [
            {
              '#text': `${modifiedDate.split('.')[0]}Z`,
              $property: 'dcterms:modified',
            },
            {
              $name: 'generator',
              $content: 'LibreTexts Shapeshift',
            },
            // TODO: try to detect these properties automatically (e.g., remove 'visual' if no images)
            ...['textual', 'visual'].map((m) => ({
              '#text': m,
              $property: 'schema:accessMode',
            })),
            ...['textual', 'visual'].map((m) => ({
              '#text': m,
              $property: 'schema:accessModeSufficient',
            })),
            ...['displayTransformability', 'tableOfContents'].map((m) => ({
              '#text': m,
              $property: 'schema:accessibilityFeature',
            })),
            ...['unknown'].map((m) => ({
              '#text': m,
              $property: 'schema:accessibilityHazard',
            })),
          ],
        },
        manifest: {
          item: [
            ...(writtenPages ?? []).map((p) => {
              return {
                $id: p.sectionId,
                '$media-type': 'application/xhtml+xml',
                $href: `sections/${p.sectionId}.xhtml`,
              };
            }),
            ...images.map((meta) => ({
              $id: meta.uuid,
              $href: `images/${meta.fileName}`,
              '$media-type': meta.mimeType,
            })),
            {
              $id: 'nav',
              '$media-type': 'application/xhtml+xml',
              $href: 'nav.xhtml',
              $properties: 'nav',
            },
            {
              $id: 'global-styles',
              '$media-type': 'text/css',
              $href: 'stylesheets/global.css',
            },
          ],
        },
        spine: {
          itemref: (writtenPages ?? []).map((p) => ({ $idref: p.sectionId })),
        },
      },
    });
    // TODO: multi-language support (html lang element)
    const navHTML = `
      <!DOCTYPE html>
      <html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="en" lang="en">
      <head>
        <title>Table of Contents</title>
        <meta http-equiv="default-style" content="text/html; charset=utf-8"/>
      </head>
      <body>
        <nav epub:type="toc">
          <h1>Table of Contents</h1>
          <ol epub:type="list">
            ${(writtenPages ?? []).map((p) => `<li><a href="sections/${p.sectionId}.xhtml">${p.title}</a></li>`).join('\n')}
          </ol>
        </nav>
      </body>
      </html>
    `;
    // TODO: make this a checked-in file and just copy to workdir
    const globalStylesCSS = `
      .visually-hidden {
          position: absolute;
          width: 1px;
          height: 1px;
          padding: 0;
          margin: -1px;
          overflow: hidden;
          clip: rect(0, 0, 0, 0);
          border: 0;
      }
    `;
    await Promise.all([
      this.writeTemporaryFile({
        bookID,
        content: Buffer.from(containerXMLDataStr, 'utf-8'),
        fileName: 'META-INF/container.xml',
      }),
      this.writeTemporaryFile({
        bookID,
        content: Buffer.from(beautify.html(navHTML, { extra_liners: [] }), 'utf-8'),
        fileName: 'OEBPS/nav.xhtml',
      }),
      this.writeTemporaryFile({
        bookID,
        content: Buffer.from(opfXMLDataStr, 'utf-8'),
        fileName: 'OEBPS/content.opf',
      }),
      this.writeTemporaryFile({
        bookID,
        content: Buffer.from(globalStylesCSS, 'utf-8'),
        fileName: 'OEBPS/stylesheets/global.css',
      }),
    ]);
    const outputPath = await this.writeFinalOutputFile({ bookID, useLocalStorage: opt?.useLocalStorage });
    await this.cleanupTempFiles(bookID);
    return outputPath;
  }

  private async processContentPages({ bookID, pages }: { bookID: PageID; pages: BookPageInfoForEPUB[] }) {
    if (!pages.length) return { images: [], pages: [] };
    const imageURLToMeta = new Map<string, { data: Buffer; fileName: string; mimeType: string; uuid: string }>();
    const pagesToWrite: { htmlContent: string; sectionId: string }[] = [];
    const calcPageIndexPrefix = (title: string) => {
      let prefix: string;
      const pageTitleClean = title.replace('"', '\\"').trim();
      if (pageTitleClean.includes(':')) {
        prefix = pageTitleClean.split(':')[0].trim();
        if (prefix.includes('.')) {
          const splitPrefix = prefix.split('.');
          prefix = splitPrefix.map((int) => (int.includes('0') ? parseInt(int, 10) : int)).join('.');
        }
        prefix += '.';
      } else {
        prefix = '';
      }
      return prefix.trim();
    };
    const buildFQFilePath = (fileName: string) => `../images/${fileName}`;

    const pageLinksToSectionIds = pages.reduce((acc, p) => acc.set(p.url, p.sectionId), new Map<string, string>());
    for (const { pageID, ...page } of pages) {
      this.logger.withMetadata({ pageID }).debug('Processing page');
      if (!page?.body?.length) continue;
      const subdomain = pageID.lib;
      const pageIndexPrefix = calcPageIndexPrefix(page.title);
      const rawContent = page.body[0];
      const decodedContentRaw = decode(rawContent.replaceAll(/&quot;/g, 'QUOT_REPL'), { level: 'html5' }).replace(
        /QUOT_REPL/g,
        '&quot;',
      );
      let pageIndexUsageCount = 1;
      const decodedContent = decodedContentRaw.replaceAll(
        /\\\(\\PageIndex{\d+}\\\)/g,
        () => `${pageIndexPrefix}${pageIndexUsageCount++}`,
      );
      const $ = cheerio.load(decodedContent, { xml: true });

      // <image processing>
      const imgElements = $('img');
      for (const elementRaw of imgElements) {
        const element = $(elementRaw);
        const imageSrc = element.attr('src');
        if (!imageSrc) continue;
        try {
          const fqImageSrc = /^https?:\/\//.test(imageSrc)
            ? imageSrc.replace(/^http:\/\//, 'https://')
            : `https://${subdomain}.libretexts.org/${imageSrc.replace(/^\//, '')}`;
          const fqImageURLRaw = new URL(fqImageSrc);
          const searchParams = fqImageURLRaw.searchParams;
          Object.keys(searchParams).forEach((key) => searchParams.delete(key));
          const fqImageURL = fqImageURLRaw.toString();
          const existDownload = imageURLToMeta.get(fqImageURL);
          if (existDownload) {
            element.attr('src', buildFQFilePath(existDownload.fileName));
            continue;
          }

          // <download image, store metadata, and replace URL>
          const imageResp = await axios.get(fqImageURL, {
            responseType: 'arraybuffer',
            headers: { 'User-Agent': 'Shapeshift/1.0 (https://libretexts.org; info@libretexts.org)' },
          });
          const imageData = Buffer.from(imageResp.data, 'binary');
          const mimeType = imageResp.headers['content-type'] as string | undefined;
          const extension = mimeType ? mime.getExtension(mimeType) : null;
          const imageUUID = `image-${uuid()}`;
          const fileName = `${imageUUID}${extension ? `.${extension}` : ''}`;
          imageURLToMeta.set(fqImageURL, {
            data: imageData,
            fileName,
            mimeType: mimeType || 'application/octet-stream',
            uuid: imageUUID,
          });
          element.attr('src', buildFQFilePath(fileName));
          // </download image, store metadata, and replace URL>
        } catch (err) {
          this.logger
            .withError(err)
            .withMetadata({
              bookID,
              pageID,
              imageSrc,
              ...(err instanceof AxiosError && { response: err.response }),
            })
            .error('Failed to process referenced image from HTML.');
        }
      }
      // </image processing>

      // <general element cleanup>
      const scriptElements = $('script');
      for (const elementRaw of scriptElements) {
        const element = $(elementRaw);
        element.remove();
      }
      const linkElements = $('a');
      for (const elementRaw of linkElements) {
        const element = $(elementRaw);
        const href = element.attr('href');
        if (!href) {
          this.logger.withMetadata({ pageID }).warn('Found link (<a>) element without href attr');
          continue;
        }
        const sectionIdEntry = pageLinksToSectionIds.get(href);
        if (!sectionIdEntry) continue;
        element.attr('href', `${sectionIdEntry}.xhtml`);
      }
      const allElements = $('*');
      for (const elementRaw of allElements) {
        const element = $(elementRaw);
        if (element.attr('mt-section-origin') !== undefined) {
          element.removeAttr('mt-section-origin');
        }
      }
      // </general element cleanup>

      const isHideTitle = this.noVisibleTitlePages.some((v) => page.url.endsWith(v));
      const htmlContent = `
        <!DOCTYPE html>
        <html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="en" lang="en">
          <head>
            <meta charset="UTF-8"/>
            <title>${page.title}</title>
            <link rel="stylesheet" type="text/css" href="../stylesheets/global.css" />
          </head>
          <body>
            <h1 id="${page.sectionId}"${isHideTitle ? 'class="visually-hidden"' : ''}>${page.title}</h1>
            ${$.html()}
          </body>
        </html>
      `;
      pagesToWrite.push({
        htmlContent: beautify.html(htmlContent, { extra_liners: [] }),
        sectionId: page.sectionId,
      });
      this.logger.withMetadata({ pageID }).debug('Finished processing page');
    }

    await runBatchedPromises(
      Array.from(imageURLToMeta.entries()).map(async ([, meta]) => {
        await this.writeTemporaryFile({
          bookID,
          content: meta.data,
          fileName: `OEBPS/images/${meta.fileName}`,
        });
      }),
      5,
    );
    await runBatchedPromises(
      pagesToWrite.map(async (meta) =>
        this.writeTemporaryFile({
          bookID,
          content: Buffer.from(meta.htmlContent, 'utf-8'),
          fileName: `OEBPS/sections/${meta.sectionId}.xhtml`,
        }),
      ),
      5,
    );
    return {
      images: Array.from(imageURLToMeta.values()).map(({ fileName, mimeType, uuid }) => ({ fileName, mimeType, uuid })),
      pages: pagesToWrite
        .map((p) => pages.find((p2) => p2.sectionId === p.sectionId))
        .filter((p): p is BookPageInfoForEPUB => !!p),
    };
  }

  private async writeFinalOutputFile({ bookID, useLocalStorage }: { bookID: PageID; useLocalStorage?: boolean }) {
    const baseDir = Environment.getOptional('TMP_OUT_DIR', './.tmp');
    const baseDirPath = `${baseDir}/epub/${bookID.toString()}`;
    const workdirPath = `${baseDirPath}/workdir`;

    const outputPath = `${baseDirPath}/${bookID.toString()}.epub`;
    const output = !useLocalStorage ? new PassThrough() : createWriteStream(outputPath);
    output.on('close', () => {
      this.logger.withMetadata({ bookID }).info('EPUB output write stream closed.');
    });
    const archive = Archiver('zip', { zlib: { level: 9 } });
    archive.on('error', (err) => {
      this.logger.withError(err).error('Encounted an error preparing final EPUB output.');
      output.destroy(err);
    });
    archive.pipe(output);

    let uploader: Upload | undefined;
    if (!useLocalStorage) {
      uploader = this.storageService.createStreamUploader({
        contentType: 'application/epub+zip',
        key: 'test',
        stream: output as PassThrough,
      });
    }

    // <write files in necessary sequence>
    archive.append(Buffer.from('application/epub+zip', 'utf-8'), { name: 'mimetype' });
    archive.append(`${workdirPath}/nav.xhtml`, { name: 'nav.xhtml' });
    archive.directory(`${workdirPath}/META-INF`, 'META-INF');
    archive.directory(`${workdirPath}/OEBPS`, 'OEBPS');
    // </write files in necessary sequence>

    if (!useLocalStorage) {
      // WARN: don't actually await here: can cause deadlock with storage service streaming upload
      archive.finalize();
    } else {
      await archive.finalize();
    }
    this.logger.withMetadata({ bookID }).info('Uploading EPUB to storage service...');
    if (!useLocalStorage) {
      await uploader?.done();
    }
    this.logger.withMetadata({ bookID }).info('Finished upload EPUB to storage service.');
    this.logger.withMetadata({ bookID }).info('Finished writing EPUB output.');
    return outputPath;
  }

  private async writeTemporaryFile({
    bookID,
    content,
    fileName,
  }: {
    bookID: PageID;
    content: Buffer;
    fileName: string;
  }) {
    const baseDir = Environment.getOptional('TMP_OUT_DIR', './.tmp');
    const baseDirPath = `${baseDir}/epub/${bookID.toString()}/workdir`;
    const filePath = `${baseDirPath}/${fileName}`;
    const dirPath = filePath.split('/').slice(0, -1).join('/');
    await fs.mkdir(dirPath, { recursive: true });
    await fs.writeFile(filePath, content, 'utf-8');
    return filePath;
  }
}
