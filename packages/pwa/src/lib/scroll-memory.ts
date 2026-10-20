/**
 * WHERE THE READER WAS, PER PLACE — so Back, Forward and a reload return to it instead of the top.
 *
 * The shell never scrolls the document: every page scrolls an element of its own inside a fixed frame,
 * so the browser's own scroll restoration has nothing to restore and every navigation used to land at
 * the top. This is the memory that replaces it, held in the tab's `sessionStorage` because that is
 * exactly the browser's own lifetime for it: it survives a reload and a Back, it is gone when the tab
 * is, and it is never another tab's.
 *
 * TWO KINDS OF PLACE, keyed by the caller:
 *   - A PAGE is remembered per HISTORY ENTRY (the router's `entryKey`): returning to an entry finds it
 *     where it was left, while opening the same page afresh starts at the top — the document contract.
 *     One entry may hold several scrollers, each named by its path from the page root.
 *   - A CHAT is remembered per SESSION: a conversation is somewhere one reads, and coming back to it
 *     by any route should find the reading position, with "Jump to latest" when that is not the end.
 *
 * Positions are numbers and the keys are the router's random entry ids and daemon-scoped session keys,
 * so nothing a daemon said is written here. Bounded: the oldest places are forgotten first.
 */

/** The storage this reads and writes; `null` where the browser refuses it (it then remembers nothing). */
export type ScrollMemoryStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/** One page's scrollers: each one's offset from the top, by its path from the page root. */
export type PageScroll = Readonly<Record<string, number>>;

/** A chat's reading position: the offset, and whether the reader was at the latest message. */
export interface ChatScroll {
  readonly top: number;
  readonly atLatest: boolean;
}

export const SCROLL_MEMORY_KEY = 'fy-scroll-memory:v1';

/** How many places are kept before the oldest is forgotten. */
export const SCROLL_MEMORY_LIMIT = 200;

interface Document {
  /** Places in the order they were last written, oldest first. */
  readonly order: readonly string[];
  readonly places: Readonly<Record<string, PageScroll | ChatScroll>>;
}

const EMPTY: Document = { order: [], places: {} };

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;

const isChat = (value: unknown): value is ChatScroll =>
  typeof value === 'object' &&
  value !== null &&
  finite((value as ChatScroll).top) &&
  typeof (value as ChatScroll).atLatest === 'boolean';

const isPage = (value: unknown): value is PageScroll =>
  typeof value === 'object' && value !== null && !isChat(value) && Object.values(value).every(finite);

const parse = (raw: string | null): Document => {
  if (raw === null) return EMPTY;
  try {
    const value = JSON.parse(raw) as Partial<Document>;
    if (!Array.isArray(value.order) || typeof value.places !== 'object' || value.places === null) return EMPTY;
    const places: Record<string, PageScroll | ChatScroll> = {};
    const order: string[] = [];
    for (const key of value.order) {
      const place = (value.places as Record<string, unknown>)[key];
      if (typeof key !== 'string' || !(isChat(place) || isPage(place))) continue;
      places[key] = place;
      order.push(key);
    }
    return { order, places };
  } catch {
    return EMPTY;
  }
};

export class ScrollMemory {
  readonly #storage: ScrollMemoryStorage | null;
  readonly #limit: number;

  constructor(storage: ScrollMemoryStorage | null, limit = SCROLL_MEMORY_LIMIT) {
    this.#storage = storage;
    this.#limit = limit;
  }

  page(entryKey: string): PageScroll | null {
    const place = this.#read().places[pageKey(entryKey)];
    return place !== undefined && isPage(place) ? place : null;
  }

  /** Records one scroller of one page; the page's other scrollers are kept. */
  rememberPage(entryKey: string, path: string, top: number): void {
    const key = pageKey(entryKey);
    const place = this.#read().places[key];
    this.#write(key, { ...(place !== undefined && isPage(place) ? place : {}), [path]: Math.max(0, top) });
  }

  chat(sessionKey: string): ChatScroll | null {
    const place = this.#read().places[chatKey(sessionKey)];
    return place !== undefined && isChat(place) ? place : null;
  }

  rememberChat(sessionKey: string, position: ChatScroll): void {
    this.#write(chatKey(sessionKey), { top: Math.max(0, position.top), atLatest: position.atLatest });
  }

  /** Forgets every place: part of Settings › This device › Clear cached data. */
  clear(): void {
    try {
      this.#storage?.removeItem(SCROLL_MEMORY_KEY);
    } catch {
      // A refused store holds nothing to clear.
    }
  }

  #read(): Document {
    try {
      return parse(this.#storage?.getItem(SCROLL_MEMORY_KEY) ?? null);
    } catch {
      return EMPTY;
    }
  }

  #write(key: string, place: PageScroll | ChatScroll): void {
    const current = this.#read();
    const order = [...current.order.filter(candidate => candidate !== key), key];
    const dropped = order.splice(0, Math.max(0, order.length - this.#limit));
    const places: Record<string, PageScroll | ChatScroll> = { ...current.places, [key]: place };
    for (const gone of dropped) delete places[gone];
    try {
      this.#storage?.setItem(SCROLL_MEMORY_KEY, JSON.stringify({ order, places }));
    } catch {
      // A full or refused store only costs the position; scrolling itself is unaffected.
    }
  }
}

const pageKey = (entryKey: string): string => `page:${entryKey}`;
const chatKey = (sessionKey: string): string => `chat:${sessionKey}`;

/** This tab's session storage, or `null` where the browser refuses it. */
export const browserScrollMemoryStorage = (
  host: { readonly sessionStorage?: ScrollMemoryStorage } = globalThis as { sessionStorage?: ScrollMemoryStorage },
): ScrollMemoryStorage | null => {
  try {
    return host.sessionStorage ?? null;
  } catch {
    return null;
  }
};

/**
 * Where a restore may land: the saved offset when the content is already tall enough to hold it, or
 * `undefined` while it is still too short (more is still arriving). `final` clamps instead — the
 * content has stopped growing, so the nearest reachable offset is the honest answer.
 */
export const restorableTop = (
  saved: number,
  scroller: { readonly scrollHeight: number; readonly clientHeight: number },
  final: boolean,
): number | undefined => {
  const max = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
  if (saved <= max) return saved;
  return final ? max : undefined;
};

/**
 * A scroller's address inside a page root: the child index at each level, so the same page rebuilt
 * after Back resolves to the same element. Empty for the root itself.
 */
export const elementPath = (root: Element, element: Element): string | null => {
  const steps: number[] = [];
  let node: Element | null = element;
  while (node !== null && node !== root) {
    const parent: Element | null = node.parentElement;
    if (parent === null) return null;
    steps.unshift(Array.prototype.indexOf.call(parent.children, node) as number);
    node = parent;
  }
  return node === root ? steps.join('.') : null;
};

/** The element at a path made by {@link elementPath}, or `null` when the page has not built it (yet). */
export const elementAtPath = (root: Element, path: string): Element | null => {
  if (path === '') return root;
  let node: Element | null = root;
  for (const step of path.split('.')) {
    node = node?.children.item(Number(step)) ?? null;
    if (node === null) return null;
  }
  return node;
};

/** One chat's slot in the memory: what `useStickToBottom` reads once on open and writes as the reader moves. */
export interface ChatScrollSlot {
  read(): ChatScroll | null;
  write(position: ChatScroll): void;
}

/** The slot for one session, keyed by its daemon-scoped key so two machines' sessions never share one. */
export const chatScrollSlot = (memory: ScrollMemory, sessionKey: string): ChatScrollSlot => ({
  read: () => memory.chat(sessionKey),
  write: position => memory.rememberChat(sessionKey, position),
});
