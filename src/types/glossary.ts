export interface GlossaryPageUsage {
  pageID: string;
  addedBy: string;
  createdAt: Date;
}

export type GlossaryEntry = {
  aliases?: string[];
  altText?: string;
  author?: string;
  caption?: string;
  definition: string;
  imageAuthor?: string;
  imageLicense?: string;
  imageSource?: string;
  imageUrl?: string;
  link?: string;
  pages: string[];
  source?: string;
  term: string;
  termID: string;
  usageID: string;
};

export type GlossaryEntryForPage = Omit<GlossaryEntry, 'pages'>;
