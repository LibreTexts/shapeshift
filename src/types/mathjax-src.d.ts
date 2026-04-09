declare module '@mathjax/src' {
  interface MathJaxStartup {
    adaptor: {
      outerHTML(node: unknown): string;
      root(doc: unknown): unknown;
    };
    getDocument(html: string): {
      renderPromise(): Promise<unknown>;
      clear(): void;
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

/**
 * Module declarations for MathJax v4 component bundles.
 * These JavaScript files configure and initialize the global MathJax object.
 */
declare module '@mathjax/src/bundle/tex-chtml.js';
declare module '@mathjax/src/bundle/tex-svg.js';
declare module '@mathjax/src/bundle/tex-mml-svg.js';
declare module '@mathjax/src/bundle/startup.js';
