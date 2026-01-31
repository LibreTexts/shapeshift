import { log as logService } from '../lib/log';
import { LogLayer } from 'loglayer';
import { BookID, BookPageInfo } from './book';
import JSZip from 'jszip';
import { resolve } from 'node:path';
import fs from 'node:fs/promises';
import formatXml from 'xml-formatter';
import { Environment } from '../lib/environment';

type ThinCCTopicPageData = { title: string; url: string };

type ThinCCPageData = { title: string; resources: ThinCCTopicPageData[] };

export class ThinCCService {
  private readonly logger: LogLayer;
  private readonly logName = 'ThinCCService';

  constructor() {
    this.logger = logService.child().withContext({ logSource: this.logName });
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

  public async convertBook(pageInfo: BookPageInfo) {
    this.logger.withMetadata({ url: pageInfo.url }).info('Starting ThinCC conversion.');
    const pages = this.getPages(pageInfo);
    const { org, resources, resourceXMLEntries } = this.generateOrgAndResources(pages);
    const xml = this.generateXML({ org, pageInfo, resources });
    const zip = new JSZip();
    resourceXMLEntries.forEach((x) => zip.file(x.path, x.data));
    zip.file('imsmanifest.xml', xml);
    const result = await zip.generateAsync({ type: 'nodebuffer' });
    const outPath = await this.generateFinalOutputFileName({
      bookID: {
        lib: pageInfo.lib,
        pageID: pageInfo.id,
      },
    });
    await fs.writeFile(outPath, result);
    this.logger.withMetadata({ url: pageInfo.url }).info('Finished ThinCC conversion.');
    return outPath;
  }

  private async generateFinalOutputFileName({
    bookID,
    outFileNameOverride,
  }: {
    bookID: BookID;
    outFileNameOverride?: string;
  }) {
    const tmpDir = Environment.getOptional('TMP_OUT_DIR', './.tmp');
    const dirPath = resolve(`${tmpDir}/out/${bookID.lib}-${bookID.pageID}`);
    const fileName = outFileNameOverride ?? 'LibreText';
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
    const resourceXMLEntries: { data: string; path: string }[] = [];

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
}
