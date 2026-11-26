import { describe, expect, it } from 'bun:test';
import {
  createSkillsProvider,
  createSkillSigilProvider,
} from '../../../app/composer/composer-autocomplete-providers.ts';
import type { ComposerProviderContext, ComposerTrigger } from '../../../app/composer/composer-autocomplete.ts';
import { daemonConnection, daemonFerretScope } from '../../../app/composer/seam.ts';
import { parseLedgerSendRecord } from '../../../app/chat/send-ledger.ts';
import { conversationsQuery } from '../../../app/links/continue-model.ts';
import { harnessKeyOf } from '../../../app/links/link-words.ts';
import { parsePaneActivity } from '../../../app/transcript/pane-activity.ts';
import { fakeClient } from '../../support/app/fake-client.ts';

/**
 * The closed-harness sweep of Conversation's app (runtimes plan U4b part 3b): a harness the contract never named
 * (`fake-third`) is read by its own key and refused where the app would have drawn it as Claude or Codex. Each assertion
 * was a quiet Claude (or Codex) answer, or a dropped value, before the sweep. Fixture values only.
 */
const THIRD = 'fake-third';

const context = (trigger: ComposerTrigger, query: string): ComposerProviderContext => ({
  query,
  match: { trigger, triggerText: trigger, query, start: 0, end: query.length + 1, caret: query.length + 1 },
  signal: new AbortController().signal,
});

describe('a harness the app has no words for', () => {
  it('is no key this app draws (the shipped two are)', () => {
    expect(harnessKeyOf(THIRD)).toBeUndefined();
    expect(harnessKeyOf('claude-code')).toBe('claude-code');
    expect(harnessKeyOf('codex')).toBe('codex');
    expect(harnessKeyOf('claude')).toBeUndefined();
  });

  it('is a source chip the daemon search narrows to, never read as "all"', () => {
    const search = { text: '', date: 'any' as const };
    expect(conversationsQuery(THIRD, search, 0, 10)).toMatchObject({ harness: THIRD });
    expect(conversationsQuery('codex', search, 0, 10)).toMatchObject({ harness: 'codex' });
    expect(conversationsQuery('computer', search, 0, 10).harness).toBeUndefined();
  });

  it('shows no status line from a frame of the shipped CLIs', () => {
    const claudeFrame = '✻ Fixing stall detection… (5m 45s · esc to interrupt)';
    expect(parsePaneActivity(claudeFrame)).toMatchObject({ harness: 'claude' });
    expect(parsePaneActivity(claudeFrame, 'claude')).toMatchObject({ harness: 'claude' });
    expect(parsePaneActivity(claudeFrame, THIRD)).toBeNull();
  });

  it('keeps the harness a ledger send names as the daemon wrote it', () => {
    const parsed = parseLedgerSendRecord({
      sendId: 's1',
      acceptedAt: '2026-11-06T08:23:30.000Z',
      evidence: { key: 'k1', harness: THIRD },
    });
    expect(parsed?.evidence?.harness).toBe(THIRD);
  });

  it('is offered no skill or command spelling in the composer, and the menu names it', async () => {
    const client = fakeClient(() => ({ ferret: 'f', prefix: '/', provided: true, entries: [] }));
    const daemon = daemonConnection('daemon-a');
    const options = { daemon, scope: daemonFerretScope(daemon, 'f'), client, harness: { unreadable: THIRD } };

    for (const provider of [createSkillsProvider(options), createSkillSigilProvider(options)]) {
      const trigger = provider.trigger;
      const result = await provider.candidates(context(trigger, ''));
      expect(result.candidates).toEqual([]);
      expect(result.contextLabel).toContain(THIRD);
      expect(result.notice).toContain(THIRD);
    }
    expect(client.calls).toEqual([]);
  });
});
