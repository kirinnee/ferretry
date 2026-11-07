import { expect, test } from 'bun:test';
import { LimitsFileSchema, NO_AGENT_CONTROL, type FerretRecord, type LimitsFile } from '../../../../contract/index.ts';
import { ferretId, T0 } from '../../../../contract/testing/index.ts';
import { FerretsService, type FerretsPorts } from '../../../../daemon/lib/ferrets/service.ts';
import { FerretRegistry } from '../../../../daemon/lib/registry/registry.ts';
import { FerretTokenDirectory } from '../../../../daemon/lib/tokens/tokens.ts';

/** Replaces the removed account-model policy tests with the active limits.yaml service path. */
test('agent control reads each limits.yaml field fresh and keeps settings and page scripts opt-in', async () => {
  const id = ferretId('fern');
  const record: FerretRecord = {
    format: 1,
    id,
    name: 'fern',
    role: 'lead',
    harness: 'claude-code',
    runner: 'tmux',
    folder: '/work',
    state: 'working',
    createdAt: T0,
    stateAt: T0,
  };
  let limits: LimitsFile | undefined;
  const service = new FerretsService(new FerretRegistry([record]), new FerretTokenDirectory(), {
    limits: () => limits,
  } as FerretsPorts);
  expect(await service.agentControl(id)).toEqual({
    terminals: true,
    browsers: true,
    files: true,
    ferretrySettings: false,
    pageScripts: false,
  });
  limits = LimitsFileSchema.parse({
    agentControl: { terminals: false, browsers: false, files: false, ferretrySettings: true, pageScripts: true },
  });
  expect(await service.agentControl(id)).toEqual({
    terminals: false,
    browsers: false,
    files: false,
    ferretrySettings: true,
    pageScripts: true,
  });
  limits = LimitsFileSchema.parse({ agentControl: { browsers: false } });
  expect(await service.agentControl(id)).toEqual({
    terminals: true,
    browsers: false,
    files: true,
    ferretrySettings: false,
    pageScripts: false,
  });
  expect(await service.agentControl(ferretId('unknown'))).toEqual(NO_AGENT_CONTROL);
});
