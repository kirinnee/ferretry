import { afterEach, describe, expect, test } from 'bun:test';
import type { ResolvedAttentionItem } from '@ferretry/protocol';
import {
  ATTENTION_RESOLVED_ACTION_ID,
  AttentionResolvedList,
  byNewestResolution,
  resolvedActionContribution,
  resolvedWords,
} from '../../../src/features/attention/attention-resolved.tsx';
import '../../support/dom.ts';
import { type Mounted, mount, must } from '../../support/dom.ts';

const record = (
  id: string,
  resolvedAt: string,
  overrides: Partial<Record<keyof ResolvedAttentionItem, unknown>> = {},
): ResolvedAttentionItem =>
  ({
    id,
    source: 'agent-raised',
    sourceRef: null,
    subject: `Ask ${id}`,
    why: 'Why.',
    waitingSince: '2026-07-31T09:00:00.000Z',
    howToResolve: 'Answer it.',
    ask: { kind: 'permission' },
    raisedBy: 'agent',
    raisedBySession: 'shared',
    raisedByName: 'zoe',
    resolvedAt,
    resolvedBy: 'human',
    resolvedBySession: null,
    resolvedByName: null,
    resolutionNote: null,
    disposition: 'resolved',
    response: { kind: 'permission', decision: 'approve' },
    ...overrides,
  }) as ResolvedAttentionItem;

let view: Mounted | null = null;
afterEach(async () => {
  await view?.unmount();
  view = null;
});

describe('the resolved records', () => {
  test('say the count in plain words and sort the newest resolution first', () => {
    expect(resolvedWords(7)).toBe('7 resolved');
    const older = record('A1', '2026-07-31T10:00:00.000Z');
    const newer = record('A2', '2026-07-31T11:00:00.000Z');
    expect([older, newer].sort(byNewestResolution).map(r => r.id)).toEqual(['A2', 'A1']);
  });

  test('the list shows each record newest first with how it was cleared, and rings the linked one', async () => {
    view = await mount(
      <AttentionResolvedList
        highlighted="A1"
        panelId="attn"
        records={[
          record('A1', '2026-07-31T10:00:00.000Z'),
          record('A2', '2026-07-31T11:00:00.000Z', {
            disposition: 'dismissed',
            response: null,
            resolutionNote: 'Superseded by A3.',
          }),
        ]}
      />,
    );
    const c = must(view.container, 'view');
    const rows = [...c.querySelectorAll('[data-attention-record]')];
    expect(rows.map(row => row.getAttribute('data-attention-record'))).toEqual(['A2', 'A1']);
    expect(rows[0]?.textContent).toContain('dismissed by you');
    expect(rows[0]?.textContent).toContain('Superseded by A3.');
    expect(rows[1]?.getAttribute('data-highlighted')).toBe('true');
    expect(rows[0]?.hasAttribute('data-highlighted')).toBe(false);
    expect(document.activeElement?.id).toBe('attn-item-A1');
  });

  test('an empty list says so', async () => {
    view = await mount(<AttentionResolvedList panelId="attn" records={[]} />);
    expect(must(view.container, 'view').querySelector('[data-attention-resolved-empty]')).not.toBeNull();
  });

  test('the menu entry is "N resolved" and is absent when there is no history', () => {
    const entry = resolvedActionContribution([record('A1', '2026-07-31T10:00:00.000Z')], 'attn', null).build(undefined);
    expect(entry).toMatchObject({ kind: 'form', id: ATTENTION_RESOLVED_ACTION_ID, label: '1 resolved' });
    expect(resolvedActionContribution([], 'attn', null).build(undefined)).toBeNull();
  });
});
