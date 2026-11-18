/**
 * THE COMPOSER IS ONE ROW OF CONTROLS AND A STATUS LINE OF READOUTS (owner points 6 and 7, 2026-11-17).
 *
 * `composer.tools` is one slot drawn in two places: the controls you act with (Conversation's attach, Voice's mic) stay in
 * the row beside the text box; Runtimes' model chip and Usage's quota are readouts and go on the status line under the
 * row, so a plugin's readout never takes the text box's room. Before this the whole slot was drawn in the row — the
 * model chip and `usage unknown` stacked beside the text box.
 */
import { describe, expect, test } from 'bun:test';
// The testing barrel is the shell stand-in every suite that mounts a slot uses.
import { ensureDom, render, run, WithSlotPanels } from '@ferretry/app/testing';
import { Composer } from '../../../../app/composer/composer.tsx';
import { ComposerAttachPanel } from '../../../../app/composer/composer-attach.tsx';
import { DaemonDraftStore, type DraftStorage } from '../../../../app/composer/drafts.ts';
import { daemonConnection } from '../../../../app/composer/seam.ts';
import { withClient } from '../../../support/app/composer-host.tsx';

ensureDom();

class MemoryStorage implements DraftStorage {
  readonly values = new Map<string, string>();
  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

const slots = {
  'composer.tools': [
    { plugin: 'conversation', id: 'attachments', view: () => <ComposerAttachPanel /> },
    { plugin: 'voice', id: 'dictation', view: () => <button type="button">mic</button> },
    { plugin: 'runtimes', id: 'runtime-picker', view: () => <button type="button">opus · high · fast</button> },
    { plugin: 'usage', id: 'composer-quota', view: () => <span>5h 12%</span> },
    { plugin: 'someone', id: 'extra-control', view: () => <button type="button">extra</button> },
  ],
};

const mount = () =>
  render(
    withClient(
      <WithSlotPanels slots={slots}>
        <Composer
          api={{ send: async () => ({}) as never }}
          daemon={daemonConnection('status-line')}
          draftStore={new DaemonDraftStore(new MemoryStorage())}
          ferretId="zoe"
        />
      </WithSlotPanels>,
    ),
  );

const panelsIn = (container: {
  findAll: (test: (node: never) => boolean) => readonly { props: Record<string, unknown> }[];
}) =>
  container
    .findAll(node => typeof (node as { props: Record<string, unknown> }).props['data-panel'] === 'string')
    .map(node => node.props['data-panel'])
    .filter((value, index, all) => all.indexOf(value) === index);

describe('the composer slot, drawn in the row and on the status line', () => {
  test('the controls stay in the row; the readouts (model chip, usage) are on the status line, not in the row', () => {
    const composer = mount();
    const row = composer.root.findByProps({ className: 'fy-composer-row' });
    const status = composer.root.findByProps({ 'data-composer-status': '' });

    expect(panelsIn(row as never)).toEqual(['conversation.attachments', 'voice.dictation', 'someone.extra-control']);
    expect(panelsIn(status as never)).toEqual(['runtimes.runtime-picker', 'usage.composer-quota']);
    run(() => composer.unmount());
  });
});
