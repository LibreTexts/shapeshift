/**
 * Library subdomains are always plain alphanumeric tokens (see `librariesmap.ts`). Enforcing
 * that here keeps a PageID's string form safe to interpolate into filesystem paths — several
 * callers build per-book scratch directories out of it, and a `lib` carrying `../` or a path
 * separator would otherwise walk out of the temp directory.
 */
const LIB_PATTERN = /^[A-Za-z0-9]+$/;

export default class PageID {
  private readonly _lib: string;
  private readonly _pageNum: number;

  constructor(args: { lib: string; pageNum: number } | { pageIDString: string }) {
    if ('pageIDString' in args) {
      const [lib, pageNum] = args.pageIDString.split('-');
      if (!lib || !pageNum) {
        throw new Error(`Invalid pageIDString format: ${args.pageIDString}`);
      }

      this._lib = PageID.validateLib(lib);
      this._pageNum = parseInt(pageNum, 10);
    } else {
      this._lib = PageID.validateLib(args.lib);
      this._pageNum = args.pageNum;
    }
  }

  private static validateLib(lib: string): string {
    if (!LIB_PATTERN.test(lib)) {
      throw new Error(`Invalid library identifier: ${lib}`);
    }
    return lib;
  }

  get lib(): string {
    return this._lib;
  }

  get pageNum(): number {
    return this._pageNum;
  }

  toString(): string {
    return `${this._lib}-${this._pageNum}`;
  }

  toJSON() {
    return this.toString();
  }
}
