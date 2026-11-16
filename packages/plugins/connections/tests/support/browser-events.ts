/** The signal tests only need an EventTarget; they never navigate or load a page. */
if (typeof (globalThis as { window?: unknown }).window === 'undefined')
  Object.defineProperty(globalThis, 'window', { value: new EventTarget(), configurable: true });
