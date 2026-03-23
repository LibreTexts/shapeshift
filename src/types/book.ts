import { LicenseInfo } from '../util/licensing';
import PageID from '../util/pageID';

export type BookMatterType = 'Back' | 'Front';

export type BookPages = {
  flat: BookPageInfo[];
  tree: BookPageInfo;
};

export type BookPageProperty = {
  name: string;
  value: string;
};

export type BookPageInfo = {
  authorTag?: string;
  body: string[];
  head: string;
  license: LicenseInfo | null;
  matterType?: BookMatterType;
  pageID: PageID;
  printInfo: BookPrintInfo;
  properties: BookPageProperty[];
  subdomain: string;
  subpages?: BookPageInfo[];
  summary?: string;
  tail: string;
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
