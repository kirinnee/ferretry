import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { openInBrowser } from '../../../src/adapters/plan/open-link';

const LINK = 'https://app.example.test/#agenda/A8?session=s1&x=a b;touch pwned';

afterEach(() => {
  spyOn(Bun, 'spawn').mockRestore();
  spyOn(Bun, 'which').mockRestore();
});

const stub = (found: boolean) => {
  const spawned: unknown[][] = [];
  spyOn(Bun, 'which').mockImplementation((() => (found ? '/usr/bin/launcher' : null)) as never);
  spyOn(Bun, 'spawn').mockImplementation(((argv: unknown[]) => {
    spawned.push(argv);
    return { unref: () => undefined };
  }) as never);
  return spawned;
};

describe('openInBrowser', () => {
  it('hands the launcher the link as one argv entry, with no shell', () => {
    const spawned = stub(true);

    expect(openInBrowser(LINK, 'linux')).toBe(true);
    expect(openInBrowser(LINK, 'darwin')).toBe(true);

    expect(spawned).toEqual([
      ['xdg-open', LINK],
      ['open', LINK],
    ]);
  });

  it('starts nothing when the platform has no launcher or the launcher is not installed', () => {
    const spawned = stub(false);

    expect(openInBrowser(LINK, 'linux')).toBe(false);
    expect(openInBrowser(LINK, 'win32')).toBe(false);
    expect(spawned).toEqual([]);
  });

  it('says false when the launcher cannot be started', () => {
    stub(true);
    spyOn(Bun, 'spawn').mockImplementation((() => {
      throw new Error('spawn failed');
    }) as never);

    expect(openInBrowser(LINK, 'linux')).toBe(false);
  });
});
