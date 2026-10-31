import { describe, expect, it } from 'bun:test';
import { FyHttpError } from '@ferretry/protocol/client';
import type { SharedCatalogManifestEntry, SharedRedeemResponse } from '@ferretry/protocol';
import {
  catalogBlock,
  cardState,
  isRefused,
  itemLine,
  joinFacts,
  kindLabel,
  nameProblem,
  REDEEM_LOCKED_SENTENCE,
  redeemView,
  shareHost,
  UNLOCK_THEN_LINK,
  windowAnnouncement,
  withdrawnSummary,
  WITHDRAWN_INSTALLED,
} from '../../../../src/features/shared/shared-screens-model.ts';
import {
  JOIN_REFUSED_SENTENCE,
  passkeyWindow,
  redeemRefusal,
  WINDOW_CLOSED_SENTENCE,
} from '../../../../src/features/shared/shared-model.ts';
import { fingerprintHead } from '../../../../src/lib/member-keys.ts';
import { failedAttempt, okAttempt, refusedAttempt, SEED, sharedItemFixture } from '../../../support/shared-screens.ts';
import { testSubscription } from '../../../support/member-keys.ts';

const entry = (change: Partial<SharedCatalogManifestEntry> = {}): SharedCatalogManifestEntry =>
  ({
    itemId: `itm_${'s'.repeat(22)}`,
    kind: 'skill',
    name: 'pdf-tools',
    summary: 'Split and merge',
    version: 3,
    digest: `sha256:${'ab'.repeat(32)}`,
    size: 10,
    publishedAt: '2026-10-31T09:00:00.000Z',
    ...change,
  }) as SharedCatalogManifestEntry;

const RLO = String.fromCodePoint(0x202e);
const ZWSP = String.fromCodePoint(0x200b);

describe('the facts to compare before joining', () => {
  it('reads the host of the publisher address, and hands back text that is not an address as it is', () => {
    expect(shareHost('https://box.example.test:8443/x')).toBe('box.example.test:8443');
    expect(shareHost('not an address')).toBe('not an address');
  });

  it('gives the host, the first 20 characters of the fingerprint and the whole of it', () => {
    const facts = joinFacts(SEED);
    expect(facts.host).toBe('box.example.test');
    expect(facts.fingerprint).toBe(fingerprintHead(SEED.daemonId));
    expect(facts.fingerprint).toHaveLength(20);
    expect(facts.fingerprintFull).toBe(SEED.daemonId);
  });
});

describe('the countdown said aloud', () => {
  const ends = '2026-10-31T10:10:00.000Z';
  it('says nothing while there is time, then once under a minute, then that it is over', () => {
    expect(windowAnnouncement(passkeyWindow(ends, new Date('2026-10-31T10:01:00.000Z')))).toBe('');
    expect(windowAnnouncement(passkeyWindow(ends, new Date('2026-10-31T10:09:30.000Z')))).toBe(
      'Less than a minute left to add a passkey.',
    );
    expect(windowAnnouncement(passkeyWindow(ends, new Date('2026-10-31T10:10:00.000Z')))).toBe(WINDOW_CLOSED_SENTENCE);
  });
});

describe('a name for a publisher', () => {
  it('keeps 1 to 60 characters after trimming and says otherwise', () => {
    expect(nameProblem('Work')).toBeNull();
    expect(nameProblem('x'.repeat(60))).toBeNull();
    expect(nameProblem('   ')).toBe('Use between 1 and 60 characters.');
    expect(nameProblem('x'.repeat(61))).toBe('Use between 1 and 60 characters.');
  });
});

describe('an item line', () => {
  it('names the kind in words', () => {
    expect(kindLabel('skill')).toBe('Skill');
    expect(kindLabel('mcp')).toBe('MCP server');
    expect(kindLabel('artifact')).toBe('File');
  });

  it('shows the name, kind and version, with the summary apart, and writes hidden characters out', () => {
    const line = itemLine(entry({ name: `pdf${RLO}tools`, summary: `a${ZWSP}b` }));
    expect(line.title).toContain('Skill · version 3');
    expect(line.title).not.toContain(RLO);
    expect(line.summary).not.toContain(ZWSP);
  });
});

describe('a catalog block', () => {
  it('lists the items of a catalog that verified, and nothing but its problem for one that did not', async () => {
    const shared = await sharedItemFixture();
    const ok = catalogBlock(shared.view);
    expect(ok.kind).toBe('ok');
    expect(ok.kind === 'ok' ? ok.items.map(item => item.entry.itemId) : []).toEqual(shared.entries.map(e => e.itemId));
    const problem = catalogBlock({
      catalogId: shared.view.catalogId,
      name: 'Broken',
      revision: 1,
      problem: 'Not signed.',
    });
    expect(problem).toEqual({
      kind: 'problem',
      catalogId: shared.view.catalogId,
      name: 'Broken',
      sentence: 'Not signed.',
    });
    expect(catalogBlock({ catalogId: shared.view.catalogId, name: 'Odd', revision: 1 })).toMatchObject({
      kind: 'problem',
      sentence: '',
    });
  });
});

describe('a publisher card', () => {
  it('turns each answer into one state', async () => {
    const shared = await sharedItemFixture();
    expect(cardState(refusedAttempt())).toEqual({ kind: 'refused' });
    expect(cardState(failedAttempt('locked', 'Unlock with your passkey first.'))).toEqual({ kind: 'locked' });
    expect(cardState(failedAttempt('unreachable', 'offline'))).toEqual({ kind: 'offline' });
    expect(cardState(failedAttempt('other', 'That did not work.'))).toEqual({
      kind: 'failed',
      sentence: 'That did not work.',
    });
    expect(cardState(okAttempt(shared.browse))).toMatchObject({ kind: 'ok' });
  });

  it('is refused only when the key was marked refused', async () => {
    expect(isRefused(await testSubscription('a', { status: 'refused' }))).toBe(true);
    expect(isRefused(await testSubscription('a'))).toBe(false);
  });
});

describe('opening a link with a key already here', () => {
  it('says what was added', () => {
    const response = { added: [{ name: 'Team tools' }] } as unknown as SharedRedeemResponse;
    expect(redeemView({ kind: 'added', response })).toEqual({ kind: 'added', sentence: 'Added Team tools.' });
  });

  it('says its own sentence when refused, a default when there is none', () => {
    expect(redeemView({ kind: 'refused', sentence: 'Used up.' })).toEqual({ kind: 'refused', sentence: 'Used up.' });
    expect(redeemView({ kind: 'refused' })).toEqual({ kind: 'refused', sentence: JOIN_REFUSED_SENTENCE });
    expect(redeemView({ kind: 'added' })).toEqual({ kind: 'refused', sentence: JOIN_REFUSED_SENTENCE });
  });

  it('asks to unlock first when the controller said the key is locked', () => {
    expect(redeemView({ kind: 'refused', sentence: REDEEM_LOCKED_SENTENCE })).toEqual({
      kind: 'locked',
      sentence: UNLOCK_THEN_LINK,
    });
  });

  it('keeps the locked sentence in step with the one the controller says', () => {
    const locked = new FyHttpError('locked', 403, 'member_locked');
    expect(redeemRefusal(locked, 'https://app.example.test')).toBe(REDEEM_LOCKED_SENTENCE);
  });
});

describe('withdrawnSummary', () => {
  it('counts the withdrawn items nobody installed here, in plain words', () => {
    expect(withdrawnSummary([{ itemId: 'a' }], new Map()).rest).toBe(
      '1 item was withdrawn by the publisher. It cannot be installed.',
    );
    expect(withdrawnSummary([{ itemId: 'a' }, { itemId: 'b' }], new Map()).rest).toBe(
      '2 items were withdrawn by the publisher. They cannot be installed.',
    );
  });
  it('says nothing when nothing was withdrawn', () => {
    expect(withdrawnSummary([], new Map())).toEqual({ installed: [], rest: null });
  });
  it('matches an installed item by id, names it from the record and marks hidden characters', () => {
    const summary = withdrawnSummary([{ itemId: 'a' }, { itemId: 'b' }], new Map([['a', 'pdf\u202Etools']]));
    expect(summary.installed).toHaveLength(1);
    expect(summary.installed[0]?.itemId).toBe('a');
    expect(summary.installed[0]?.name).not.toContain('\u202E');
    expect(summary.rest).toBe('1 item was withdrawn by the publisher. It cannot be installed.');
    expect(WITHDRAWN_INSTALLED).toBe('Withdrawn by the publisher · it keeps working; no more updates');
  });
  it('never invents a name for an item it knows only by id', () => {
    expect(withdrawnSummary([{ itemId: 'zzz' }], new Map([['other', 'x']])).installed).toEqual([]);
  });
});
