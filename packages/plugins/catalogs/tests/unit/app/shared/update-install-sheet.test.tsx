import { beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { DaemonCallError } from '@ferretry/app';
import type { Attempt, UpdateSource } from '../../../../app/features/shared/shared-controller.ts';
import { NO_COMPARISON, PREVIEW_UNRELATED, UPDATE_BUTTON } from '../../../../app/features/shared/store-row-model.ts';
import {
  UpdateInstallSheet,
  type UpdateInstallSheetProps,
} from '../../../../app/features/shared/update-install-sheet.tsx';
import { fakeClient } from '../support/catalog-client.ts';
import { catalogChanges, installRecord } from '../support/catalog-views.ts';
import { click, settle } from '../support/dom-form.ts';
import { interact, mount } from '@ferretry/app/testing';
import { runAsync } from '@ferretry/app/testing';
import { settleUntil } from '@ferretry/app/testing';
import {
  deferred,
  failedAttempt,
  installedAtV1,
  machinePreview,
  okAttempt,
  refusedAttempt,
  type UpdateFixture,
  updateFixture,
} from '../support/shared-screens.ts';

/** Earlier files in the same run can leave screens behind, and the queries here read the whole document. */
beforeEach(() => {
  document.body.replaceChildren();
});

const q = (selector: string): HTMLElement | null => document.querySelector<HTMLElement>(selector);
const text = (): string => document.body.textContent ?? '';

let fx: UpdateFixture;
beforeAll(async () => {
  fx = await updateFixture();
});

const PREVIEW = 'POST /v1/catalog-installs/runtime/preview';
const APPLY = 'POST /v1/catalog-installs/runtime';
const SECRETS = 'GET /v1/secrets';

const sourceAt = (version: 1 | 2): UpdateSource => ({
  item: version === 1 ? fx.v1 : fx.v2,
  manifest: fx.opened.manifest,
  signedManifest: fx.view.signed as never,
  ...(version === 1 ? { signedVersions: fx.signedVersions } : {}),
  expectedDigest: fx.signedVersions.versions.offered.find(line => line.version === version)?.digest ?? '',
});

interface Rig {
  readonly calls: { method: string; path: string; body: unknown }[];
  readonly closed: string[];
  readonly done: string[];
  readonly refused: string[];
  readonly opened: unknown[][];
  unmount: () => Promise<void>;
}

async function open(
  handlers: Parameters<typeof fakeClient>[0],
  props: Partial<UpdateInstallSheetProps> = {},
  attempt: () => Promise<Attempt<UpdateSource>> = async () => okAttempt(sourceAt(2)),
): Promise<Rig> {
  const fake = fakeClient(handlers);
  const closed: string[] = [];
  const done: string[] = [];
  const refused: string[] = [];
  const opened: unknown[][] = [];
  const view = await mount(
    <UpdateInstallSheet
      members={{
        openVersion: async (...args: unknown[]) => {
          opened.push(args);
          return await attempt();
        },
      }}
      sub={{} as never}
      view={fx.view}
      entry={fx.entry}
      installed={installedAtV1(fx)}
      version={2}
      verb="Update"
      startAt="update"
      installHost={{ createClient: fake.factory }}
      onRefused={() => refused.push('refused')}
      onClose={() => closed.push('closed')}
      onDone={() => done.push('done')}
      {...props}
    />,
  );
  await settle();
  await settle();
  return { calls: fake.calls, closed, done, refused, opened, unmount: view.unmount };
}

const BUSY = new Set(['Updating…', 'Moving…']);
const idle = (): boolean =>
  q('[data-update-reading]') === null &&
  ![...document.querySelectorAll('button')].some(b => BUSY.has(b.textContent ?? ''));
const answer = async (selector: string) => {
  await click(q(selector));
  await settleUntil(idle, `the answer after tapping ${selector}`, runAsync);
};

const agree =
  (change: Record<string, unknown> = {}) =>
  () =>
    machinePreview(fx, 2, { changes: catalogChanges(), ...change });
const landed = () => ({ install: installRecord('skill', 'pdf-tools'), notes: ['Restart your agent.'] });

describe('asking this machine', () => {
  it('opens the version, asks the machine that holds the install, and shows the review with a passkey button', async () => {
    const rig = await open({ [PREVIEW]: agree() });
    expect(rig.opened).toHaveLength(1);
    expect(rig.opened[0]?.[3]).toBe(2);
    expect(rig.calls).toHaveLength(1);
    const body = rig.calls[0]?.body as Record<string, unknown>;
    expect(body.target).toEqual(installedAtV1(fx).install.target);
    expect('allowOlder' in body).toBe(false);
    expect(q('h2, h1, [role="dialog"]')?.textContent).toContain('Update');
    expect(q('[data-update-summary]')?.textContent).toContain('changed');
    expect(q('[data-catalog-install]')?.textContent).toBe(UPDATE_BUTTON);
    await rig.unmount();
  });

  it('shows nothing the machine did not say: no summary when it gave no comparison', async () => {
    const rig = await open({ [PREVIEW]: agree({ changes: undefined }) });
    expect(q('[data-update-summary]')).toBeNull();
    await rig.unmount();
  });

  it('says what the machine named as edited, on the review', async () => {
    const rig = await open({ [PREVIEW]: agree({ edited: { paths: ['SKILL.md'] } }) });
    expect(q('[data-update-edited-paths]')?.textContent).toBe('You changed: SKILL.md');
    await rig.unmount();
  });

  it('says it is reading while the version is fetched and the machine has not answered', async () => {
    const gate = deferred<Attempt<UpdateSource>>();
    const rig = await open({ [PREVIEW]: agree() }, {}, async () => await gate.promise);
    expect(q('[data-update-reading]')).not.toBeNull();
    gate.resolve(okAttempt(sourceAt(2)));
    await settle();
    await settle();
    expect(q('[data-update-reading]')).toBeNull();
    await rig.unmount();
  });

  it('asks the installer for an older version with allowOlder and carries the signed list', async () => {
    const rig = await open(
      { [PREVIEW]: () => machinePreview(fx, 1, { changes: catalogChanges() }) },
      {
        version: 1,
        verb: 'Move',
        signedVersions: fx.signedVersions,
        installed: installedAtV1(fx, { provenance: { ...installedAtV1(fx).install.provenance, version: 2 } }),
      },
      async () => okAttempt(sourceAt(1)),
    );
    const body = rig.calls[0]?.body as Record<string, unknown>;
    expect(body.allowOlder).toBe(true);
    expect(body.signedVersions).toEqual(fx.signedVersions);
    await rig.unmount();
  });

  it('hands back to the page when the publisher refused the key', async () => {
    const rig = await open({}, {}, async () => refusedAttempt());
    expect(rig.refused).toEqual(['refused']);
    expect(rig.calls).toHaveLength(0);
    await rig.unmount();
  });

  it('says why the version could not be opened and asks the machine nothing', async () => {
    const rig = await open({}, {}, async () => failedAttempt('gone', 'This item is gone.'));
    expect(q('[data-catalog-failure]')?.textContent).toContain('This item is gone.');
    expect(q('[data-catalog-preview-again]')).toBeNull();
    expect(rig.calls).toHaveLength(0);
    await rig.unmount();
  });

  it('does not use a review that names something other than what was asked for', async () => {
    const rig = await open({ [PREVIEW]: () => machinePreview(fx, 1) });
    expect(q('[data-catalog-failure]')?.textContent).toContain(PREVIEW_UNRELATED);
    expect(q('[data-catalog-install]')).toBeNull();
    await rig.unmount();
  });

  it('says what the machine refused, and offers the review again when it ran out', async () => {
    let calls = 0;
    const rig = await open({
      [PREVIEW]: () => {
        calls += 1;
        if (calls === 1) throw new DaemonCallError(410, 'catalog_preview_expired', 'gone');
        return agree()();
      },
    });
    expect(q('[data-catalog-failure]')?.textContent).toContain('10 minutes');
    await click(q('[data-catalog-preview-again]'));
    await settle();
    expect(q('[data-catalog-failure]')).toBeNull();
    expect(q('[data-catalog-install]')).not.toBeNull();
    await rig.unmount();
  });
});

describe('keep or replace local edits', () => {
  const edited = () => {
    throw new DaemonCallError(
      409,
      'catalog_install_edited',
      'Edited on this machine since it was installed: SKILL.md. Nothing was replaced. Look at what changes, then replace your edits or keep them.',
    );
  };

  it('offers Keep my edits and Replace my edits, and Keep changes nothing', async () => {
    const rig = await open({ [PREVIEW]: edited });
    const banner = q('[data-update-edited-banner]');
    expect(banner?.textContent).toBe('Not updated. You edited SKILL.md.');
    expect(banner?.className).toContain('bg-warn-bg');
    expect(banner?.className).not.toContain('err');
    expect(q('[data-catalog-failure]')).toBeNull();
    expect(q('[data-update-edited]')?.textContent).toContain(
      'Keep my edits leaves this install as it is. Replace my edits puts v2 over them.',
    );
    expect(q('[data-update-edited]')?.textContent).not.toContain('This install was edited');
    await click(q('[data-update-keep]'));
    expect(rig.closed).toEqual(['closed']);
    expect(rig.calls).toHaveLength(1);
    await rig.unmount();
  });

  it('asks again with replaceEdited when the person chooses Replace, then shows the review', async () => {
    let calls = 0;
    const rig = await open({
      [PREVIEW]: (body: unknown) => {
        calls += 1;
        if ((body as { replaceEdited?: boolean }).replaceEdited !== true) return edited();
        return agree({ edited: { paths: ['SKILL.md'] } })();
      },
    });
    expect(calls).toBe(1);
    await click(q('[data-update-replace]'));
    await settle();
    expect(calls).toBe(2);
    expect(rig.calls[1]?.body).toMatchObject({ replaceEdited: true });
    expect(q('[data-update-edited]')).toBeNull();
    expect(q('[data-update-edited-paths]')?.textContent).toContain('SKILL.md');
    expect(q('[data-catalog-install]')).not.toBeNull();
    await rig.unmount();
  });
});

describe('seeing the changes first', () => {
  it('opens on the diff the machine computed, and Update goes on to the passkey button', async () => {
    const rig = await open({ [PREVIEW]: agree() }, { startAt: 'changes' });
    expect(q('[data-update-changes]')).not.toBeNull();
    expect(q('[data-catalog-install]')).toBeNull();
    await click(q('[data-update-go]'));
    expect(q('[data-update-changes]')).toBeNull();
    expect(q('[data-catalog-install]')?.textContent).toBe(UPDATE_BUTTON);
    await rig.unmount();
  });

  it('says so when the machine could not compare', async () => {
    const rig = await open({ [PREVIEW]: agree({ changes: undefined }) }, { startAt: 'changes' });
    expect(q('[data-update-no-comparison]')?.textContent).toBe(NO_COMPARISON);
    await rig.unmount();
  });
});

describe('the passkey', () => {
  it('writes nothing until the person taps, then shows what landed and goes back to the row on Done', async () => {
    const rig = await open({ [PREVIEW]: agree(), [APPLY]: landed });
    expect(rig.calls.map(call => call.path)).toEqual(['/v1/catalog-installs/runtime/preview']);
    await answer('[data-catalog-install]');
    expect(rig.calls.at(-1)?.path).toBe('/v1/catalog-installs/runtime');
    expect(q('[data-catalog-installed]')?.textContent).toContain('version 1');
    expect(q('[data-catalog-note]')?.textContent).toContain('Restart your agent.');
    expect(q('[data-catalog-destination]')).not.toBeNull();
    await click(q('[data-catalog-done]'));
    expect(rig.done).toEqual(['done']);
    await rig.unmount();
  });

  it('keeps the review and says nothing changed when the passkey was not confirmed', async () => {
    const rig = await open({
      [PREVIEW]: agree(),
      [APPLY]: () => {
        throw new DaemonCallError(403, 'grant_step_up_required', 'step up');
      },
    });
    await answer('[data-catalog-install]');
    expect(text()).toContain('passkey wasn’t confirmed');
    expect(q('[data-catalog-installed]')).toBeNull();
    expect(q('[data-catalog-install]')).not.toBeNull();
    await rig.unmount();
  });

  it('says Move on the button of a move', async () => {
    const rig = await open({ [PREVIEW]: agree() }, { verb: 'Move' });
    expect(q('[data-catalog-install]')?.textContent).toContain('Move');
    await rig.unmount();
  });
});

describe('secrets', () => {
  const withToken = (change: Record<string, unknown> = {}) =>
    agree({ secrets: [{ placeholder: 'ACME_TOKEN' }], ...change });
  const list = () => ({
    v: 1,
    health: 'ready',
    secrets: [{ name: 'ACME_TOKEN', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }],
    references: [],
  });

  it('reads the machine’s secret names when the review lists placeholders, and takes a pick and its undoing', async () => {
    const rig = await open({ [PREVIEW]: withToken(), [SECRETS]: list });
    expect(rig.calls.map(call => call.path)).toContain('/v1/secrets');
    const select = '[data-catalog-secret="ACME_TOKEN"] select';
    const choose = async (value: string) => {
      const element = q(select) as HTMLSelectElement;
      await interact(() => {
        element.value = value;
        element.dispatchEvent(new Event('change', { bubbles: true }));
      });
    };
    await choose('ACME_TOKEN');
    expect(q('[data-catalog-secret-note]')?.textContent).toBe('This program will receive your secret ACME_TOKEN.');
    await choose('');
    expect(q('[data-catalog-secret-note]')).toBeNull();
    await rig.unmount();
  });

  it('says the names could not be read when the machine will not list them', async () => {
    const rig = await open({
      [PREVIEW]: withToken(),
      [SECRETS]: () => {
        throw new Error('down');
      },
    });
    expect(q('[data-catalog-secrets]')?.textContent).toContain('could not be read');
    await rig.unmount();
  });
});

describe('answers that arrive late', () => {
  it('drops a secrets answer, or a failed one, that arrives after the review was asked for again', async () => {
    const late = deferred<unknown>();
    const lateFail = deferred<unknown>();
    let previews = 0;
    let lists = 0;
    const rig = await open({
      [PREVIEW]: () => {
        previews += 1;
        return machinePreview(fx, 2, { changes: catalogChanges(), secrets: [{ placeholder: 'ACME_TOKEN' }] });
      },
      [SECRETS]: async () => {
        lists += 1;
        if (lists === 1) return await late.promise;
        if (lists === 2) return await lateFail.promise;
        return { v: 1, health: 'ready', secrets: [], references: [] };
      },
      [APPLY]: () => {
        throw new DaemonCallError(409, 'catalog_install_edited', 'SKILL.md was edited');
      },
    });
    expect(previews).toBe(1);
    late.resolve({
      v: 1,
      health: 'ready',
      secrets: [{ name: 'LATE', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }],
      references: [],
    });
    await settle();
    await rig.unmount();
    lateFail.resolve(null);
  });

  it('keeps only the newest review when the person asks again before the first came back', async () => {
    const first = deferred<unknown>();
    let previews = 0;
    const rig = await open({
      [PREVIEW]: async () => {
        previews += 1;
        if (previews === 1) return await first.promise;
        return agree()();
      },
    });
    expect(q('[data-update-reading]')).not.toBeNull();
    expect(previews).toBe(1);
    first.resolve(agree()());
    await settle();
    await rig.unmount();
  });
});

describe('edited again after the review', () => {
  it('shows keep or replace, with the paths the machine listed, when the apply finds the files edited again', async () => {
    let applies = 0;
    const rig = await open({
      [PREVIEW]: agree({ edited: { paths: ['SKILL.md'] } }),
      [APPLY]: () => {
        applies += 1;
        throw new DaemonCallError(409, 'catalog_install_edited', 'SKILL.md was edited');
      },
    });
    await answer('[data-catalog-install]');
    expect(applies).toBe(1);
    expect(q('[data-update-edited-paths]')?.textContent).toContain('SKILL.md');
    await click(q('[data-update-replace]'));
    await settle();
    expect(rig.calls.filter(call => call.path.endsWith('/preview'))).toHaveLength(2);
    expect(rig.calls.at(-1)?.body).toMatchObject({ replaceEdited: true });
    await rig.unmount();
  });
});
