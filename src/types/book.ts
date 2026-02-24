import { LicenseInfo } from '../util/licensing';
import PageID from '../util/pageID';

export type BookMatterType = 'Back' | 'Front';

export type BookPageProperty = {
  name: string;
  value: string;
};

export type BookPageInfo = {
  pageID: PageID;
  authorTag?: string;
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

export type BookPageInfoWithContent = BookPageInfo & {
  head: string;
  body: string[];
  tail: string;
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
