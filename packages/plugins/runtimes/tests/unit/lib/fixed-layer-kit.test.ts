/**
 * The Claude half of the fixed layer is its plugin's (E-276 PR 2): what Runtimes does with the kit's answer, and with no answer at
 * all (the plugin is off, or its kit has no fixed layer).
 */
import { describe, expect, it } from 'bun:test';
import type { KitFixedLayerInput, RuntimesHarnessKit } from '../../../contract/index.ts';
import { fixedLayerFor, fixedLayerOf } from '../../../daemon/lib/account/fixed-layer.ts';
import { REAL_KITS } from '../../support/real-kits.ts';

const CLAUDE = {
  harness: 'claude',
  agentPermissions: 'auto',
  cwd: '/w',
  fyCommand: '/opt/fy/bin/fy',
  acceptsAutoPermissionMode: true,
} as const;
const REQUEST = {
  agentPermissions: 'skip',
  cwd: '/w',
  fyCommand: '/opt/fy/bin/fy',
  acceptsAutoPermissionMode: false,
} as const;
const OFF = {
  ok: false,
  refusal: { kind: 'harness-unsupported', message: 'claude-code is not supported here' },
} as const;

describe('a Claude fixed layer through its kit', () => {
  it('should refuse a Claude runtime whose plugin gives no fixed layer, by name, and not answer as Codex', () => {
    expect(fixedLayerFor(CLAUDE, undefined)).toEqual(OFF);
    expect(fixedLayerFor(CLAUDE, new Map())).toEqual(OFF);
    expect(fixedLayerOf('claude', REQUEST, {})).toEqual(OFF);
    expect(fixedLayerOf('claude', REQUEST)).toEqual(OFF);
  });

  it('should not let the Codex kit answer for Claude', () => {
    const codexOnly = new Map([['codex', REAL_KITS.get('codex') as RuntimesHarnessKit]] as const);
    expect(fixedLayerFor(CLAUDE, codexOnly)).toEqual(OFF);
  });

  it('should hand the kit the launch facts and the words every agent is told, and key each entry from its path', () => {
    const asked: KitFixedLayerInput[] = [];
    const kit: RuntimesHarnessKit = {
      fixedLayer: input => {
        asked.push(input);
        return {
          ok: true,
          layer: {
            entries: [
              { purpose: 'trust', target: 'claude-json', path: ['projects', '/w x', 'ok'], value: true },
              { purpose: 'no-questions', target: 'launch', path: ['--flag'], value: true },
            ],
            args: ['--a'],
          },
        };
      },
    };
    const found = fixedLayerOf('claude-code', REQUEST, kit);
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({ ...REQUEST, instruction: expect.stringContaining('Ferretry tools:') });
    expect(found).toEqual({
      ok: true,
      layer: {
        harness: 'claude',
        agentPermissions: 'skip',
        entries: [
          {
            purpose: 'trust',
            target: 'claude-json',
            path: ['projects', '/w x', 'ok'],
            key: 'projects."/w x".ok',
            value: true,
          },
          { purpose: 'no-questions', target: 'launch', path: ['--flag'], key: '--flag', value: true },
        ],
        args: ['--a'],
      },
    });
  });

  it('should pass the plugin’s refusal through unchanged', () => {
    const refusal = { kind: 'claude-auto-mode-unsupported', message: 'its words' };
    expect(fixedLayerOf('claude', REQUEST, { fixedLayer: () => ({ ok: false, refusal }) })).toEqual({
      ok: false,
      refusal,
    });
  });
});
