import type { DaemonUpdateView } from '@ferretry/protocol';

export const latestRelease = { version: '4.29.0', url: 'https://github.com/kirinnee/ferretry/releases/tag/v4.29.0' };

/** A machine's update view: Homebrew, 4.28.0, with 4.29.0 known. */
export const updateView = (overrides: Partial<DaemonUpdateView> = {}): DaemonUpdateView => ({
  current: '4.28.0',
  method: { kind: 'homebrew', cask: 'ferretry' },
  plan: {
    kind: 'self',
    steps: [{ command: 'brew upgrade --cask ferretry' }, { command: 'fy daemon restart' }],
    rollback: 'none',
  },
  check: { state: 'ok', checkedAt: '2026-10-18T10:00:00.000Z', latest: latestRelease },
  available: true,
  midTurn: 0,
  autoInstall: false,
  job: null,
  ...overrides,
});
