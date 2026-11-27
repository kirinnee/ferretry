/**
 * E-276 0a: the launch argv — `renderRuntimeWrapperScript` and `renderCommandScript` as text — and the fixed layer every agent launch
 * gets last (`fixedLayerFor`), for each harness. The plan goldens carry the same wrappers inside a whole plan; these pin each
 * wrapper SHAPE on its own (default model, resume patterns, sign-in link, secrets file, an auto launch refused, a runtime refused
 * outright) so a move of one harness's launch lines names the line that changed.
 */
import { describe, it } from 'bun:test';
import { fixedLayerFor } from '../../../daemon/lib/account/fixed-layer.ts';
import {
  renderCommandScript,
  renderRuntimeWrapperScript,
  type RuntimeWrapperInput,
} from '../../../daemon/lib/wrappers.ts';
import { expectGolden } from './support/golden.ts';
import { outcome, THIRD_KEY } from './support/thrown.ts';
import { FY_COMMAND, RUNTIME_ID } from './support/world.ts';

const HARNESSES = ['claude', 'codex'] as const;
const CWD = '/golden/launch-folder';

const base = (harness: 'claude' | 'codex'): RuntimeWrapperInput => ({
  name: `${harness}-golden`,
  id: RUNTIME_ID,
  harness,
  configDirectory: `/fy/fleet/homes/${RUNTIME_ID}`,
  env: {
    FY_CREDENTIAL: `${harness}-host`,
    FY_RUNTIME: `${harness}-golden`,
    FY_HOME: '/fy',
    FIXED_LITERAL: 'a b',
    REFERENCED: '${secret:GOLDEN_KEY}',
  },
  args: ['--profile-flag', 'value with space'],
  fyCommand: FY_COMMAND,
  harnessCommand: `/opt/harness/bin/${harness}`,
});

describe('wrapper goldens', () => {
  for (const harness of HARNESSES) {
    const shapes: Readonly<Record<string, RuntimeWrapperInput>> = {
      interactive: base(harness),
      'default-model': { ...base(harness), defaultModel: 'golden-model' },
      'bare-command': { ...base(harness), harnessCommand: undefined },
      'secrets-file': { ...base(harness), secretsFile: '/home/person/.golden-secrets.env' },
      'sign-in-link': {
        ...base(harness),
        signInLink: {
          path: `/fy/fleet/homes/${RUNTIME_ID}/auth.json`,
          target: '/fy/state/logins/credentials/golden/auth.json',
        },
      },
      'autonomous-first-run': {
        ...base(harness),
        defaultModel: 'golden-model',
        autonomous: {
          args: ['--fixed', 'layer'],
          seedFirstRun: harness === 'claude',
          trustLaunchFolder: harness === 'codex',
        },
      },
      'autonomous-no-seed': {
        ...base(harness),
        autonomous: { args: ['--fixed'], seedFirstRun: false, trustLaunchFolder: false },
      },
      'autonomous-refused': {
        ...base(harness),
        autonomous: { refusal: 'this agent runtime cannot launch: golden reason' },
      },
      refused: { ...base(harness), refusal: 'it cannot launch at all: golden reason' },
    };
    for (const [shape, input] of Object.entries(shapes)) {
      it(`should render the ${harness} wrapper (${shape}) exactly as the base does`, () => {
        expectGolden(`wrapper/${harness}-${shape}`, renderRuntimeWrapperScript(input));
        expectGolden(`wrapper/${harness}-${shape}`, renderRuntimeWrapperScript({ ...input }));
      });
    }

    for (const [permissions, accepts] of [
      ['auto', true],
      ['auto', false],
      ['skip', true],
    ] as const) {
      it(`should compute the ${harness} fixed layer for ${permissions} (Claude accepts auto: ${accepts}) exactly as the base does`, () => {
        const name = `fixed-layer/${harness}-${permissions}-${accepts ? 'accepted' : 'refused'}`;
        const input =
          harness === 'claude'
            ? ({
                harness,
                agentPermissions: permissions,
                cwd: CWD,
                acceptsAutoPermissionMode: accepts,
                fyCommand: FY_COMMAND,
              } as const)
            : ({ harness, agentPermissions: permissions, cwd: CWD, fyCommand: FY_COMMAND } as const);
        expectGolden(name, fixedLayerFor(input));
      });
    }
  }

  it('should render a command wrapper exactly as the base does', () => {
    expectGolden(
      'wrapper/command',
      renderCommandScript({
        command: { wrapper: 'quick', target: 'claude-golden', flags: ['--model', 'golden model'], alias: undefined },
        targetWrapper: 'claude-golden',
        binDir: '/fy/fleet/bin',
      }),
    );
  });

  it('should refuse a third harness for the fixed layer by name, never answering with Claude or Codex', () => {
    expectGolden('wrapper/third-key', {
      fixedLayer: outcome(() =>
        fixedLayerFor({ harness: THIRD_KEY, agentPermissions: 'skip', cwd: CWD, fyCommand: FY_COMMAND } as never),
      ),
    });
  });
});
