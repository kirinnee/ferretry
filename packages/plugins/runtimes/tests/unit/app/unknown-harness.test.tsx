import { describe, expect, test } from 'bun:test';
import { THIRD_HARNESS_KEY } from '@ferretry/core-ferrets/contract/testing';
import {
  RuntimeEffortControls,
  RuntimeModelChoices,
  RuntimeModelControls,
} from '../../../app/components/runtime-controls.tsx';
import { runsHarness, profileFit, profilesFitFirst } from '../../../app/features/fleet/runtimes/runtimes-model.ts';
import { HARNESSES } from '../../../app/features/import-kit/model.ts';
import { becomes } from '../../../app/features/import-kit/mapping-words.ts';
import { emptyMemory, readMemory, setOf, withMemory } from '../../../app/features/import-wizard/wizard-memory.ts';
import { pickerAccount } from '../../../app/lib/account-picker-catalog.ts';
import type { RuntimeSessionView } from '../../../app/lib/session-view.ts';
import { isAddRuntimeSignInSlotProps } from '../../../contract/slots.ts';
import { unsupportedHarnessSentence } from '../../../contract/harness-words.ts';
import { mount } from '../support/dom.ts';
import { runtimeView } from './support/picker.ts';
import type { LayeredProfileView } from '../../../contract/index.ts';

/**
 * RUNTIMES PLAN U4b part 1b: the app never reads a harness it has no row for as Claude. Each former "if codex … else Claude"
 * is shown here refusing the fake third harness with the one sentence, and the two shipped harnesses staying as they were.
 */
const SENTENCE = unsupportedHarnessSentence(THIRD_HARNESS_KEY);

const thirdView = (): RuntimeSessionView => ({
  config: { id: 's-third', harness: THIRD_HARNESS_KEY },
  state: { status: 'running', promptReady: true },
});

const noCatalogs = { load: () => Promise.reject(new Error('a catalog must not be fetched for an unusable harness')) };
const api = { runtime: () => Promise.reject(new Error('nothing may be sent for an unusable harness')) };

describe('a running ferret on a harness the app has no behaviour for', () => {
  test('the model picker says the sentence and shows no control, and fetches nothing', async () => {
    const screen = await mount(
      <RuntimeModelControls
        api={api}
        canControl
        catalogs={noCatalogs}
        onClose={() => undefined}
        open
        view={thirdView()}
      />,
    );
    expect(screen.container.textContent).toContain(SENTENCE);
    expect(screen.container.querySelector('button')).toBeNull();
    expect(screen.container.textContent).not.toContain('Claude');
    await screen.unmount();
  });

  test('the reasoning picker says the sentence and shows neither the Claude levels nor the Codex step', async () => {
    const screen = await mount(
      <RuntimeEffortControls api={api} canControl catalogs={noCatalogs} onClose={() => undefined} view={thirdView()} />,
    );
    expect(screen.container.textContent).toContain(SENTENCE);
    expect(screen.container.querySelector('button')).toBeNull();
    await screen.unmount();
  });

  test('the choice list does not describe it as Claude', async () => {
    const screen = await mount(
      <RuntimeModelChoices
        choices={[{ value: 'x', label: 'X', reasoningEfforts: [] }]}
        disabled={false}
        error={null}
        harness={THIRD_HARNESS_KEY}
        onChoose={() => undefined}
      />,
    );
    expect(screen.container.textContent).not.toContain('Claude');
    expect(screen.container.textContent).toContain(SENTENCE);
    await screen.unmount();
  });
});

describe('a runtime on a harness the app has no behaviour for', () => {
  const third = runtimeView({ wrapper: 'third-a', harness: THIRD_HARNESS_KEY, launch: { available: true } });

  test('is never offered to start on, and says why in the one sentence, even if the daemon said it could launch', () => {
    const row = pickerAccount(third);
    expect(row.kind).toBe(THIRD_HARNESS_KEY);
    expect(row.available).toBe(false);
    expect(row.unavailableReason).toBe(SENTENCE);
  });

  test('a shipped harness keeps the daemon’s own answer', () => {
    expect(pickerAccount(runtimeView({ wrapper: 'claude-a' }))).toMatchObject({
      available: true,
      unavailableReason: null,
    });
    expect(
      pickerAccount(runtimeView({ wrapper: 'codex-a', launch: { available: false, reason: 'Needs sign-in' } })),
    ).toMatchObject({ available: false, unavailableReason: 'Needs sign-in' });
  });

  test('fits no profile, and says the sentence', () => {
    const profile = { scope: { kind: 'scoped', scope: 'generic' }, harnesses: [] } as unknown as LayeredProfileView;
    expect(profileFit(profile, THIRD_HARNESS_KEY)).toEqual({ fits: false, reason: SENTENCE });
    expect(profileFit(profile, 'codex').fits).toBe(true);
  });

  test('a login that drives no tool fits nothing and is never read as Claude', () => {
    expect(runsHarness([], null)).toBeUndefined();
    const profile = { scope: { kind: 'scoped', scope: 'generic' }, harnesses: [] } as unknown as LayeredProfileView;
    expect(profilesFitFirst([profile], [])[0]?.fit.fits).toBe(false);
  });

  test('gets no sign-in panel', () => {
    expect(isAddRuntimeSignInSlotProps({ harness: THIRD_HARNESS_KEY, onSignedIn: () => undefined })).toBe(false);
    expect(isAddRuntimeSignInSlotProps({ harness: 'codex', onSignedIn: () => undefined })).toBe(true);
  });
});

describe('the import wizard walks the harnesses it has behaviour for', () => {
  test('exactly the two shipped, Claude Code first', () => {
    expect([...HARNESSES]).toEqual(['claude-code', 'codex']);
    expect(becomes('claude-code', 'settings')).toBe('Claude settings');
    expect(becomes('codex', 'settings')).toBe('Codex settings');
    expect(becomes(THIRD_HARNESS_KEY, 'settings')).toBe(`${THIRD_HARNESS_KEY} settings`);
  });

  test('what it remembers in the address is the same bytes for the two shipped harnesses, and keeps a third’s', () => {
    const memory = { ...emptyMemory(), tool: 1 };
    expect(withMemory('', memory)).toBe(
      `?fyimport=${encodeURIComponent(
        JSON.stringify({
          tool: 1,
          names: {},
          left: { 'claude-code': [], codex: [] },
          ticked: { 'claude-code': [], codex: [] },
          declined: { 'claude-code': [], codex: [] },
          ends: {},
          finished: false,
        }),
      )}`,
    );
    const third = readMemory(
      `?fyimport=${encodeURIComponent(JSON.stringify({ ticked: { [THIRD_HARNESS_KEY]: ['TOKEN'] } }))}`,
    );
    expect([...setOf(third.ticked, THIRD_HARNESS_KEY)]).toEqual(['TOKEN']);
    expect([...setOf(third.ticked, 'codex')]).toEqual([]);
  });
});
