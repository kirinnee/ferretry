/** In-app navigation without owning the router: push the address and tell the shell's router the location moved. */
export const navigateTo = (to: string): void => {
  const browser = globalThis as unknown as {
    readonly history?: { pushState(state: unknown, title: string, url: string): void };
    readonly dispatchEvent?: (event: unknown) => boolean;
    readonly PopStateEvent?: new (type: string) => unknown;
  };
  browser.history?.pushState(null, '', to);
  if (browser.PopStateEvent !== undefined) browser.dispatchEvent?.(new browser.PopStateEvent('popstate'));
};
