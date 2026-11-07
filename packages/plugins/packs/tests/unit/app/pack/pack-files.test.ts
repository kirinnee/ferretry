import { describe, expect, it } from 'bun:test';
import { MAX_ROUTING_PROMPT_CHARS, RoutingFileSchema } from '../../../../contract/index.ts';
import { packFiles } from '../../../../app/lib/pack/pack-files.ts';
import { kernelConfigText, parsedConfig } from '../../support/config-text.ts';


const { readPacksFile: readPackFile, withPackConfig, withRoutingPrompt } = packFiles(kernelConfigText);

describe('readPacksFile', () => {
  it('reads an empty file as nothing said, and refuses one that does not parse or check', () => {
    expect(readPackFile('')).toEqual({});
    expect(readPackFile('enabled: false\nlimits:\n  maxDepth: 1\n')).toEqual({
      enabled: false,
      limits: { maxDepth: 1 },
    });
    expect(readPackFile('enabled: [')).toBeNull();
    expect(readPackFile('- a list\n')).toBeNull();
    expect(readPackFile('enabled: maybe\n')).toBeNull();
  });
});

describe('withPackConfig', () => {
  it('writes only what differs from the default into an empty file, with the schema modeline', () => {
    const text = withPackConfig('', { enabled: true, decision: 'jev', limits: { autoChildren: 4, maxDepth: 3 } });
    expect(text).toContain('# yaml-language-server: $schema=');
    expect(text).toContain('decision: jev');
    expect(text).toContain('maxDepth: 3');
    expect(text).not.toContain('enabled');
    expect(text).not.toContain('autoChildren');
    expect(readPackFile(text ?? '')).toEqual({ decision: 'jev', limits: { maxDepth: 3 } });
  });

  it('writes a default where the file already names the key, and keeps the owner’s comments', () => {
    const before = '# mine\nenabled: false # off for now\nprobe:\n  cacheSeconds: 10\n';
    const text = withPackConfig(before, { enabled: true, probe: { cacheSeconds: 60, timeoutSeconds: 45 } }) ?? '';
    expect(text).toContain('# mine');
    expect(text).toContain('enabled: true');
    expect(text).toContain('cacheSeconds: 60');
    expect(text).not.toContain('timeoutSeconds');
  });

  it('drops a section left empty, sets Jev’s cap, and ignores an unchanged part of a patch', () => {
    expect(withPackConfig('jev: {}\n', { jev: { usdPerDay: 0.25 } }) ?? '').not.toContain('jev');
    expect(withPackConfig('', { jev: { usdPerDay: 1.5 }, limits: { maxDepth: undefined } }) ?? '').toContain(
      'usdPerDay: 1.5',
    );
  });

  it('refuses a file that does not check, and an edit that would not', () => {
    expect(withPackConfig('enabled: maybe\n', { enabled: true })).toBeNull();
    expect(withPackConfig('', { limits: { maxDepth: 99 } })).toBeNull();
  });

});

describe('withRoutingPrompt', () => {
  const read = (text: string | null) => {
    const file = (parsedConfig(text ?? '') ?? {}) as { routing?: unknown };
    return RoutingFileSchema.parse(file.routing ?? {});
  };
  const SUGGESTED = [
    '# my routing',
    'routing:',
    '  prompt: Opus for everything.',
    '  suggested:',
    '    by: gpt-6-astra',
    '    via: codex-main',
    '    at: 2026-10-22T14:30:00.000Z',
    '    acceptedAt: 2026-10-22T14:31:00.000Z',
    '',
  ].join('\n');

  it('writes the owner’s words trimmed, with the schema modeline, into an empty file', () => {
    const text = withRoutingPrompt('', '  Hard work → claude-opus-5-5 at max.  ');
    expect(text).toContain('# yaml-language-server: $schema=');
    expect(read(text)).toEqual({ prompt: 'Hard work → claude-opus-5-5 at max.' });
  });

  it('drops the record of a clean-up, because saved text is the owner’s again, and keeps a comment', () => {
    expect(read(SUGGESTED).suggested?.by).toBe('gpt-6-astra');
    const text = withRoutingPrompt(SUGGESTED, 'Opus for hard work, Haiku for chores.');
    expect(text).toContain('# my routing');
    expect(read(text)).toEqual({ prompt: 'Opus for hard work, Haiku for chores.' });
  });

  it('removes the prompt for null or blank words, so the default applies', () => {
    expect(read(withRoutingPrompt(SUGGESTED, null))).toEqual({});
    expect(read(withRoutingPrompt(SUGGESTED, '   '))).toEqual({});
    expect(withRoutingPrompt(SUGGESTED, null)).not.toContain('prompt:');
    expect(withRoutingPrompt(SUGGESTED, null)).not.toContain('routing');
  });

  it('refuses a file that does not parse, and a prompt over the limit', () => {
    expect(withRoutingPrompt('routing: [', 'Opus.')).toBeNull();
    expect(withRoutingPrompt('', 'x'.repeat(MAX_ROUTING_PROMPT_CHARS + 1))).toBeNull();
    expect(withRoutingPrompt('', 'x'.repeat(MAX_ROUTING_PROMPT_CHARS))).not.toBeNull();
  });
});
