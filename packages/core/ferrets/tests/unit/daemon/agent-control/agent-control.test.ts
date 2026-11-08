import { describe, expect, test } from 'bun:test';
import { AGENT_CONTROL_KINDS, AgentControlPort, type AgentControlKind } from '@ferretry/kernel/contract';
import {
  type AgentControl,
  DEFAULT_AGENT_CONTROL,
  NO_AGENT_CONTROL,
  type FerretId,
} from '../../../../contract/index.ts';
import { instructionsAnswer } from '../../../../daemon/lib/agent-control/instructions.ts';
import { agentControlReader, SWITCH_OF_KIND } from '../../../../daemon/lib/agent-control/reader.ts';
import manifest from '../../../../manifest.ts';

const wren = 'wren' as FerretId;

/** A switch document with exactly `on` on. Fake: no `limits.yaml`. */
const only = (...on: readonly (keyof AgentControl)[]): AgentControl => ({
  terminals: on.includes('terminals'),
  browsers: on.includes('browsers'),
  files: on.includes('files'),
  ferretrySettings: on.includes('ferretrySettings'),
  pageScripts: on.includes('pageScripts'),
});

describe('AgentControlPort: ONE reader of "What agents may control", for every kind', () => {
  test('R-0244 Ferrets provides the kernel-bound agent-control port', () => {
    expect(AgentControlPort.name).toBe('agent-control');
    expect(manifest.provides).toMatchObject({ agentControl: AgentControlPort });
  });

  test('R-0244 the kinds are today’s five, as a closed list, each answered by its own switch', () => {
    expect([...AGENT_CONTROL_KINDS]).toEqual(['terminal', 'browser', 'files', 'settings', 'scripts']);
    expect(SWITCH_OF_KIND).toEqual({
      terminal: 'terminals',
      browser: 'browsers',
      files: 'files',
      settings: 'ferretrySettings',
      scripts: 'pageScripts',
    });
  });

  for (const kind of AGENT_CONTROL_KINDS) {
    test(`R-0244 kind ${kind}: on → allowed, off → refused, and no other switch answers for it`, async () => {
      const own = SWITCH_OF_KIND[kind];
      const on = agentControlReader(async () => only(own));
      const off = agentControlReader(async () =>
        only(...(Object.values(SWITCH_OF_KIND).filter(switchName => switchName !== own) as (keyof AgentControl)[])),
      );
      expect(await on.allows(wren, kind)).toBe(true);
      expect(await off.allows(wren, kind)).toBe(false);
    });
  }

  test('R-0244 read fresh every call: a change applies to the very next act', async () => {
    let current = only();
    const reader = agentControlReader(async () => current);
    expect(await reader.allows(wren, 'settings')).toBe(false);
    current = only('ferretrySettings');
    expect(await reader.allows(wren, 'settings')).toBe(true);
  });

  test('R-0244 today’s defaults: terminals, browsers and files on; Ferretry settings and page scripts off; an unknown ferret controls nothing', async () => {
    const defaults = agentControlReader(async () => DEFAULT_AGENT_CONTROL);
    const answers: Record<AgentControlKind, boolean> = {
      terminal: true,
      browser: true,
      files: true,
      settings: false,
      scripts: false,
    };
    for (const kind of AGENT_CONTROL_KINDS) expect(await defaults.allows(wren, kind)).toBe(answers[kind]);
    const unknown = agentControlReader(async () => NO_AGENT_CONTROL);
    for (const kind of AGENT_CONTROL_KINDS) expect(await unknown.allows(wren, kind)).toBe(false);
  });
});

describe('instructions', () => {
  test('T-0036 the tool is declared with today’s name and words, for any authenticated caller', () => {
    const declared = manifest.actions?.agentTools?.find(tool => tool.name === 'instructions');
    expect(declared?.summary).toBe(
      'Which Ferretry sections your prompt launched with (hypermedia, Pack mode, agenda mode, lessons) and how to turn each on. Check before saying one is missing.',
    );
    expect(declared).toMatchObject({ minimum: 'authenticated', caller: 'any' });
    expect(declared?.input?.safeParse({}).success).toBe(true);
    expect(declared?.input?.safeParse({ ferret: 'other' }).success).toBe(false);
  });

  test('T-0036 returns today’s text for the ferret the credential names', () => {
    const text = instructionsAnswer(
      wren,
      () => ({ FY_SESSION_MODE: 'auto', FY_HYPERMEDIA: '1', FY_PACK: '0', FY_AGENDA: '0', FY_LEARNING_PASSIVE: '1' }),
      'fy',
    ).text;
    expect(text).toBe(
      [
        'Sections ferret wren launched with (auto):',
        '  ✓ Hypermedia: on',
        '  ✗ Pack mode: off. The owner turns it on in Ferretry: open this ferret › Actions › Pack mode. It takes effect when this ferret next restarts (Actions › Restart). Settings › Pack mode, the machine’s switch, must be on too.',
        '  ✗ Agenda mode: off. The owner turns it on in Ferretry: open this ferret › Actions › Agenda mode. It takes effect when this ferret next restarts (Actions › Restart).',
        '  ✓ Lessons: on',
        'These are fixed for this run: a switch changed now is in the system prompt from the next launch.',
      ].join('\n'),
    );
  });

  test('T-0036 a ferret this daemon did not launch, and a caller that is no ferret, get today’s own sentences', () => {
    expect(instructionsAnswer(wren, () => undefined, 'fy').text).toBe(
      "This process was not handed ferret wren's section switches (a Codex tools server is not). Run `fy instructions` in your own shell instead.",
    );
    expect(instructionsAnswer(undefined, () => undefined, 'fy').text).toStartWith(
      'This is not running inside a ferret',
    );
  });
});
