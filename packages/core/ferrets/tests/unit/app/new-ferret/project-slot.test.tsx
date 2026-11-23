import { describe, expect, it } from 'bun:test';
import { NEW_FERRET_PROJECT_SLOT, type NewFerretProjectSlotProps } from '@ferretry/core-ferrets/contract';
import { WithSlotPanels } from '@ferretry/app/testing';
import type { ReactNode } from 'react';
import type { ReactTestInstance, ReactTestRendererJSON } from 'react-test-renderer';
import { NewFerretPage } from '../../../../app/features/new-ferret/new-ferret-page.tsx';
import { run, runAsync, render } from '../support/react.ts';
import { scripted, type Call } from '../support/client.ts';

/** A stand-in for Projects' panel: a box carrying the page's id, recent folders, and a row that proposes a folder through `onPick`. */
const stubProjects = (props: Record<string, unknown>): ReactNode => {
  const slot = props as unknown as NewFerretProjectSlotProps;
  return (
    <section data-new-ferret-projects="">
      <output data-id={slot.id} data-recent={slot.recent.join(',')} data-value={slot.value} />
      <button data-row="p2" onClick={() => slot.onPick(FOLDER)} type="button">
        project two
      </button>
    </section>
  );
};

const FOLDER = '/work/p2 ';

const page = (calls: Call[] = [], ferrets: unknown[] = []) =>
  render(
    <WithSlotPanels
      slots={{ [NEW_FERRET_PROJECT_SLOT]: [{ plugin: 'projects', id: 'new-ferret-projects', view: stubProjects }] }}
    >
      <NewFerretPage
        AccountSlot={({ fallback }) => fallback}
        client={scripted({ 'GET /v1/ferrets': ferrets, 'POST /v1/ferrets': { id: 'new-ferret' } }, calls)}
        daemon="daemon/a"
        onNavigate={() => undefined}
      />
    </WithSlotPanels>,
  );

/** Every host element in draw order, depth first. */
const hostsOf = (node: ReactTestRendererJSON | ReactTestRendererJSON[] | null): ReactTestRendererJSON[] => {
  if (node === null) return [];
  if (Array.isArray(node)) return node.flatMap(hostsOf);
  return [node, ...(node.children ?? []).flatMap(child => (typeof child === 'string' ? [] : hostsOf(child)))];
};

describe('the New ferret page and the project slot', () => {
  it('draws the where-it-works panel IN PLACE of the Folder box, handing it the label id and the recent folders, and a pick fills the folder', () => {
    const view = page(
      [],
      [
        { folder: '/work/old', stateAt: '2026-11-01T00:00:00.000Z' },
        { folder: '/work/new', stateAt: '2026-11-02T00:00:00.000Z' },
      ],
    );
    // The panel carries the page's label id; the page draws no folder box of its own beside it.
    expect(
      view.root.findAll(node => typeof node.type === 'string' && node.props.id === 'fy-new-ferret-folder'),
    ).toHaveLength(0);
    const out = (): Record<string, unknown> => view.root.findByType('output').props;
    expect(out()['data-id']).toBe('fy-new-ferret-folder');
    expect(out()['data-value']).toBe('');

    run(() => view.root.findByProps({ 'data-row': 'p2' }).props.onClick());
    expect(out()['data-value']).toBe(FOLDER);
  });

  it('keeps the typed Folder box when nothing contributes the panel', () => {
    const view = render(
      <NewFerretPage
        AccountSlot={({ fallback }) => fallback}
        client={scripted({ 'GET /v1/ferrets': [] }, [])}
        daemon="daemon/a"
        onNavigate={() => undefined}
      />,
    );
    expect(
      view.root.findAll(node => typeof node.type === 'string' && node.props.id === 'fy-new-ferret-folder').length,
    ).toBeGreaterThan(0);
  });

  it('starts in the picked project exactly as registered: a trailing space is not trimmed into a sibling folder', async () => {
    const calls: Call[] = [];
    const view = page(calls);
    run(() => view.root.findByProps({ 'data-row': 'p2' }).props.onClick());
    const found = (predicate: (node: ReactTestInstance) => boolean): ReactTestInstance => {
      const node = view.root.findAll(predicate).at(0);
      if (node === undefined) throw new Error('missing element');
      return node;
    };
    const typeInto = (id: string, value: string): void =>
      run(() =>
        found(node => typeof node.type === 'string' && node.props.id === id).props.onChange({ target: { value } }),
      );
    typeInto('fy-new-ferret-runtime', 'claude-auto-loge');
    typeInto('fy-new-ferret-prompt', 'Go');
    const create = found(node => node.type === 'button' && node.children.join('') === 'Create ferret');
    await runAsync(async () => create.props.onClick());
    expect(calls.find(call => call.route === 'POST /v1/ferrets')?.body).toMatchObject({ folder: FOLDER });
  });
});
