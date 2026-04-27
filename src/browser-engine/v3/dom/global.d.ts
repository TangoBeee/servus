// @ts-nocheck
export interface BrowserCoreV3Backdoor {
  /** Closed shadow-root accessors */
  getClosedRoot(host: Element): ShadowRoot | undefined;
  /** Stats + quick health check */
  stats(): {
    installed: true;
    url: string;
    isTop: boolean;
    open: number;
    closed: number;
  };
}

declare global {
  interface Window {
    __browser_coreV3Injected?: boolean;
    __browser_coreV3__?: BrowserCoreV3Backdoor;
  }
}
