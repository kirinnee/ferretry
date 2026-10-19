import { describe, expect, it } from 'bun:test';
import type { GuideUseCase } from '@ferretry/protocol';
import {
  guideIssues,
  readPackFile,
  useCaseForFile,
  withModelsGuide,
  withPackConfig,
} from '../../../src/lib/pack/pack-files.ts';
import { PACK_VIEW } from '../../support/pack.ts';

const GUIDE = PACK_VIEW.guide.useCases;

describe('readPackFile', () => {
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

describe('the models guide file', () => {
  it('writes every use case, trimmed, leaving out empty optional fields', () => {
    const messy: GuideUseCase = {
      id: ' bulk ',
      title: ' Bulk ',
      description: ' Renames. ',
      keywords: [' rename ', ' '],
      candidates: [{ provider: ' anthropic ', model: ' claude-haiku-4-5 ', effort: ' ', why: ' Cheap. ' }],
    };
    expect(useCaseForFile(messy)).toEqual({
      id: 'bulk',
      title: 'Bulk',
      description: 'Renames.',
      keywords: ['rename'],
      candidates: [{ provider: 'anthropic', model: 'claude-haiku-4-5', why: 'Cheap.' }],
    });
    expect(useCaseForFile({ ...messy, keywords: undefined, candidates: [] })).not.toHaveProperty('keywords');
    expect(
      useCaseForFile({
        ...messy,
        candidates: [{ provider: 'openai', model: 'm', harness: 'codex', effort: 'high', why: 'w' }],
      }).candidates,
    ).toEqual([{ provider: 'openai', model: 'm', harness: 'codex', effort: 'high', why: 'w' }]);
    const text = withModelsGuide('# my guide\n', GUIDE) ?? '';
    expect(text).toContain('# my guide');
    expect(text).toContain('id: hard');
    expect(text).toContain('model: gpt-6-astra');
  });

  it('removes the use cases for the built-in guide', () => {
    const text = withModelsGuide(withModelsGuide('', GUIDE) ?? '', null) ?? '';
    expect(text).not.toContain('useCases');
  });

  it('refuses a file that does not parse, and a guide that would not check', () => {
    expect(withModelsGuide('useCases: [', GUIDE)).toBeNull();
    expect(withModelsGuide('', [{ ...GUIDE[0], id: 'Not An Id' } as GuideUseCase])).toBeNull();
  });

  it('says what is wrong in the editor’s words', () => {
    expect(guideIssues(GUIDE)).toEqual([]);
    const broken = [
      { ...(GUIDE[0] as GuideUseCase), title: ' ', candidates: [{ provider: 'a', model: 'b', why: '' }] },
      GUIDE[0] as GuideUseCase,
    ];
    const issues = guideIssues(broken);
    expect(issues.some(issue => issue.startsWith('Use case 1 › title:'))).toBe(true);
    expect(issues.some(issue => issue.startsWith('Use case 1 › candidate 1 › why:'))).toBe(true);
    expect(issues.some(issue => issue.startsWith('Use case 2 › id:') && issue.includes('appears twice'))).toBe(true);
    expect(
      guideIssues(Array.from({ length: 25 }, (_, index) => ({ ...(GUIDE[1] as GuideUseCase), id: `u${index}` }))),
    ).toEqual([expect.stringContaining('24')]);
  });
});
