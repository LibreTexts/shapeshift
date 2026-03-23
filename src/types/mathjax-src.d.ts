declare module '@mathjax/src' {
  interface MathJaxStartup {
    adaptor: {
      outerHTML(node: unknown): string;
      root(doc: unknown): unknown;
    };
    getDocument(html: string): {
      renderPromise(): Promise<unknown>;
      document: unknown;
    };
  }

  interface MathJaxObject {
    startup: MathJaxStartup;
    [key: string]: unknown;
  }

  interface MathJaxConfig {
    loader?: { load?: string[] };
    tex?: {
      packages?: string[];
      inlineMath?: string[][];
      displayMath?: string[][];
    };
    svg?: { fontCache?: string };
    [key: string]: unknown;
  }

  const MathJax: {
    init(config: MathJaxConfig): Promise<MathJaxObject>;
    config: MathJaxConfig;
    startup: MathJaxStartup & (() => void);
    [key: string]: unknown;
  };

  export default MathJax;
}
