import PageID from '../util/pageID';
import { log as logService } from '../lib/log';
import { LogLayer } from 'loglayer';
import { GlossaryEntry, GlossaryEntryForPage } from '../types/glossary';
import { omit, ORIGIN_HEADER, USER_AGENT } from '../util/util';

export class GlossaryService {
  private readonly logger: LogLayer;
  private readonly logName: string;

  constructor() {
    this.logName = 'GlossaryService';
    this.logger = logService.child().withContext({ logSource: this.logName });
  }

  public async getGlossaryTermsForBook(
    pageID: PageID,
  ): Promise<{ terms: GlossaryEntry[]; termsByPage: Map<string, GlossaryEntryForPage[]> }> {
    const emptyRes = {
      terms: [],
      termsByPage: new Map<string, GlossaryEntryForPage[]>(),
    };
    try {
      const rawRes = await fetch(
        `https://commons.libretexts.org/api/v1/commons/glossary/page/${pageID.pageNum}/library/${pageID.lib}`,
        {
          headers: {
            origin: ORIGIN_HEADER,
            'User-Agent': USER_AGENT,
          },
          method: 'POST',
        },
      );
      if (!rawRes.ok) {
        this.logger.error(`Glossary API returned ${rawRes.status} for ${pageID.toString()}`);
        return emptyRes;
      }
      const resp = await rawRes.json();
      if (resp.err || !resp.data) return emptyRes;

      const terms: GlossaryEntry[] = resp.data.items ?? [];
      const termsByPage = terms.reduce((acc, curr) => {
        (curr.pages ?? []).forEach((pageNumber) => {
          const currPageID = `${pageID.lib}-${pageNumber}`;
          const pageCurrTerms = acc.get(currPageID);
          acc.set(currPageID, (pageCurrTerms ?? []).concat(omit(curr, 'pages')));
        });
        return acc;
      }, new Map<string, GlossaryEntryForPage[]>());

      return {
        terms,
        termsByPage,
      };
    } catch (error) {
      this.logger.withError(error).error(`Error retrieving glossary terms for ${pageID.toString()}`);
      return emptyRes;
    }
  }
}
