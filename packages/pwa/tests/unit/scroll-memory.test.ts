import { describe, expect, it } from 'bun:test';
import {
  browserScrollMemoryStorage,
  chatScrollSlot,
  elementAtPath,
  elementPath,
  restorableTop,
  SCROLL_MEMORY_KEY,
  SCROLL_MEMORY_LIMIT,
  ScrollMemory,
  type ScrollMemoryStorage,
} from '../../src/lib/scroll-memory.ts';
import '../support/dom.ts';

/** A storage held in a map, so a test can also read what was written. */
const memoryStorage = (initial?: string): ScrollMemoryStorage & { raw: () => string | null } => {
  const items = new Map<string, string>();
  if (initial !== undefined) items.set(SCROLL_MEMORY_KEY, initial);
  return {
    getItem: key => items.get(key) ?? null,
    setItem: (key, value) => void items.set(key, value),
    removeItem: key => void items.delete(key),
    raw: () => items.get(SCROLL_MEMORY_KEY) ?? null,
  };
};

const throwing = (which: ReadonlyArray<'getItem' | 'setItem' | 'removeItem'>): ScrollMemoryStorage => {
  const refuse = (): never => {
    throw new Error('refused');
  };
  return {
    getItem: which.includes('getItem') ? refuse : () => null,
    setItem: which.includes('setItem') ? refuse : () => undefined,
    removeItem: which.includes('removeItem') ? refuse : () => undefined,
  };
};

describe('ScrollMemory pages', () => {
  it('returns null for a page never written', () => {
    // Arrange
    const subject = new ScrollMemory(memoryStorage());
    // Act
    const actual = subject.page('entry-1');
    // Assert
    expect(actual).toBeNull();
  });

  it('remembers several scrollers of one page and keeps the others when one is rewritten', () => {
    // Arrange
    const subject = new ScrollMemory(memoryStorage());
    // Act
    subject.rememberPage('entry-1', '', 10);
    subject.rememberPage('entry-1', '0.1', 20);
    subject.rememberPage('entry-1', '', 30);
    // Assert
    expect(subject.page('entry-1')).toEqual({ '': 30, '0.1': 20 });
  });

  it('clamps a negative offset to zero', () => {
    // Arrange
    const subject = new ScrollMemory(memoryStorage());
    // Act
    subject.rememberPage('entry-1', '', -5);
    // Assert
    expect(subject.page('entry-1')).toEqual({ '': 0 });
  });

  it('does not read a chat as a page, and starts a page fresh over a chat of the same key shape', () => {
    // Arrange
    const subject = new ScrollMemory(memoryStorage());
    subject.rememberChat('s1', { top: 5, atLatest: false });
    // Act
    const actual = subject.page('s1');
    // Assert
    expect(actual).toBeNull();
  });

  it('overwrites a stored chat-shaped place under a page key as an empty page plus the new path', () => {
    // Arrange
    const storage = memoryStorage(
      JSON.stringify({ order: ['page:e'], places: { 'page:e': { top: 1, atLatest: true } } }),
    );
    const subject = new ScrollMemory(storage);
    // Act
    subject.rememberPage('e', 'x', 7);
    // Assert
    expect(subject.page('e')).toEqual({ x: 7 });
  });
});

describe('ScrollMemory chats', () => {
  it('returns null for a chat never written', () => {
    // Arrange
    const subject = new ScrollMemory(memoryStorage());
    // Act
    const actual = subject.chat('s1');
    // Assert
    expect(actual).toBeNull();
  });

  it.each([
    { top: 120, atLatest: false },
    { top: 0, atLatest: true },
  ])('round-trips the position %o', input => {
    // Arrange
    const subject = new ScrollMemory(memoryStorage());
    // Act
    subject.rememberChat('s1', input);
    // Assert
    expect(subject.chat('s1')).toEqual(input);
  });

  it('clamps a negative chat offset to zero', () => {
    // Arrange
    const subject = new ScrollMemory(memoryStorage());
    // Act
    subject.rememberChat('s1', { top: -9, atLatest: false });
    // Assert
    expect(subject.chat('s1')).toEqual({ top: 0, atLatest: false });
  });

  it('does not read a page as a chat', () => {
    // Arrange
    const subject = new ScrollMemory(memoryStorage());
    subject.rememberPage('p', '', 3);
    // Act
    const actual = subject.chat('p');
    // Assert
    expect(actual).toBeNull();
  });

  it('is cleared by clear()', () => {
    // Arrange
    const storage = memoryStorage();
    const subject = new ScrollMemory(storage);
    subject.rememberChat('s1', { top: 1, atLatest: true });
    // Act
    subject.clear();
    // Assert
    expect(storage.raw()).toBeNull();
    expect(subject.chat('s1')).toBeNull();
  });
});

describe('ScrollMemory bound', () => {
  it('forgets the oldest place first once past the limit', () => {
    // Arrange
    const subject = new ScrollMemory(memoryStorage(), 2);
    // Act
    subject.rememberPage('a', '', 1);
    subject.rememberPage('b', '', 2);
    subject.rememberPage('c', '', 3);
    // Assert
    expect(subject.page('a')).toBeNull();
    expect(subject.page('b')).toEqual({ '': 2 });
    expect(subject.page('c')).toEqual({ '': 3 });
  });

  it('counts a rewrite as the newest, so it outlives an untouched neighbour', () => {
    // Arrange
    const subject = new ScrollMemory(memoryStorage(), 2);
    subject.rememberPage('a', '', 1);
    subject.rememberPage('b', '', 2);
    // Act
    subject.rememberPage('a', '', 9);
    subject.rememberPage('c', '', 3);
    // Assert
    expect(subject.page('a')).toEqual({ '': 9 });
    expect(subject.page('b')).toBeNull();
  });

  it('keeps SCROLL_MEMORY_LIMIT places by default', () => {
    // Arrange
    const subject = new ScrollMemory(memoryStorage());
    // Act
    for (let index = 0; index <= SCROLL_MEMORY_LIMIT; index += 1) subject.rememberPage(`e${index}`, '', index);
    // Assert
    expect(subject.page('e0')).toBeNull();
    expect(subject.page('e1')).toEqual({ '': 1 });
    expect(subject.page(`e${SCROLL_MEMORY_LIMIT}`)).toEqual({ '': SCROLL_MEMORY_LIMIT });
  });
});

describe('ScrollMemory parse', () => {
  it.each([
    ['not json', 'not json{'],
    ['an array', '[]'],
    ['no order', JSON.stringify({ places: {} })],
    ['order not an array', JSON.stringify({ order: 'x', places: {} })],
    ['no places', JSON.stringify({ order: [] })],
    ['null places', JSON.stringify({ order: [], places: null })],
  ])('reads %s as empty', (_name, raw) => {
    // Arrange
    const subject = new ScrollMemory(memoryStorage(raw));
    // Act
    const actual = subject.page('e');
    // Assert
    expect(actual).toBeNull();
  });

  it('drops junk entries but keeps the good ones', () => {
    // Arrange
    const raw = JSON.stringify({
      order: ['page:good', 'page:neg', 'page:str', 'page:null', 'page:missing', 7, 'chat:ok', 'chat:bad'],
      places: {
        'page:good': { '': 4 },
        'page:neg': { '': -1 },
        'page:str': { '': 'x' },
        'page:null': null,
        'chat:ok': { top: 2, atLatest: false },
        'chat:bad': { top: 2, atLatest: 'no' },
      },
    });
    const subject = new ScrollMemory(memoryStorage(raw));
    // Act
    const actual = [
      subject.page('good'),
      subject.page('neg'),
      subject.page('str'),
      subject.page('null'),
      subject.page('missing'),
      subject.chat('ok'),
      subject.chat('bad'),
    ];
    // Assert
    expect(actual).toEqual([{ '': 4 }, null, null, null, null, { top: 2, atLatest: false }, null]);
  });

  it('rejects a non-finite chat offset', () => {
    // Arrange
    const raw = JSON.stringify({ order: ['chat:x'], places: { 'chat:x': { top: null, atLatest: true } } });
    const subject = new ScrollMemory(memoryStorage(raw));
    // Act
    const actual = subject.chat('x');
    // Assert
    expect(actual).toBeNull();
  });
});

describe('ScrollMemory with a refusing or absent storage', () => {
  it('reads as empty and writes nothing visible when getItem throws', () => {
    // Arrange
    const subject = new ScrollMemory(throwing(['getItem']));
    // Act
    subject.rememberPage('e', '', 1);
    // Assert
    expect(subject.page('e')).toBeNull();
  });

  it('swallows a setItem that throws', () => {
    // Arrange
    const subject = new ScrollMemory(throwing(['setItem']));
    // Act
    const act = (): void => subject.rememberChat('s', { top: 1, atLatest: true });
    // Assert
    expect(act).not.toThrow();
    expect(subject.chat('s')).toBeNull();
  });

  it('swallows a removeItem that throws', () => {
    // Arrange
    const subject = new ScrollMemory(throwing(['removeItem']));
    // Act
    const act = (): void => subject.clear();
    // Assert
    expect(act).not.toThrow();
  });

  it('remembers nothing with a null storage and clear() is a no-op', () => {
    // Arrange
    const subject = new ScrollMemory(null);
    // Act
    subject.rememberPage('e', '', 1);
    subject.clear();
    // Assert
    expect(subject.page('e')).toBeNull();
  });
});

describe('browserScrollMemoryStorage', () => {
  it('returns the host session storage', () => {
    // Arrange
    const sessionStorage = memoryStorage();
    // Act
    const actual = browserScrollMemoryStorage({ sessionStorage });
    // Assert
    expect(actual).toBe(sessionStorage);
  });

  it('returns null when the host has none', () => {
    // Arrange
    const host = {};
    // Act
    const actual = browserScrollMemoryStorage(host);
    // Assert
    expect(actual).toBeNull();
  });

  it('returns null when reading sessionStorage throws', () => {
    // Arrange
    const host = {
      get sessionStorage(): ScrollMemoryStorage {
        throw new Error('SecurityError');
      },
    };
    // Act
    const actual = browserScrollMemoryStorage(host);
    // Assert
    expect(actual).toBeNull();
  });

  it('defaults to the global host without throwing', () => {
    // Arrange / Act
    const actual = browserScrollMemoryStorage();
    // Assert
    expect(actual === null || typeof actual.getItem === 'function').toBe(true);
  });
});

describe('restorableTop', () => {
  it.each([
    { saved: 100, scrollHeight: 1000, clientHeight: 400, final: false, expected: 100 },
    { saved: 600, scrollHeight: 1000, clientHeight: 400, final: false, expected: 600 },
    { saved: 700, scrollHeight: 1000, clientHeight: 400, final: false, expected: undefined },
    { saved: 700, scrollHeight: 1000, clientHeight: 400, final: true, expected: 600 },
    { saved: 50, scrollHeight: 100, clientHeight: 400, final: true, expected: 0 },
    { saved: 0, scrollHeight: 100, clientHeight: 400, final: false, expected: 0 },
  ])('answers $expected for $saved in $scrollHeight/$clientHeight (final $final)', input => {
    // Arrange
    const { saved, final, expected, ...scroller } = input;
    // Act
    const actual = restorableTop(saved, scroller, final);
    // Assert
    expect(actual).toBe(expected);
  });
});

describe('elementPath and elementAtPath', () => {
  const build = (): { root: HTMLElement; deep: HTMLElement; second: HTMLElement } => {
    const root = document.createElement('div');
    const first = document.createElement('section');
    const second = document.createElement('section');
    const deep = document.createElement('div');
    second.appendChild(document.createElement('p'));
    second.appendChild(deep);
    root.append(first, second);
    return { root, deep, second };
  };

  it('addresses the root as an empty path and resolves it back', () => {
    // Arrange
    const { root } = build();
    // Act
    const path = elementPath(root, root);
    // Assert
    expect(path).toBe('');
    expect(elementAtPath(root, '')).toBe(root);
  });

  it('round-trips a nested element', () => {
    // Arrange
    const { root, deep } = build();
    // Act
    const path = elementPath(root, deep);
    // Assert
    expect(path).toBe('1.1');
    expect(elementAtPath(root, '1.1')).toBe(deep);
  });

  it('is null for an element outside the root', () => {
    // Arrange
    const { root } = build();
    const stranger = document.createElement('div');
    // Act
    const actual = elementPath(root, stranger);
    // Assert
    expect(actual).toBeNull();
  });

  it('is null for an element in another tree sharing no ancestor with the root', () => {
    // Arrange
    const { root } = build();
    const other = build();
    // Act
    const actual = elementPath(root, other.deep);
    // Assert
    expect(actual).toBeNull();
  });

  it('is null when the page has not built the child yet', () => {
    // Arrange
    const { root } = build();
    // Act
    const actual = elementAtPath(root, '1.5');
    // Assert
    expect(actual).toBeNull();
  });

  it('is null when an intermediate step is missing', () => {
    // Arrange
    const { root } = build();
    // Act
    const actual = elementAtPath(root, '9.0');
    // Assert
    expect(actual).toBeNull();
  });
});

describe('chatScrollSlot', () => {
  it('reads and writes the chat of its own session key only', () => {
    // Arrange
    const memory = new ScrollMemory(memoryStorage());
    const slot = chatScrollSlot(memory, 'm1/s1');
    const other = chatScrollSlot(memory, 'm2/s1');
    // Act
    slot.write({ top: 40, atLatest: false });
    // Assert
    expect(slot.read()).toEqual({ top: 40, atLatest: false });
    expect(other.read()).toBeNull();
    expect(memory.chat('m1/s1')).toEqual({ top: 40, atLatest: false });
  });
});
