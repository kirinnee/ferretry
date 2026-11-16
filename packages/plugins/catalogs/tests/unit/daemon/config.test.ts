/**
 * `catalogs.yaml` (§3.3 config): where today's `daemon.json` `catalogs` block went. The member unlock length sits beside
 * the link store, is bounded 1..90 days, defaults to 30, and RAISING it loosens, so it is the owner's to confirm.
 */
import { describe, expect, it } from 'bun:test';
import { CatalogsConfigFile, CatalogsConfigSchema, catalogConfigLoosens } from '../../../contract/config.ts';
import { browser, catalogsFixture, joinWith, makeCatalog, mintShare } from '../../support/daemon-host.ts';

const parse = (value: unknown) => CatalogsConfigSchema.safeParse(value);

describe('catalogs.yaml', () => {
  it('should default the member unlock to 30 days and the link store to discovery', () => {
    // Act
    const config = CatalogsConfigSchema.parse({});

    // Assert
    expect(config.memberUnlockDays).toBe(30);
    expect(config.linkStore).toEqual({ source: 'discovery' });
  });

  it('should take 1 to 90 days whole, and refuse 0, 91, a fraction and a word', () => {
    // Act / Assert
    for (const days of [1, 7, 90]) expect(parse({ memberUnlockDays: days }).success).toBe(true);
    for (const days of [0, -1, 91, 1.5, '30', null]) expect(parse({ memberUnlockDays: days }).success).toBe(false);
  });

  it('should refuse a key it does not declare', () => {
    // Act / Assert
    expect(parse({ memberUnlockDays: 30, unlockHours: 4 }).success).toBe(false);
  });

  it('should hold a longer unlock for the owner and let a shorter one through', () => {
    // Arrange
    const at = (memberUnlockDays: number) => CatalogsConfigSchema.parse({ memberUnlockDays });

    // Act / Assert
    expect(catalogConfigLoosens(at(30), at(60))).toEqual([
      'A member can stay unlocked for longer before their passkey is asked again.',
    ]);
    expect(catalogConfigLoosens(undefined, at(31))).toHaveLength(1);
    expect(catalogConfigLoosens(at(60), at(30))).toEqual([]);
    expect(catalogConfigLoosens(undefined, at(30))).toEqual([]);
    expect(catalogConfigLoosens(at(7), undefined)).toHaveLength(1);
  });

  it('should still hold a link store switched back on or pointed elsewhere', () => {
    // Arrange
    const store = (linkStore: unknown) => CatalogsConfigSchema.parse({ linkStore });

    // Act / Assert
    expect(catalogConfigLoosens(store({ enabled: false }), store({ source: 'discovery' }))).toEqual([
      'Download links can be published again.',
    ]);
    expect(catalogConfigLoosens(store({ source: 'discovery' }), store({ url: 'https://links.example.net' }))).toEqual([
      'Download links can be sent to another store.',
    ]);
    expect(catalogConfigLoosens(store({ source: 'discovery' }), store({ enabled: false }))).toEqual([]);
  });

  it('should be an owner-held configure file the plugin declares', () => {
    // Assert
    expect(CatalogsConfigFile.file).toBe('catalogs.yaml');
    expect(CatalogsConfigFile.axis).toBe('configure');
    expect(CatalogsConfigFile.personOnly).toBe(true);
  });
});

describe('the member unlock length on the composed daemon half', () => {
  const joinedWith = async (options: Parameters<typeof catalogsFixture>[0]) => {
    const fx = await catalogsFixture(options);
    const catalog = await makeCatalog(fx);
    return await joinWith(fx, await browser(), (await mintShare(fx, { catalogIds: [catalog] })).code);
  };

  it('should tell a joining browser 30 days when catalogs.yaml says nothing', async () => {
    // Act
    const joined = await joinedWith({});

    // Assert
    expect(joined.memberUnlockDays).toBe(30);
  });

  it('should tell a joining browser the owner’s 1 day, and the longest 90', async () => {
    // Act
    const short = await joinedWith({ memberUnlockDays: 1 });
    const long = await joinedWith({ memberUnlockDays: 90 });

    // Assert
    expect(short.memberUnlockDays).toBe(1);
    expect(long.memberUnlockDays).toBe(90);
  });
});
