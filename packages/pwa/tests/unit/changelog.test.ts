import { afterEach, describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  browserChangelogStorage,
  bundledReleases,
  type ChangelogStorage,
  newVersions,
  parseChangelog,
  readLastViewed,
  releaseDateLabel,
  seedLastViewed,
  writeLastViewed,
} from '../../src/lib/changelog.ts';

const SAMPLE = `## [4.92.1](https://github.com/o/r/compare/v4.92.0...v4.92.1) (2026-10-28)

### Fixes

* **chat:** show a reply's blocks as the agent writes them ([#815](https://github.com/o/r/issues/815)) ([b07177b](https://github.com/o/r/commit/b07177bae0ca50f053b4d45c70c50ca42b50ce80))

## [4.92.0](https://github.com/o/r/compare/v4.91.0...v4.92.0) (2026-10-28)

### Performance

* **daemon:** read \`state.json\` once ([#2](https://github.com/o/r/issues/2)) ([0f81f2c](https://github.com/o/r/commit/0f81f2c7871ace51a68b872139907e4))

### Features

* **attention:** batch the owner's answers ([#817](https://github.com/o/r/issues/817)) ([3fb347a](https://github.com/o/r/commit/3fb347a2ee46c7d61a512c096ced1e1719a))
* open links in this computer's default browser ([#767](https://github.com/o/r/issues/767)) ([7991411](https://github.com/o/r/commit/7991411ace0d6f61a7fac77d34daa9b8e4ac1b2))

## [4.0.0](https://github.com/o/r/compare/v3.53.0...v4.0.0) (2026-10-16)

### ⚠ BREAKING CHANGES

* **notifications:** RegisterPushDeviceRequestSchema no
longer carries \`prefs\`.

* fix(notifications): tolerate version skew

### Features

* **notifications:** every daemon sends every event ([#503](https://github.com/o/r/issues/503)) ([7a73b96](https://github.com/o/r/commit/7a73b96778c651eb5c4de1ace7bab1ed44f251e4))

## [3.0.1](https://github.com/o/r/compare/v3.0.0...v3.0.1) (2026-10-01)
`;

describe('parseChangelog', () => {
  const releases = parseChangelog(SAMPLE);

  it('lists every release in file order, with its version, day and GitHub page', () => {
    expect(releases.map(release => release.version)).toEqual(['4.92.1', '4.92.0', '4.0.0', '3.0.1']);
    expect(releases[0]?.date).toBe('2026-10-28');
    expect(releases[0]?.releaseUrl).toBe('https://github.com/o/r/releases/tag/v4.92.1');
  });

  it('strips the links, keeps the scope as a tag and turns the issue link into a pull request link', () => {
    expect(releases[0]?.groups).toEqual([
      {
        kind: 'fixes',
        title: 'Fixed',
        changes: [
          {
            scope: 'chat',
            text: "Show a reply's blocks as the agent writes them",
            pr: { number: 815, url: 'https://github.com/o/r/pull/815' },
          },
        ],
      },
    ]);
  });

  it('orders groups New, Fixed, Faster whatever order the file wrote them, and allows an unscoped change', () => {
    expect(releases[1]?.groups.map(group => group.title)).toEqual(['New', 'Faster']);
    const unscoped = releases[1]?.groups[0]?.changes[1];
    expect(unscoped?.scope).toBeUndefined();
    expect(unscoped?.text).toBe("Open links in this computer's default browser");
    expect(unscoped?.pr?.number).toBe(767);
  });

  it('keeps a breaking change first, joins its wrapped lines and drops the commits quoted beneath it', () => {
    const groups = releases[2]?.groups ?? [];
    expect(groups.map(group => group.kind)).toEqual(['breaking', 'features']);
    expect(groups[0]?.changes).toEqual([
      { scope: 'notifications', text: 'RegisterPushDeviceRequestSchema no longer carries `prefs`.' },
    ]);
  });

  it('keeps a release that listed no changes, with no groups', () => {
    expect(releases[3]?.groups).toEqual([]);
  });

  it('says nothing for text with no release headings', () => {
    expect(parseChangelog('')).toEqual([]);
    expect(parseChangelog('# Changelog\n\nnothing yet')).toEqual([]);
  });

  it('reads every release of the repository changelog, and finds changes in the newest ones', () => {
    const file = readFileSync(new URL('../../../../Changelog.md', import.meta.url), 'utf8');
    const headings = file.split('\n').filter(line => line.startsWith('## ')).length;
    const parsed = parseChangelog(file);
    expect(parsed.length).toBe(headings);
    expect(parsed.slice(0, 5).every(release => release.groups.length > 0)).toBe(true);
    for (const release of parsed) {
      for (const group of release.groups) {
        for (const change of group.changes)
          expect(change.text).not.toMatch(/(?:\(\[[^\]]*\]\([^)]*\)\)|closes \[[^\]]*\]\([^)]*\))\s*$/u);
      }
    }
  });
});

describe('releaseDateLabel', () => {
  it('words a calendar day without a timezone', () => {
    expect(releaseDateLabel('2026-10-28')).toBe('28 Oct 2026');
    expect(releaseDateLabel('2026-01-05')).toBe('5 Jan 2026');
    expect(releaseDateLabel('not a date')).toBe('not a date');
  });
});

describe('bundledReleases', () => {
  const host = globalThis as { __FY_CHANGELOG__?: unknown };
  afterEach(() => {
    delete host.__FY_CHANGELOG__;
  });

  it('is empty for a build that stamped no changelog', () => {
    expect(bundledReleases()).toEqual([]);
  });

  it('parses the text the build stamped', () => {
    host.__FY_CHANGELOG__ = SAMPLE;
    expect(bundledReleases().length).toBe(4);
  });
});

describe('newVersions', () => {
  const releases = parseChangelog(SAMPLE);

  it('marks the versions strictly newer than the last one viewed', () => {
    expect([...newVersions(releases, '4.92.0')]).toEqual(['4.92.1']);
    expect([...newVersions(releases, '4.0.0')]).toEqual(['4.92.1', '4.92.0']);
    expect(newVersions(releases, '4.92.1').size).toBe(0);
    expect(newVersions(releases, '9.0.0').size).toBe(0);
  });

  it('marks nothing for a device with no baseline', () => {
    expect(newVersions(releases, null).size).toBe(0);
  });
});

describe('the last-viewed record', () => {
  const memory = (): ChangelogStorage & { readonly values: Map<string, string> } => {
    const values = new Map<string, string>();
    return { values, getItem: key => values.get(key) ?? null, setItem: (key, value) => void values.set(key, value) };
  };
  const refusing: ChangelogStorage = {
    getItem: () => {
      throw new Error('blocked');
    },
    setItem: () => {
      throw new Error('blocked');
    },
  };
  const releases = parseChangelog(SAMPLE);

  it('round-trips through storage', () => {
    const storage = memory();
    expect(readLastViewed(storage)).toBeNull();
    writeLastViewed(storage, '4.92.0');
    expect(readLastViewed(storage)).toBe('4.92.0');
  });

  it('seeds a first-time device with the newest version, once', () => {
    const storage = memory();
    seedLastViewed(storage, releases);
    expect(readLastViewed(storage)).toBe('4.92.1');
    writeLastViewed(storage, '4.0.0');
    seedLastViewed(storage, releases);
    expect(readLastViewed(storage)).toBe('4.0.0');
  });

  it('says nothing, and throws nothing, when storage is absent or refuses', () => {
    expect(readLastViewed(undefined)).toBeNull();
    expect(readLastViewed(refusing)).toBeNull();
    expect(() => writeLastViewed(refusing, '1.0.0')).not.toThrow();
    expect(() => writeLastViewed(undefined, '1.0.0')).not.toThrow();
    expect(() => seedLastViewed(refusing, releases)).not.toThrow();
  });
});

describe('browserChangelogStorage', () => {
  it('finds the browser storage, or nothing when reading it throws', () => {
    expect(browserChangelogStorage()).toBe(globalThis.localStorage);
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get: () => {
        throw new Error('SecurityError');
      },
    });
    try {
      expect(browserChangelogStorage()).toBeUndefined();
    } finally {
      if (descriptor !== undefined) Object.defineProperty(globalThis, 'localStorage', descriptor);
      else delete (globalThis as { localStorage?: unknown }).localStorage;
    }
  });
});

describe('parseChangelog, what a reader sees', () => {
  const wording = `## [1.0.0](https://github.com/o/r/compare/v0.9.0...v1.0.0) (2026-10-28)

### Fixes

* **test:** drive the idle budget suite with a manual clock ([#1](https://github.com/o/r/issues/1)) ([aaaaaaa](https://github.com/o/r/commit/aaaaaaa))
* **CI:** pin the runner image ([#2](https://github.com/o/r/issues/2)) ([bbbbbbb](https://github.com/o/r/commit/bbbbbbb))
* **build:** pin the toolchain ([#3](https://github.com/o/r/issues/3)) ([ccccccc](https://github.com/o/r/commit/ccccccc))
* **chat:** keep the \`reply\` visible ([#4](https://github.com/o/r/issues/4)) ([ddddddd](https://github.com/o/r/commit/ddddddd))
* \`fy\` opens faster ([#5](https://github.com/o/r/issues/5)) ([eeeeeee](https://github.com/o/r/commit/eeeeeee))
`;

  it('leaves out lines scoped test, ci or build, however the scope is cased', () => {
    const changes = parseChangelog(wording)[0]?.groups[0]?.changes ?? [];
    expect(changes.map(change => change.pr?.number)).toEqual([4, 5]);
  });

  it('starts every line with a capital and leaves a leading code span as written', () => {
    const changes = parseChangelog(wording)[0]?.groups[0]?.changes ?? [];
    expect(changes.map(change => change.text)).toEqual(['Keep the `reply` visible', '`fy` opens faster']);
  });

  it('keeps a release whose every line was left out, with no groups', () => {
    const only = wording.split('\n').slice(0, 6).join('\n');
    expect(parseChangelog(only)).toEqual([expect.objectContaining({ version: '1.0.0', groups: [] })]);
  });
});
