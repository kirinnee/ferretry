import { type ConfigItemKind, ItemCommandError, itemFlag } from '@ferretry/kernel/manifest';

/** The tool a person names: `claude` is Claude Code, whose key is the plugin's id. */
function harnessKeyOf(word: string): 'claude-code' | 'codex' {
  if (word === 'claude' || word === 'claude-code') return 'claude-code';
  if (word === 'codex') return 'codex';
  throw new ItemCommandError(`--harness takes claude or codex, got "${word}".`);
}

/**
 * `config/instructions/<name>.yaml`: guidance every session reads first. Runtimes owns the kind (no other plugin does).
 * The text is `--text <words>` or `--file <path>` (`-` reads standard input); an edit without either keeps the text it has.
 */
export function instructionsItemKind(readText: ((path: string) => Promise<string>) | undefined): ConfigItemKind {
  return {
    collection: 'instructions',
    noun: 'instructions item',
    layer: 'instructions',
    command: 'instruction',
    async fields(invocation, current) {
      const file = itemFlag(invocation, 'file');
      const given = itemFlag(invocation, 'text');
      const description = itemFlag(invocation, 'description');
      const harness = itemFlag(invocation, 'harness');
      if (file !== undefined && given !== undefined)
        throw new ItemCommandError('Give the text with --text or --file, not both.');
      const document: Record<string, unknown> = { ...(current ?? {}) };
      if (given !== undefined) document.text = given;
      if (file !== undefined) {
        if (readText === undefined)
          throw new ItemCommandError('This terminal cannot read a file, so --file is not available here.');
        try {
          document.text = await readText(file);
        } catch {
          throw new ItemCommandError(`Could not read ${file}.`);
        }
      }
      if (description !== undefined) document.description = description;
      if (harness !== undefined) document.harness = harnessKeyOf(harness);
      if (typeof document.text !== 'string' || document.text.trim() === '')
        throw new ItemCommandError('An instructions item needs its text: add --file <path> or --text <words>.');
      return document;
    },
    details(document) {
      const text = typeof document.text === 'string' ? document.text : '';
      const first = text.split('\n').find(line => line.trim() !== '') ?? '';
      return [
        ...(typeof document.description === 'string' ? [`About: ${document.description}`] : []),
        ...(typeof document.harness === 'string' ? [`For: ${document.harness}`] : []),
        `Text: ${String(text.length)} characters${first === '' ? '' : `, starting "${first.length > 60 ? `${first.slice(0, 57)}...` : first}"`}`,
      ];
    },
  };
}
