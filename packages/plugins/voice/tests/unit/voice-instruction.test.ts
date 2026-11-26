import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { buildSnapshot } from '@ferretry/kernel/host';
import { splitVoice } from '@ferretry/plugin-conversation/contract';
import manifest from '../../manifest.ts';

/**
 * The words a lead ferret reads about voice mode (`instructions/voice.md`): pinned exactly so a change shows in review,
 * and checked against the `<voice>` grammar they teach (Conversation's `contract/voice-tag.ts`: closed segments, lower
 * case, one paragraph, never inside code), so the teaching cannot drift from what the page draws and the voice says.
 */
const PACKAGE = join(import.meta.dir, '../..');
const read = (path: string): string | undefined => readFileSync(join(PACKAGE, path), 'utf8');
const TEXT = read('instructions/voice.md')?.trim() ?? '';

describe('the Voice instruction', () => {
  test('says exactly this', () => {
    expect(TEXT).toBe(
      'Voice: a message that starts with `(voice)` was spoken aloud, and the person hears only your `<voice>…</voice>` lines. A message that starts with `(voice mode on)` switches this on: speak first, narrate as you work, speak the result. Your very first output must be `<voice>one short line</voice>`, before you call any tool, even a read. While you work, add one short `<voice>` line at each real step, at most one every 15 seconds, never filler. End the turn with `<voice>1-3 plain sentences</voice>` that give the result. Never wait for speech to finish; keep working. Inside the tags: no code, paths, lists or IDs. Close every line in the same paragraph, never inside code. Text outside the tags is shown, not spoken. If a message begins with `[heard up to: "…"; not heard: "…"]`, the person cut you off: carry on from the not heard part and do not repeat what was heard.',
    );
  });

  test('V1: teaches each rule of voice mode, in the order a ferret meets them', () => {
    const rules = [
      'message that starts with `(voice mode on)` switches this on',
      'Your very first output must be',
      'before you call any tool',
      'add one short `<voice>` line at each real step',
      'at most one every 15 seconds',
      'never filler',
      'End the turn with',
      '1-3 plain sentences',
      'Never wait for speech to finish',
      'If a message begins with `[heard up to: "…"; not heard: "…"]`',
      'do not repeat what was heard',
    ];
    let at = -1;
    for (const rule of rules) {
      const found = TEXT.indexOf(rule);
      expect(found).toBeGreaterThan(at);
      at = found;
    }
  });

  test('is one paragraph, short enough to read every turn, with nothing `printf` would eat', () => {
    expect(TEXT).not.toContain('\n');
    expect(TEXT.length).toBeLessThan(1_000);
    expect(TEXT).not.toMatch(/['%]/u);
  });

  test("is Voice's own, declared once for a lead on every harness (a helper never talks to the person)", () => {
    expect(manifest.instructions?.filter(entry => entry.id === 'voice')).toHaveLength(1);
    expect(manifest.instructions?.find(entry => entry.id === 'voice')).toEqual({
      id: 'voice',
      text: 'instructions/voice.md',
      when: { role: 'lead' },
    });
  });

  test('the real snapshot built from this manifest and the real file carries it', () => {
    const snapshot = buildSnapshot([manifest], [], (plugin, path) => (plugin === 'voice' ? read(path) : undefined));
    const entry = snapshot.instructions.find(each => each.id === 'voice');
    expect(String(entry?.plugin)).toBe('voice');
    expect(entry?.when).toEqual({ role: 'lead' });
    expect(entry?.text.trim()).toBe(TEXT);
  });
});

describe('the Voice instruction teaches the grammar the page reads', () => {
  const examples = [...TEXT.matchAll(/`(<voice>[^`]*<\/voice>)`/gu)].map(match => match[1] ?? '');

  test('names the tag three times in code, and the prompt itself is no spoken reply', () => {
    expect(examples).toHaveLength(3);
    expect(splitVoice(TEXT).filter(piece => piece.kind === 'voice')).toEqual([]);
  });

  test('each closed example is exactly one finished spoken line', () => {
    for (const example of examples.slice(1)) {
      const lines = splitVoice(example).filter(piece => piece.kind === 'voice');
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatchObject({ kind: 'voice', open: false });
    }
  });

  test('a reply that follows it (a line first, work, a line last) has two spoken lines', () => {
    const reply = '<voice>Let me check.</voice>\n\nI ran the tests; all pass.\n\n<voice>All tests pass.</voice>';
    expect(
      splitVoice(reply)
        .filter(piece => piece.kind === 'voice')
        .map(piece => [piece.text, piece.open]),
    ).toEqual([
      ['Let me check.', false],
      ['All tests pass.', false],
    ]);
  });

  test('a line that runs across a paragraph, or sits in code, is not spoken, as the text says', () => {
    expect(splitVoice('<voice>First half.\n\nsecond half.</voice>').filter(piece => piece.kind === 'voice')).toEqual(
      [],
    );
    expect(splitVoice('```\n<voice>Quoted.</voice>\n```').filter(piece => piece.kind === 'voice')).toEqual([]);
  });
});
