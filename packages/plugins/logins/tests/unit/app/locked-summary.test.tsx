/**
 * r11 O5 (from the O6 recheck): the locked add-login panel still showed OpenRouter's "Claude Code and Codex through
 * OpenRouter …" under the Codex page. The summary is now as ONE tool sees it. This test reads the REAL summaries out of
 * the daemon's endpoint data (not a made-up sentence), so a data change that names the other tool again is caught.
 */
import { describe, expect, it } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AddLoginPanel } from '../../../app/features/add-login-panel.tsx';
import { lockedSummary } from '../../../app/lib/locked-summary.ts';
import { login, loginList } from '../cli/fakes.ts';
import { interact, mount, must } from '../support/dom.ts';
import { type Call, scripted } from './support/client.ts';

const DATA = join(import.meta.dir, '../../../daemon/data/endpoints');
const OPEN = { capabilities: [{ capability: 'fleet', use: true, configure: true, configureRefusal: 'granted' }] };

/** `summary:` of one endpoint file, as the YAML says it. */
const summaryOf = (file: string): string => {
  const parsed = Bun.YAML.parse(readFileSync(join(DATA, file), 'utf8')) as { summary?: unknown };
  if (typeof parsed.summary !== 'string') throw new Error(`${file} has no summary`);
  return parsed.summary;
};
const FILES = readdirSync(DATA).filter(name => name.endsWith('.yaml'));

const settle = async (): Promise<void> => {
  for (let elapsed = 0; elapsed < 300; elapsed += 10)
    await interact(() => new Promise(resolve => setTimeout(resolve, 10)));
};

describe('a provider summary under a locked panel', () => {
  it('reads the real endpoint data', () => {
    expect(FILES.length).toBeGreaterThan(10);
    expect(summaryOf('openrouter.yaml')).toContain('Claude Code and Codex through OpenRouter');
  });

  for (const [lock, own, other] of [
    ['codex', 'Codex', 'Claude Code'],
    ['claude-code', 'Claude Code', 'Codex'],
  ] as const)
    it(`${own}: no real summary names ${other}, and the shared ones now name only ${own}`, () => {
      for (const file of FILES) {
        const said = lockedSummary(summaryOf(file), lock);
        expect(said, file).not.toContain(other);
        expect(said.length, file).toBeGreaterThan(0);
      }
      expect(lockedSummary(summaryOf('openrouter.yaml'), lock)).toStartWith(`${own} through OpenRouter with one key`);
    });

  it('drops a later sentence that names the other tool (MiniMax: "Codex 0.146.0 or newer …") for Claude Code', () => {
    const said = lockedSummary(summaryOf('minimax.yaml'), 'claude-code');
    expect(said).toStartWith('Claude Code on MiniMax models');
    expect(said).not.toContain('0.146.0');
    // Codex keeps its own advice.
    expect(lockedSummary(summaryOf('minimax.yaml'), 'codex')).toContain('Codex 0.146.0 or newer');
  });

  it('the panel draws it: OpenRouter picked in the Codex panel says Codex alone', async () => {
    const real = summaryOf('openrouter.yaml');
    const half = (harness: 'codex' | 'claude-code') => ({ harness, offered: { available: true }, models: [] });
    const variable = (name: string, harness: 'codex' | 'claude-code') => ({
      name,
      kind: 'secret',
      secret: 'OPENROUTER_API_KEY',
      required: true,
      allowEmpty: false,
      harnesses: [harness],
    });
    const preset = {
      id: 'openrouter',
      label: 'OpenRouter',
      harness: 'claude-code',
      group: 'popular',
      summary: real,
      docs: 'https://docs.example.test',
      origin: 'built-in',
      variables: [variable('ANTHROPIC_AUTH_TOKEN', 'claude-code'), variable('OPENAI_API_KEY', 'codex')],
      models: [],
      test: { available: true, spends: 'nothing', note: 'Free.' },
      quota: { source: 'none', note: 'n/a' },
      unverified: [],
      verified: '2026-10-16',
      offered: { available: true },
      halves: [half('claude-code'), half('codex')],
    };
    const calls: Call[] = [];
    const client = scripted(
      { 'GET /v1/logins/presets': { presets: [preset] }, 'GET /v1/logins': loginList(login()), 'GET /v1/grants': OPEN },
      calls,
    );
    const view = await mount(<AddLoginPanel client={client} harness="codex" />);
    await settle();
    await interact(() => {
      const ways = must(view.container.querySelector<HTMLDetailsElement>('[data-add-login-other-ways]'), 'the fold');
      ways.open = true;
      ways.dispatchEvent(new Event('toggle'));
    });
    await settle();
    await interact(() =>
      must(view.container.querySelector<HTMLElement>('[data-provider-tile="openrouter"]'), 'tile').click(),
    );
    await settle();
    const picked = must(view.container.querySelector('[data-add-login-preset="openrouter"]'), 'the form');
    expect(picked.textContent).toContain('Codex through OpenRouter with one key');
    expect(picked.textContent).not.toContain('Claude Code');
    expect(view.container.textContent).not.toContain('Claude');
    await view.unmount();
  });
});
