import { afterEach, describe, expect, it } from 'bun:test';
import {
  AccountListSchema,
  LOGIN_TOTP_WARNING,
  TWO_FACTOR_ERROR_CODES,
  TWO_FACTOR_SEED_CARD_MISMATCH_LINE,
  type TwoFactorStageId,
} from '@ferretry/protocol';
import type { ComponentProps } from 'react';
import { TwoFactorSeedHost } from '../../../src/features/input-request/two-factor-seed-host.tsx';
import { daemonConnection } from '../../../src/lib/daemon-connection.ts';
import { createAppStore, StoreProvider } from '../../../src/lib/store.tsx';
import { seedAllowBlocked, seedCardFacts } from '../../../src/lib/two-factor-seed-card.ts';
import { type Mounted, mount } from '../../support/dom.ts';
import { click, settle } from '../../support/dom-form.ts';
import { type Call, fakeClient } from '../../support/input-fixtures.ts';

const mounted: Mounted[] = [];
afterEach(async () => {
  for (const each of mounted.splice(0)) await each.unmount();
});

const AT = '2026-10-31T10:00:00.000Z';
const STAGE = `st_${'a'.repeat(24)}` as TwoFactorStageId;
const connection = daemonConnection({ daemonId: 'workshop', baseUrl: 'https://workshop.example.test', deviceId: 't1' });
const KEY_BYTES = 'JBSWY3DPEHPK3PXP';

const accountList = () =>
  AccountListSchema.parse({
    v: 1,
    health: 'ready',
    accounts: [
      {
        id: 'GITHUB',
        label: 'GitHub',
        username: 'kirinnee',
        fields: { password: true, totp: false },
        factors: [],
        signIns: [],
        createdAt: AT,
        updatedAt: AT,
      },
    ],
    signIns: [],
  });

const item = (mismatch = false): ComponentProps<typeof TwoFactorSeedHost>['item'] => ({
  twoFactorSeed: { stage: STAGE, account: 'GITHUB' },
  // The daemon's words name the place only: agenda text is every ferret's to read.
  subject: 'Save automatic codes to your account on github.com?',
  why: 'Asked by fy on kirin-box at 10:00 UTC. If you didn’t just ask for this, Deny.',
  context: [
    ...(mismatch ? [`- ${TWO_FACTOR_SEED_CARD_MISMATCH_LINE}`] : []),
    '- Password and code both come from this machine then: together they are one factor.',
  ].join('\n'),
});

interface Served {
  readonly state?: 'waiting' | 'saved' | 'dropped' | 'expired';
  readonly failCommit?: unknown;
  readonly failDrop?: unknown;
  readonly failRead?: unknown;
  /** Fail only the first reads of the stage, then answer. */
  readonly failReads?: number;
  readonly flag?: boolean;
  /** A daemon from before the flag existed: the view carries no `mismatch`. */
  readonly omitFlag?: boolean;
  /** The accounts list no longer holds the staged account. */
  readonly noAccount?: boolean;
}

const served = ({
  state = 'waiting',
  failCommit,
  failDrop,
  failRead,
  failReads = 0,
  flag = false,
  omitFlag = false,
  noAccount = false,
}: Served = {}) => {
  let failed = 0;
  const machine = fakeClient((call: Call) => {
    if (call.path === '/v1/accounts') return noAccount ? { ...accountList(), accounts: [] } : accountList();
    if (call.method === 'DELETE') {
      if (failDrop !== undefined) throw failDrop;
      return { stage: STAGE, dropped: true };
    }
    if (call.path.endsWith('/commit')) {
      if (failCommit !== undefined) throw failCommit;
      return {
        account: 'GITHUB',
        factor: {
          id: 'tf_000000000002',
          kind: 'totp',
          label: 'Authenticator app',
          params: { algorithm: 'SHA1', digits: 6, period: 30 },
          addedAt: AT,
          addedBy: 'owner',
          automatic: true,
        },
        mismatch: false,
      };
    }
    if (failRead !== undefined) throw failRead;
    if (failed < failReads) {
      failed += 1;
      throw new Error('offline');
    }
    return {
      stage: STAGE,
      account: 'GITHUB',
      label: 'Authenticator app',
      state,
      expiresAt: AT,
      ...(omitFlag ? {} : { mismatch: flag }),
      issuer: 'GitHub',
      accountName: 'kirinnee',
    };
  });
  return machine;
};

const draw = async (
  over: Served & {
    readonly mismatch?: boolean;
    readonly allowKey?: boolean;
    readonly withoutKey?: boolean;
  },
) => {
  const machine = served(over);
  const asked: { stage: TwoFactorStageId; words: string }[] = [];
  const view = await mount(
    <TwoFactorSeedHost
      {...(over.withoutKey === true
        ? {}
        : {
            addKey: async (stage: TwoFactorStageId, words: string) => {
              asked.push({ stage, words });
              return over.allowKey ?? true;
            },
          })}
      connection={connection}
      createClient={async () => machine.client}
      item={item(over.mismatch)}
    />,
  );
  mounted.push(view);
  for (let tries = 0; tries < 4; tries += 1) await settle();
  const q = (selector: string) => view.container.querySelector<HTMLElement>(selector);
  return { view, q, calls: machine.calls, asked };
};

const seedCalls = (calls: readonly Call[]) => calls.filter(call => call.path.includes('/factors/seed'));

describe('the owner card for a staged 2FA seed', () => {
  it('should read the daemon’s words, name the account, and offer Allow only after the warning is ticked', async () => {
    const card = await draw({});

    // The account and what the key says come from the reads, never from the agenda item's text.
    expect(card.q('[data-seed-subject]')?.textContent).toBe('Save automatic codes to GitHub · kirinnee?');
    expect(card.q('[data-seed-why]')).toBeNull();
    expect(card.q('[data-seed-lines]')?.textContent).toContain('The key says it is for GitHub · kirinnee.');
    expect(card.q('[data-seed-lines]')?.textContent).toContain('together they are one factor');
    expect(card.q('[data-seed-warning]')?.textContent).toBe(LOGIN_TOTP_WARNING);
    expect(card.q('[data-seed-mismatch]')).toBeNull();
    expect((card.q('[data-seed-allow]') as HTMLButtonElement).disabled).toBe(true);
    await click(card.q('[data-seed-allow]'));
    expect(seedCalls(card.calls).filter(call => call.method !== 'GET')).toEqual([]);

    await click(card.q('[data-seed-warning-tick]'));
    expect((card.q('[data-seed-allow]') as HTMLButtonElement).disabled).toBe(false);
  });

  it('should keep the daemon’s place-only words when the account cannot be named from the reads (C3)', async () => {
    const card = await draw({ noAccount: true });

    expect(card.q('[data-seed-subject]')?.textContent).toBe('Save automatic codes to your account on github.com?');
    expect(card.q('[data-seed-subject]')?.textContent).not.toContain('kirinnee');
  });

  it('should ask for the passkey bound to THIS stage, then commit with no body', async () => {
    const card = await draw({});

    await click(card.q('[data-seed-warning-tick]'));
    await click(card.q('[data-seed-allow]'));
    for (let tries = 0; tries < 3; tries += 1) await settle();

    expect(card.asked).toEqual([{ stage: STAGE, words: 'save automatic codes to GitHub · kirinnee' }]);
    const commit = card.calls.find(call => call.method === 'POST');
    expect(commit?.path).toBe(`/v1/accounts/GITHUB/factors/seed/${STAGE}/commit`);
    expect(commit?.body).toBeUndefined();
    expect(card.q('[data-seed-done]')?.textContent).toContain('Saved.');
    expect(JSON.stringify(card.calls)).not.toContain(KEY_BYTES);
  });

  it('should draw the amber box for a mismatched stage and hold Allow until its tick is given too', async () => {
    const card = await draw({ mismatch: true });

    expect(card.q('[data-seed-mismatch]')).not.toBeNull();
    expect(card.q('[data-seed-lines]')?.textContent).not.toContain('save it here anyway');
    await click(card.q('[data-seed-warning-tick]'));
    expect((card.q('[data-seed-allow]') as HTMLButtonElement).disabled).toBe(true);
    expect(card.q('[data-seed-blocked]')?.textContent).toContain('Save it here anyway');
    await click(card.q('[data-seed-mismatch-tick]'));
    expect((card.q('[data-seed-allow]') as HTMLButtonElement).disabled).toBe(false);
  });

  it('should leave the stage waiting, and say so, when the passkey is dismissed', async () => {
    const card = await draw({ allowKey: false });

    await click(card.q('[data-seed-warning-tick]'));
    await click(card.q('[data-seed-allow]'));
    for (let tries = 0; tries < 3; tries += 1) await settle();

    expect(card.q('[data-seed-failed]')?.textContent).toContain('did not confirm');
    expect(card.calls.filter(call => call.method !== 'GET')).toEqual([]);
    expect(card.q('[data-seed-allow]')).not.toBeNull();
  });

  it('should drop the stage on Deny without a passkey and say nothing was saved', async () => {
    const card = await draw({});

    await click(card.q('[data-seed-deny]'));
    for (let tries = 0; tries < 3; tries += 1) await settle();

    expect(card.asked).toEqual([]);
    const drop = card.calls.find(call => call.method === 'DELETE');
    expect(drop?.path).toBe(`/v1/accounts/GITHUB/factors/seed/${STAGE}`);
    expect(card.q('[data-seed-done]')?.textContent).toContain('Denied');
    expect(card.q('[data-seed-allow]')).toBeNull();
  });

  it('should show the daemon’s refusal in words when the commit fails', async () => {
    const card = await draw({
      failCommit: Object.assign(new Error('gone'), { code: TWO_FACTOR_ERROR_CODES.stageGone }),
    });

    await click(card.q('[data-seed-warning-tick]'));
    await click(card.q('[data-seed-allow]'));
    for (let tries = 0; tries < 3; tries += 1) await settle();

    expect(card.q('[data-seed-failed]')?.textContent).toContain('timed out');
  });

  it('should show a stage that is no longer waiting as finished, with no Allow', async () => {
    const card = await draw({ state: 'expired' });

    expect(card.q('[data-seed-done]')?.textContent).toContain('no longer waiting');
    expect(card.q('[data-seed-allow]')).toBeNull();
  });

  it('should ask the real step-up for the add-2fa-key act when no key is injected', async () => {
    const machine = served();
    const store = await createAppStore({
      repository: { load: async () => null, save: async () => undefined },
      connectClient: async () => ({}) as never,
      fetcher: async () => Response.json({}),
    });
    const view = await mount(
      <StoreProvider store={store}>
        <TwoFactorSeedHost connection={connection} createClient={async () => machine.client} item={item()} />
      </StoreProvider>,
    );
    mounted.push(view);
    for (let tries = 0; tries < 4; tries += 1) await settle();

    await click(view.container.querySelector('[data-seed-warning-tick]'));
    await click(view.container.querySelector('[data-seed-allow]'));
    for (let tries = 0; tries < 3; tries += 1) await settle();

    expect(store.stepUp.snapshot()?.acts).toEqual(['save automatic codes to GitHub · kirinnee']);
    store.stepUp.dismiss();
    for (let tries = 0; tries < 4; tries += 1) await settle();
    expect(view.container.querySelector('[data-seed-failed]')?.textContent).toContain('did not confirm');
    expect(machine.calls.filter(call => call.method !== 'GET')).toEqual([]);
  });
});

describe('the seed card’s failure and flag paths', () => {
  it('should draw the amber box from the daemon’s structured flag even with no mismatch sentence in the words', async () => {
    const card = await draw({ flag: true });

    expect(card.q('[data-seed-mismatch]')).not.toBeNull();
    await click(card.q('[data-seed-warning-tick]'));
    expect((card.q('[data-seed-allow]') as HTMLButtonElement).disabled).toBe(true);
    await click(card.q('[data-seed-mismatch-tick]'));
    expect((card.q('[data-seed-allow]') as HTMLButtonElement).disabled).toBe(false);
  });

  it('should not draw the box when only the daemon’s sentence is missing and no flag is set', async () => {
    const card = await draw({});

    expect(card.q('[data-seed-mismatch]')).toBeNull();
  });

  it('should send a stage this app cannot see to a paired device, and leave the card up on any other failed read', async () => {
    const gone = await draw({ failRead: { status: 404, code: TWO_FACTOR_ERROR_CODES.stageGone } });
    const broken = await draw({ failRead: new Error('offline') });

    expect(gone.q('[data-seed-done]')?.textContent).toContain('confirm it from a paired device');
    expect(gone.q('[data-seed-allow]')).toBeNull();
    expect(broken.q('[data-seed-allow]')).not.toBeNull();
    expect(broken.q('[data-seed-done]')).toBeNull();
  });

  it('should keep Allow off while it is not known whether the key was staged as a mismatch, until a read succeeds', async () => {
    const card = await draw({ failReads: 1, flag: true });

    await click(card.q('[data-seed-warning-tick]'));
    expect(card.q('[data-seed-unchecked]')?.textContent).toContain('Could not check this key');
    expect((card.q('[data-seed-allow]') as HTMLButtonElement).disabled).toBe(true);
    expect(card.q('[data-seed-mismatch]')).toBeNull();

    await click(card.q('[data-seed-retry]'));
    for (let tries = 0; tries < 3; tries += 1) await settle();

    expect(card.q('[data-seed-unchecked]')).toBeNull();
    expect(card.q('[data-seed-mismatch]')).not.toBeNull();
    expect((card.q('[data-seed-allow]') as HTMLButtonElement).disabled).toBe(true);
    await click(card.q('[data-seed-mismatch-tick]'));
    expect((card.q('[data-seed-allow]') as HTMLButtonElement).disabled).toBe(false);
  });

  it('should allow a key the daemon says is no mismatch, and an older daemon that sends no flag, going by its sentence', async () => {
    const plain = await draw({ flag: false });
    const older = await draw({ omitFlag: true, mismatch: true });

    await click(plain.q('[data-seed-warning-tick]'));
    expect((plain.q('[data-seed-allow]') as HTMLButtonElement).disabled).toBe(false);
    expect(plain.q('[data-seed-mismatch]')).toBeNull();
    expect(older.q('[data-seed-mismatch]')).not.toBeNull();
    expect(older.q('[data-seed-unchecked]')).toBeNull();
  });

  it('should say a device without passkeys cannot save it, and keep the card', async () => {
    const card = await draw({ withoutKey: true });

    await click(card.q('[data-seed-warning-tick]'));
    await click(card.q('[data-seed-allow]'));
    for (let tries = 0; tries < 3; tries += 1) await settle();

    expect(card.q('[data-seed-failed]')?.textContent).toContain('cannot confirm with a passkey');
    expect(card.calls.filter(call => call.method !== 'GET')).toEqual([]);
  });

  it('should say Denied once the stage is dropped, and say why when the drop failed', async () => {
    const denied = await draw({});
    const refused = await draw({ failDrop: { status: 404, code: TWO_FACTOR_ERROR_CODES.stageGone } });

    await click(denied.q('[data-seed-deny]'));
    for (let tries = 0; tries < 3; tries += 1) await settle();
    await click(refused.q('[data-seed-deny]'));
    for (let tries = 0; tries < 3; tries += 1) await settle();

    expect(denied.calls.some(call => call.method === 'DELETE')).toBe(true);
    expect(denied.q('[data-seed-done]')?.textContent).toContain('Denied');
    expect(refused.q('[data-seed-failed]')?.textContent).toContain('timed out');
  });
});

describe('the seed card’s model', () => {
  it('should split the daemon’s bullets and lift the mismatch line out', () => {
    const facts = seedCardFacts(`- one\n- ${TWO_FACTOR_SEED_CARD_MISMATCH_LINE}\n- two`);
    expect(facts).toEqual({ lines: ['one', 'two'], mismatch: true });
    expect(seedCardFacts(undefined)).toEqual({ lines: [], mismatch: false });
    expect(seedCardFacts('- one', true)).toEqual({ lines: ['one'], mismatch: true });
  });

  it('should block until every needed tick is given', () => {
    expect(seedAllowBlocked({ mismatch: false, warningTick: false, mismatchTick: false })).toBeDefined();
    expect(seedAllowBlocked({ mismatch: true, warningTick: true, mismatchTick: false })).toBeDefined();
    expect(seedAllowBlocked({ mismatch: true, warningTick: true, mismatchTick: true })).toBeUndefined();
    expect(seedAllowBlocked({ mismatch: false, warningTick: true, mismatchTick: false })).toBeUndefined();
  });
});
