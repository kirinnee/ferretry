import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { DaemonUpdateViewSchema, planUpdate } from '../../../contract/index.ts';
import { UpdatesView } from '../../../app/views/updates-settings.tsx';

const LATEST = { version: '4.29.0', url: 'https://github.com/kirinnee/ferretry/releases/tag/v4.29.0' };
const standalone = { kind: 'standalone', directory: '/opt/ferretry' } as const;

const view = (overrides: Record<string, unknown> = {}) =>
  DaemonUpdateViewSchema.parse({
    current: '4.28.0',
    method: standalone,
    plan: planUpdate(standalone, { product: 'ferretry', clientName: 'fy' }),
    check: { state: 'ok', checkedAt: '2026-10-18T09:00:00.000Z', latest: LATEST },
    available: true,
    midTurn: 0,
    autoInstall: false,
    job: null,
    ...overrides,
  });

const html = (overrides: Record<string, unknown> = {}, note: string | null = null) =>
  renderToStaticMarkup(
    <UpdatesView view={view(overrides)} note={note} readError={null} onStart={() => {}} onAutoInstall={() => {}} />,
  );

describe('Settings › Updates', () => {
  test('says what runs, how it was installed, whether it is behind, and when it last checked', () => {
    const markup = html();
    expect(markup).toContain('4.28.0');
    expect(markup).toContain('Installed via standalone binary in /opt/ferretry');
    expect(markup).toContain('Update available');
    expect(markup).toContain('This daemon is behind: 4.28.0 runs, 4.29.0 is out.');
    expect(markup).toContain('Last checked:');
    expect(markup).toContain('4.29.0');
  });
  test('offers the update, now or when no ferret is mid-turn, only when one exists', () => {
    expect(html()).toContain('Update when no ferret is mid-turn');
    const current = html({ available: false });
    expect(current).toContain('Up to date');
    expect(current).not.toContain('Update when no ferret is mid-turn');
  });
  test('the automatic-install choice is a switch that says where it stands, and carries the rollback note', () => {
    const off = html();
    expect(off).toContain('role="switch"');
    expect(off).toContain('aria-checked="false"');
    expect(html({ autoInstall: true })).toContain('aria-checked="true"');
  });
  test('a daemon that has never checked says so, and a refusal note is shown', () => {
    const markup = html({ available: false, check: { state: 'never' } }, 'Waiting for your confirmation: x.');
    expect(markup).toContain('Not checked');
    expect(markup).toContain('Not checked yet');
    expect(markup).toContain('Waiting for your confirmation: x.');
  });
});
