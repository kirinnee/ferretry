import { describe, expect, test } from 'bun:test';
import { ferretId } from '../../../contract/testing/index.ts';
import { instructionsAnswer } from '../../../daemon/lib/agent-control/instructions.ts';
import manifest from '../../../manifest.ts';

describe('the agent tools Ferrets owns', () => {
  test('T-0036 instructions is declared with v4’s name and words, takes no arguments, and is open to any authenticated caller', () => {
    expect(manifest.actions.agentTools?.map(tool => tool.name)).toEqual(['instructions']);
    const declared = manifest.actions.agentTools?.find(tool => tool.name === 'instructions');
    expect(declared?.summary).toBe(
      'Which Ferretry sections your prompt launched with (hypermedia, Pack mode, agenda mode, lessons) and how to turn each on. Check before saying one is missing.',
    );
    expect(declared).toMatchObject({ minimum: 'authenticated', caller: 'any' });
    expect(declared?.input?.safeParse({}).success).toBe(true);
    expect(declared?.input?.safeParse({ ferret: 'other' }).success).toBe(false);
  });

  test('T-0036 instructions answers, for the calling ferret, which sections it launched with and how to turn each on', async () => {
    const wren = ferretId('wren');
    const text = (
      await instructionsAnswer(
        wren,
        async () => ({
          FY_SESSION_MODE: 'auto',
          FY_HYPERMEDIA: '1',
          FY_PACK: '0',
          FY_AGENDA: '0',
          FY_LEARNING_PASSIVE: '1',
        }),
        'fy',
      )
    ).text;
    expect(text).toContain('Sections ferret wren launched with (auto):');
    expect(text).toContain('✓ Hypermedia: on');
    expect(text).toContain('✗ Pack mode: off. The owner turns it on in Ferretry');
    expect(text).toContain('✗ Agenda mode: off');
    expect(text).toContain('✓ Lessons: on');
    expect((await instructionsAnswer(undefined, async () => ({}), 'fy')).text).toStartWith(
      'This is not running inside a ferret',
    );
  });
});
