import { log as logService } from '../lib/log';
import { LogLayer } from 'loglayer';
import { BookPageInfo, BookPages } from '../types/book';
import { resolve } from 'node:path';
import fs from 'node:fs/promises';
import formatXml from 'xml-formatter';
import { Environment } from '../lib/environment';
import PageID from '../util/pageID';
import { PassThrough } from 'node:stream';
import { createWriteStream } from 'node:fs';
import Archiver from 'archiver';
import { Upload } from '@aws-sdk/lib-storage';
import { StorageService } from '../lib/storageService';

type ThinCCTopicPageData = { title: string; url: string };

type ThinCCPageData = { title: string; resources: ThinCCTopicPageData[] };

type ThinCCXMLEntry = {
  data: string;
  path: string;
};

export class ThinCCService {
  private readonly logger: LogLayer;
  private readonly logName = 'ThinCCService';
  private readonly storageService: StorageService;

  constructor() {
    this.logger = logService.child().withContext({ logSource: this.logName });
    this.storageService = new StorageService();
  }

  private getTopicPages(pageInfo: BookPageInfo) {
    if (!Array.isArray(pageInfo.subpages) || !pageInfo.subpages?.length) return [];
    let results: ThinCCTopicPageData[] = [];
    for (const subpage of pageInfo.subpages) {
      results.push({ title: subpage.title, url: `${subpage.url}?contentOnly` });
      results = results.concat(this.getTopicPages(subpage));
    }
    return results.filter((r) => r.title);
  }

  private getPages(pageInfo: BookPageInfo) {
    const subPages = Array.isArray(pageInfo.subpages)
      ? pageInfo.subpages.filter((s) => !s.matterType && s.title !== 'Front Matter' && s.title !== 'Back Matter')
      : [];
    let result: ThinCCPageData[] = [];
    if (!subPages.length) {
      return [
        {
          title: pageInfo.title,
          resources: [
            {
              title: pageInfo.title,
              url: `${pageInfo.url}?contentOnly`,
            },
          ],
        },
      ];
    }
    const hasChildren = subPages.some((s) => Array.isArray(s.subpages) && s.subpages.length);
    if (hasChildren && pageInfo.tags.includes('article:topic-category')) {
      for (const subpage of subPages) {
        result = result.concat(this.getPages(subpage));
      }
      return result;
    }
    // found a guide
    const resources = this.getTopicPages(pageInfo);
    return [{ title: pageInfo.title, resources }];
  }

  private escapeTitle(unsafe: string) {
    return unsafe.replace(/[<>&'"]/g, function (c) {
      switch (c) {
        case '<':
          return '&lt;';
        case '>':
          return '&gt;';
        case '&':
          return '&amp;';
        case `'`:
          return '&apos;';
        case '"':
          return '&quot;';
        default:
          return c;
      }
    });
  }

  public async convertBook(pagesInput: BookPages, opt?: { useLocalStorage?: boolean }) {
    if (!pagesInput?.flat?.length) return null;
    const { flat: pagesFlat, tree: pagesTree } = pagesInput;
    const coverPage = pagesFlat[0];
    const bookID = coverPage.pageID;

    this.logger.withMetadata({ bookID }).info('Starting ThinCC conversion.');
    const pages = this.getPages(pagesTree);
    const { org, resources, resourceXMLEntries: xmlEntries } = this.generateOrgAndResources(pages);
    const manifest = this.generateXML({ org, pageInfo: coverPage, resources });
    const outPath = await this.writeFinalOutputFile({
      bookID,
      manifest,
      xmlEntries,
      useLocalStorage: opt?.useLocalStorage,
    });
    this.logger.withMetadata({ bookID }).info('Finished ThinCC conversion.');
    return outPath;
  }

  private async generateFinalOutputFileName({
    bookID,
    outFileNameOverride,
  }: {
    bookID: PageID;
    outFileNameOverride?: string;
  }) {
    const tmpDir = Environment.getOptional('TMP_OUT_DIR', './.tmp');
    const dirPath = resolve(`${tmpDir}/out/${bookID.lib}-${bookID.pageNum}`);
    const fileName = outFileNameOverride ?? bookID.toString();
    const filePath = `${dirPath}/${fileName}.imscc`;
    await fs.mkdir(dirPath, { recursive: true });
    return filePath;
  }

  private generateOrgAndResources(pages: ThinCCPageData[]) {
    if (!pages?.length) return { org: '', resources: '', resourceXMLEntries: [] };
    let counter = 1;
    const getIdentifier = () => {
      const result = 'T_' + counter.toString().padStart(6, '0');
      counter++;
      return result;
    };
    const resourceXMLEntries: ThinCCXMLEntry[] = [];

    const { org, resources } = pages.reduce(
      (acc, curr) => {
        if (!curr.title || !curr.resources) return acc;
        let org = `${acc.org}<item identifier="${getIdentifier()}"><title>${this.escapeTitle(curr.title)}</title>`;
        let resources = acc.resources;
        curr.resources.forEach((r) => {
          const identifier = getIdentifier();
          org = `${org}
              <item identifier="${identifier}" identifierref="${identifier}_R">
                <title>${this.escapeTitle(r.title)}</title>
              </item>
          `;
          resources = `${resources}
            <resource identifier="${identifier}_R" type="imswl_xmlv1p1">
              <file href="${identifier}_F.xml"/>
            </resource>
          `;
          resourceXMLEntries.push({
            path: `${identifier}_F.xml`,
            data: formatXml(`
              <?xml version="1.0" encoding="UTF-8"?>
              <webLink xmlns="http://www.imsglobal.org/xsd/imsccv1p1/imswl_v1p1" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="http://www.imsglobal.org/xsd/imsccv1p1/imswl_v1p1 http://www.imsglobal.org/profile/cc/ccv1p1/ccv1p1_imswl_v1p1.xsd">
                <title>${this.escapeTitle(r.title)}</title>
                <url href="${r.url.replace(/%3F/g, '%253F')}" target="_iframe"/>
              </webLink>
            `),
          });
        });
        org = `
          ${org}
          </item>
        `;
        return { org, resources };
      },
      { org: '', resources: '' },
    );
    return { org, resources, resourceXMLEntries };
  }

  private generateXML({ org, pageInfo, resources }: { org: string; pageInfo: BookPageInfo; resources: string }) {
    const xml = `
      <?xml version="1.0" encoding="UTF-8"?>
      <manifest xmlns="http://www.imsglobal.org/xsd/imsccv1p1/imscp_v1p1" xmlns:lom="http://ltsc.ieee.org/xsd/imsccv1p1/LOM/resource" xmlns:lomimscc="http://ltsc.ieee.org/xsd/imsccv1p1/LOM/manifest" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" identifier="cctd0015" xsi:schemaLocation="http://www.imsglobal.org/xsd/imslticc_v1p0 http://www.imsglobal.org/xsd/lti/ltiv1p0/imslticc_v1p0.xsd http://www.imsglobal.org/xsd/imslticp_v1p0 http://www.imsglobal.org/xsd/lti/ltiv1p0/imslticp_v1p0.xsd http://www.imsglobal.org/xsd/imslticm_v1p0 http://www.imsglobal.org/xsd/lti/ltiv1p0/imslticm_v1p0.xsd http://www.imsglobal.org/xsd/imsbasiclti_v1p0 http://www.imsglobal.org/xsd/lti/ltiv1p0/imsbasiclti_v1p0p1.xsd">
        <metadata>
          <schema>IMS Common Cartridge</schema>
          <schemaversion>1.1.0</schemaversion>
          <lomimscc:lom>
            <lomimscc:general>
              <lomimscc:title>
                <lomimscc:string language="en-US">${this.escapeTitle(pageInfo.title)}</lomimscc:string>
              </lomimscc:title>
            </lomimscc:general>
          </lomimscc:lom>
        </metadata>
        <organizations>
          <organization identifier="T_1000" structure="rooted-hierarchy">
            <item identifier="T_00000">
            ${org}
            </item>
          </organization>
        </organizations>
        <resources>
          ${resources}
        </resources>
      </manifest>
    `;
    return formatXml(xml);
  }

  private async writeFinalOutputFile({
    bookID,
    manifest,
    useLocalStorage,
    xmlEntries,
  }: {
    bookID: PageID;
    manifest: string;
    useLocalStorage?: boolean;
    xmlEntries: ThinCCXMLEntry[];
  }) {
    const baseDir = Environment.getOptional('TMP_OUT_DIR', './.tmp');
    const baseDirPath = `${baseDir}/thincc/${bookID.toString()}`;
    const outputPath = `${baseDirPath}/${bookID.toString()}.imscc`;
    if (useLocalStorage) await fs.mkdir(baseDirPath, { recursive: true });

    const output = !useLocalStorage ? new PassThrough() : createWriteStream(outputPath);
    output.on('close', () => {
      this.logger.withMetadata({ bookID }).info('ThinCC output write stream closed.');
    });
    const archive = Archiver('zip', { zlib: { level: 9 } });
    archive.on('error', (err) => {
      this.logger.withError(err).error('Encounted an error preparing final ThinCC output.');
      output.destroy(err);
    });
    archive.pipe(output);

    let uploader: Upload | undefined;
    if (!useLocalStorage) {
      uploader = this.storageService.createStreamUploader({
        contentType: 'application/zip',
        key: 'test',
        stream: output as PassThrough,
      });
    }

    // write files
    archive.append(Buffer.from(manifest, 'utf-8'), { name: 'imsmanifest.xml' });
    xmlEntries.forEach((item) => {
      archive.append(Buffer.from(item.data, 'utf-8'), { name: item.path });
    });

    if (!useLocalStorage) {
      // WARN: don't actually await here: can cause deadlock with storage service streaming upload
      archive.finalize();
    } else {
      await archive.finalize();
    }
    this.logger.withMetadata({ bookID }).info('Uploading ThinCC to storage service...');
    if (!useLocalStorage) {
      await uploader?.done();
    }
    this.logger.withMetadata({ bookID }).info('Finished upload ThinCC to storage service.');
    this.logger.withMetadata({ bookID }).info('Finished writing ThinCC output.');
    return outputPath;
  }
}
