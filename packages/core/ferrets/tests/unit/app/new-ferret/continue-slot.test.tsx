import { describe, expect, it } from 'bun:test';
import {
  type ContinuePick,
  NEW_FERRET_CONTINUE_SLOT,
  type NewFerretAccountSlotProps,
  type NewFerretContinueSlotProps,
} from '@ferretry/core-ferrets/contract';
import { WithSlotPanels } from '@ferretry/app/testing';
import type { ReactNode } from 'react';
import type { ReactTestInstance } from 'react-test-renderer';
import { NewFerretPage } from '../../../../app/features/new-ferret/new-ferret-page.tsx';
import { initialContinueOf } from '../../../../app/views/new-ferret.tsx';
import { run, runAsync, render } from '../support/react.ts';
import { scripted, type Call } from '../support/client.ts';

const PICK: ContinuePick = {
  key: 'conversation:codex:c-77',
  harness: 'codex',
  conversation: 'c-77',
  folder: '/work/api',
  title: 'Fix the api',
};

/** A stand-in for Conversation's list: one row, which puts a past conversation into the form through the slot's `onPick`. */
const stubList = (props: Record<string, unknown>): ReactNode => {
  const slot = props as unknown as NewFerretContinueSlotProps;
  return (
    <section data-continue-list="" data-picked={slot.picked ?? ''}>
      <button data-row="c-77" onClick={() => slot.onPick(PICK)} type="button">
        pick
      </button>
    </section>
  );
};

const page = (calls: Call[] = [], accountSlots: NewFerretAccountSlotProps[] = []) =>
  render(
    <WithSlotPanels
      slots={{ [NEW_FERRET_CONTINUE_SLOT]: [{ plugin: 'conversation', id: 'new-ferret-continue', view: stubList }] }}
    >
      <NewFerretPage
        AccountSlot={({ slot, fallback }) => {
          accountSlots.push(slot);
          return fallback;
        }}
        client={scripted({ 'GET /v1/ferrets': [], 'POST /v1/ferrets': { id: 'resumed' } }, calls)}
        daemon="daemon/a"
        onNavigate={() => undefined}
      />
    </WithSlotPanels>,
  );

const found = (view: ReturnType<typeof render>, predicate: (node: ReactTestInstance) => boolean): ReactTestInstance => {
  const node = view.root.findAll(predicate).at(0);
  if (node === undefined) throw new Error('missing element');
  return node;
};
const byId = (view: ReturnType<typeof render>, id: string): ReactTestInstance =>
  found(view, node => typeof node.type === 'string' && node.props.id === id);
const choice = (view: ReturnType<typeof render>, text: string): ReactTestInstance =>
  found(
    view,
    node => node.type === 'button' && node.props['aria-pressed'] !== undefined && node.children.join('') === text,
  );
const NEW = 'New conversation';
const CONTINUE = 'Continue a conversation';
const typeInto = (view: ReturnType<typeof render>, id: string, value: string): void =>
  run(() => byId(view, id).props.onChange({ target: { value } }));

describe('the New ferret page and the continue slot', () => {
  it('opens on a "New conversation | Continue a conversation" switch at the top, and Continue shows the list in place', () => {
    const view = page();
    expect(choice(view, NEW).props['aria-pressed']).toBe(true);
    expect(choice(view, CONTINUE).props['aria-pressed']).toBe(false);
    expect(view.root.findAllByProps({ 'data-continue-list': '' })).toHaveLength(0);
    run(() => choice(view, CONTINUE).props.onClick());
    expect(view.root.findAllByProps({ 'data-continue-list': '' })).toHaveLength(1);
    expect(choice(view, CONTINUE).props['aria-pressed']).toBe(true);
    expect(choice(view, NEW).props['aria-pressed']).toBe(false);
    // The form is still there: fresh and continue are ONE page.
    expect(byId(view, 'fy-new-ferret-prompt')).toBeTruthy();
    // And back: the list goes, nothing is folded behind a disclosure.
    run(() => choice(view, NEW).props.onClick());
    expect(view.root.findAllByProps({ 'data-continue-list': '' })).toHaveLength(0);
    expect(view.root.findAll(node => node.props['aria-controls'] === 'fy-new-ferret-continue-list')).toHaveLength(0);
  });

  it('opens with the list shown when the address asks for it (`?continue=1`: the Runtimes and setup links)', () => {
    expect(initialContinueOf('?continue=1')).toBe(true);
    expect(initialContinueOf('?agent=a&continue=1')).toBe(true);
    expect(initialContinueOf('')).toBe(false);
    expect(initialContinueOf('?continue=0')).toBe(false);
    const view = render(
      <WithSlotPanels
        slots={{ [NEW_FERRET_CONTINUE_SLOT]: [{ plugin: 'conversation', id: 'new-ferret-continue', view: stubList }] }}
      >
        <NewFerretPage
          AccountSlot={({ fallback }) => fallback}
          client={scripted({ 'GET /v1/ferrets': [] }, [])}
          daemon="daemon/a"
          initialContinue
          onNavigate={() => undefined}
        />
      </WithSlotPanels>,
    );
    expect(view.root.findAllByProps({ 'data-continue-list': '' })).toHaveLength(1);
    expect(choice(view, CONTINUE).props['aria-pressed']).toBe(true);
  });

  it('draws no switch at all when nothing contributes a list', () => {
    const view = render(
      <NewFerretPage
        AccountSlot={({ fallback }) => fallback}
        client={scripted({ 'GET /v1/ferrets': [] }, [])}
        daemon="daemon/a"
        onNavigate={() => undefined}
      />,
    );
    expect(view.root.findAll(node => node.props['data-new-ferret-continue'] !== undefined)).toHaveLength(0);
  });

  it('a pick fills the folder, limits the runtime picker to its harness, and Create resumes THAT conversation', async () => {
    const calls: Call[] = [];
    const accountSlots: NewFerretAccountSlotProps[] = [];
    const view = page(calls, accountSlots);
    run(() => choice(view, CONTINUE).props.onClick());
    run(() => view.root.findByProps({ 'data-row': 'c-77' }).props.onClick());

    expect(byId(view, 'fy-new-ferret-folder').props.value).toBe('/work/api');
    expect(accountSlots.at(-1)?.harness).toBe('codex');
    // The list folds away once a conversation is in the form.
    expect(view.root.findAllByProps({ 'data-continue-list': '' })).toHaveLength(0);
    expect(found(view, node => node.props['data-new-ferret-picked'] === PICK.key)).toBeTruthy();
    expect(JSON.stringify(view.toJSON())).toContain('Continuing: ');
    expect(JSON.stringify(view.toJSON())).toContain('Fix the api');

    // The auto|interactive choice is still the page's own, and Create is the ordinary start.
    typeInto(view, 'fy-new-ferret-runtime', 'codex-main');
    run(() =>
      found(
        view,
        node =>
          node.type === 'button' && node.props['aria-pressed'] === false && node.children.join('') === 'interactive',
      ).props.onClick(),
    );
    const create = found(view, node => node.type === 'button' && node.children.join('') === 'Create ferret');
    await runAsync(async () => create.props.onClick());
    expect(calls.find(call => call.route === 'POST /v1/ferrets')?.body).toMatchObject({
      runtime: 'codex-main',
      folder: '/work/api',
      mode: 'interactive',
      harnessConversation: 'c-77',
      // The pick's harness travels with the request, so the daemon refuses a runtime of the OTHER harness
      // (`runtime rt runs the claude-code harness, not codex`) even when the runtime field was typed by hand.
      harness: 'codex',
    });
  });

  it('a runtime typed for the OTHER harness is still sent with the picked harness, so the daemon can refuse the mismatch', async () => {
    const calls: Call[] = [];
    const view = page(calls, []);
    run(() => choice(view, CONTINUE).props.onClick());
    run(() => view.root.findByProps({ 'data-row': 'c-77' }).props.onClick());
    typeInto(view, 'fy-new-ferret-runtime', 'claude-main');
    typeInto(view, 'fy-new-ferret-prompt', 'carry on');
    const create = found(view, node => node.type === 'button' && node.children.join('') === 'Create ferret');
    await runAsync(async () => create.props.onClick());
    expect(calls.find(call => call.route === 'POST /v1/ferrets')?.body).toMatchObject({
      runtime: 'claude-main',
      harness: 'codex',
      harnessConversation: 'c-77',
    });
  });

  it('switching back to "New conversation" clears the pick: no conversation is sent and no harness limits the picker', async () => {
    const calls: Call[] = [];
    const accountSlots: NewFerretAccountSlotProps[] = [];
    const view = page(calls, accountSlots);
    run(() => choice(view, CONTINUE).props.onClick());
    run(() => view.root.findByProps({ 'data-row': 'c-77' }).props.onClick());
    run(() => choice(view, NEW).props.onClick());
    expect(view.root.findAllByProps({ 'data-continue-list': '' })).toHaveLength(0);
    expect(accountSlots.at(-1)?.harness).toBeUndefined();
    typeInto(view, 'fy-new-ferret-runtime', 'claude-auto');
    typeInto(view, 'fy-new-ferret-folder', '/work/web');
    typeInto(view, 'fy-new-ferret-prompt', 'Go');
    const create = found(view, node => node.type === 'button' && node.children.join('') === 'Create ferret');
    await runAsync(async () => create.props.onClick());
    const body = calls.find(call => call.route === 'POST /v1/ferrets')?.body as Record<string, unknown>;
    expect(body).toMatchObject({ folder: '/work/web', runtime: 'claude-auto' });
    expect(body).not.toHaveProperty('harnessConversation');
    expect(body).not.toHaveProperty('harness');
  });
});
