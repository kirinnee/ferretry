/** Loaded before fyd: even a mistakenly enabled hosted relay cannot dial outside this test machine. */
function address(raw: unknown): void {
  const url = raw instanceof Request ? new URL(raw.url) : new URL(String(raw));
  if (!['127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('test network fence: loopback only');
}

globalThis.fetch = new Proxy(globalThis.fetch, {
  apply(target, self, args) {
    address(args[0]);
    return Reflect.apply(target, self, args);
  },
  get(target, key, self) {
    if (key === 'preconnect')
      return (url: unknown) => {
        address(url);
      };
    return Reflect.get(target, key, self);
  },
});
globalThis.WebSocket = new Proxy(globalThis.WebSocket, {
  construct(target, args, derived) {
    address(args[0]);
    return Reflect.construct(target, args, derived);
  },
});
Object.defineProperty(Bun, 'connect', {
  value: new Proxy(Bun.connect, {
    apply(target, self, args) {
      const options = args[0] as { hostname?: string; unix?: string };
      if (options.unix === undefined && !['127.0.0.1', '::1'].includes(options.hostname ?? ''))
        throw new Error('test network fence: loopback only');
      return Reflect.apply(target, self, args);
    },
  }),
});
