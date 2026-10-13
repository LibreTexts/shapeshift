import { LicenseInfo } from './licensing';
import PageID from '../util/pageID';

export type BookMatterType = 'Back' | 'Front';

export type BookPages = {
  flat: BookPageInfo[];
  tree: BookPageInfo;
};

/** CXOne page restriction, from `security['permissions.page'].restriction`. */
export type PageRestriction = 'Public' | 'Semi-Public' | 'Semi-Private' | 'Private';

export type BookPageProperty = {
  name: string;
  value: string;
};

export type BookPageInfo = {
  authorTag?: string;
  body: string[];
  contentAttributions?: ContentAttribution[];
  head: string;
  license: LicenseInfo | null;
  matterType?: BookMatterType;
  pageID: PageID;
  printInfo: BookPrintInfo;
  properties: BookPageProperty[];
  restriction: PageRestriction | null;
  subdomain: string;
  subpages?: BookPageInfo[];
  summary?: string;
  tail: string;
  tags: string[];
  title: string;
  url: string;
};

export type ContentAttribution = {
  title: string;
  url: string;
  author?: { name: string; url?: string };
  license: LicenseInfo | null;
  source?: string;
};

export type BookPrintInfo = {
  attributionPrefix: string;
  authorName: string;
  authorURL: string;
  companyName: string;
  programName: string;
  programURL: string;
  spineTitle: string;
  title: string;
};

export type BookPageInfoWithContent = BookPageInfo & {
  head: string;
  body: string[];
  tail: string;
};
