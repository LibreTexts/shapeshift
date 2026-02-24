export default class PageID {
  private readonly _lib: string;
  private readonly _pageNum: number;

  constructor(args: { lib: string; pageNum: number } | { pageIDString: string }) {
    if ('pageIDString' in args) {
      const [lib, pageNum] = args.pageIDString.split('-');
      if (!lib || !pageNum) {
        throw new Error(`Invalid pageIDString format: ${args.pageIDString}`);
      }

      this._lib = lib;
      this._pageNum = parseInt(pageNum, 10);
    } else {
      this._lib = args.lib;
      this._pageNum = args.pageNum;
    }
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
}
