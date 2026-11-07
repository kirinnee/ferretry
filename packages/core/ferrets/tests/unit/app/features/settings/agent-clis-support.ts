import type { HarnessCliView, HarnessUpdateView } from '@ferretry/protocol';

export const CHANGELOG = 'https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md';
export const VERIFIED_URL = 'https://github.com/kirinnee/ferretry/blob/main/packages/fleet/tests/contract/README.md';
const PREFIX = '/home/kirin/.nvm/versions/node/v22';

/** Claude Code from an nvm npm global: 2.1.200 runs, 2.1.220 is verified, 2.1.230 is on npm. */
export const claudeCli = (overrides: Partial<HarnessCliView> = {}): HarnessCliView => ({
  harness: 'claude',
  location: { state: 'located', path: `${PREFIX}/bin/claude`, rule: 'inherited environment', declaredBy: 'PATH' },
  installed: { state: 'ok', version: '2.1.200' },
  method: { kind: 'npm-global', tool: 'npm', package: '@anthropic-ai/claude-code', prefix: PREFIX, nodeManager: 'nvm' },
  plan: {
    kind: 'self',
    steps: [{ command: `npm install -g --prefix ${PREFIX} @anthropic-ai/claude-code@latest` }],
    rollback: 'automatic',
    pinsVersion: true,
  },
  check: { state: 'ok', checkedAt: '2026-10-20T11:58:00.000Z', latest: { version: '2.1.230', url: CHANGELOG } },
  verified: { version: '2.1.220', url: VERIFIED_URL },
  verification: 'older',
  available: true,
  job: null,
  ...overrides,
});

/** Codex from a Homebrew cask: 0.145.0 (verified) runs, 0.163.0 is on npm. */
export const codexCli = (overrides: Partial<HarnessCliView> = {}): HarnessCliView => ({
  harness: 'codex',
  location: { state: 'located', path: '/opt/homebrew/bin/codex', rule: 'inherited environment', declaredBy: 'PATH' },
  installed: { state: 'ok', version: '0.145.0' },
  method: { kind: 'homebrew', type: 'cask', package: 'codex' },
  plan: {
    kind: 'self',
    steps: [{ command: 'brew update' }, { command: 'brew upgrade --cask codex' }],
    rollback: 'none',
    pinsVersion: false,
  },
  check: {
    state: 'ok',
    checkedAt: '2026-10-20T11:58:00.000Z',
    latest: { version: '0.163.0', url: 'https://github.com/openai/codex/releases/tag/rust-v0.163.0' },
  },
  verified: { version: '0.145.0', url: VERIFIED_URL },
  verification: 'verified',
  available: true,
  job: null,
  ...overrides,
});

export const clisView = (...harnesses: HarnessCliView[]): HarnessUpdateView => ({
  harnesses: harnesses.length === 0 ? [claudeCli(), codexCli()] : harnesses,
});
