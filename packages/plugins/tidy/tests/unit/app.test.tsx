import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { AppHalf, PluginClient } from '@ferretry/kernel/manifest';
import app from '../../app/index.ts';
import { humanBytes, TidyView } from '../../app/view.tsx';
import type { ScratchPlanView } from '../../contract/index.ts';
import manifest from '../../manifest.ts';

const plan: readonly ScratchPlanView[] = [
  { ferret: 'a' as never, name: 'Ada', directory: '/x', bytes: 2_500_000, entries: [], eligible: true },
  { ferret: 'b' as never, directory: '/y', bytes: 10, entries: [], eligible: false, reason: 'not stopped' },
];

const html = (props: Partial<Parameters<typeof TidyView>[0]> = {}) =>
  renderToStaticMarkup(<TidyView plan={plan} sweeping={false} onSweep={() => {}} {...props} />);

describe('Tidy settings tab', () => {
  test('says what can be cleared and why the rest is kept', () => {
    const markup = html();
    expect(markup).toContain('2.5 MB can be cleared from 1 stopped ferret(s).');
    expect(markup).toContain('(kept: not stopped)');
    expect(markup).not.toContain('disabled');
  });
  test('has nothing to press while there is nothing to clear, and says it is reading before it knows', () => {
    expect(html({ plan: [] })).toContain('Nothing to clear right now.');
    expect(html({ plan: [] })).toContain('disabled');
    expect(html({ plan: undefined })).toContain('Reading what could be cleared…');
  });
  test('says what a sweep cleared, and what it could not', () => {
    const markup = html({ last: { ferrets: 1, bytes: 1_200_000, failures: 2 } });
    expect(markup).toContain('Cleared 1.2 MB from 1 ferret(s)');
    expect(markup).toContain('2 item(s) could not be removed.');
  });
  test('shows a read failure as an alert', () => {
    expect(html({ error: 'the daemon said no' })).toContain('role="alert"');
  });
  test('sizes are said like `fy gc` says them', () => {
    expect([humanBytes(900), humanBytes(2_000_000), humanBytes(3_100_000_000)]).toEqual(['1 kB', '2.0 MB', '3.1 GB']);
  });
  test('the app half serves the declared settings tab', () => {
    const client = { call: async () => [], subscribe: () => () => {} } as unknown as PluginClient;
    const half = app.build?.({ manifest, client }) as AppHalf<typeof manifest>;
    expect(Object.keys(half.settings)).toEqual(['tidy']);
    expect(typeof half.settings.tidy).toBe('function');
  });
});
