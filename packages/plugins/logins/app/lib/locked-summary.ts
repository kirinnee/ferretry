/**
 * A provider's one-sentence summary as ONE tool sees it. Presets shared by both tools (OpenRouter, DeepSeek, Kimi, MiniMax)
 * open with "Claude Code and Codex …", and a panel locked to one tool must not name the other. The opening names collapse to
 * the locked tool, and any later sentence that still names the other tool (MiniMax's "Codex 0.146.0 or newer …") is dropped.
 * Pure: the daemon's own text is never changed, so Settings keeps the both-tools sentence.
 */
import { harnessName, supportedHarnessKeys } from '../../contract/harness-words.ts';
import type { HarnessKind } from './logins-view.ts';

const BOTH = 'Claude Code and Codex';

export function lockedSummary(summary: string, lock: HarnessKind): string {
  const others = supportedHarnessKeys()
    .filter(key => key !== lock)
    .map(harnessName);
  const own = harnessName(lock);
  const sentences = summary.replaceAll(BOTH, own).split(/(?<=\.)\s+/u);
  const kept = sentences.filter(sentence => !others.some(other => sentence.includes(other)));
  return kept.length === 0
    ? others.reduce((text, other) => text.replaceAll(other, own), sentences[0] ?? summary)
    : kept.join(' ');
}
