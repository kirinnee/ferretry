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
      'Voice: a message that starts with `(voice)` was spoken aloud, and the person hears your `<voice>…</voice>` lines. Before any tool, reply with `<voice>one short line</voice>`; end the turn with `<voice>1-3 plain sentences</voice>`. Inside the tags: no code, paths, lists or IDs. Close every line in the same paragraph, never inside code. Text outside the tags is shown, not spoken.',
    );
  });

  test('is one short paragraph, about sixty tokens, with nothing `printf` would eat', () => {
    expect(TEXT).not.toContain('\n');
    expect(TEXT.length).toBeLessThan(450);
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
