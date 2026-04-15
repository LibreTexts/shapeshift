export type LicenseInfo = {
  label: string;
  link: string;
  raw: string;
  version?: string;
};

export type DetailedLicenseReportMeta = {
  licenses: (LicenseInfo & { count: number; percent: number })[];
  mostRestrictiveLicense: LicenseInfo;
  specialRestrictions: string[];
};

export type DetailedLicenseReportTextInfoEntry = {
  children: DetailedLicenseReportTextInfoEntry[];
  id: string;
  license: LicenseInfo;
  title: string;
  url: string;
};

export type DetailedLicenseReportTextInfo = DetailedLicenseReportTextInfoEntry & {
  totalPages: number;
};

export type DetailedLicensingReport = {
  coverID: string;
  id: string;
  library: string;
  meta: DetailedLicenseReportMeta;
  runtime: string;
  text: DetailedLicenseReportTextInfo;
  timestamp: string;
};
