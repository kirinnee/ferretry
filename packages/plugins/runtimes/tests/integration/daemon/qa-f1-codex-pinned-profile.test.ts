/**
 * QA F1 (O9 walk, f4a20555): `fy runtime add qacodex4 --login codex-login --profile ferretry-codex` is refused with
 * `profiles was refused (bad_name):` and an empty reason. A runtime saved on a GENERATED profile is written onto a real
 * profile and model set named `pinnedProfileName(harness, model)`; a Codex model id carries a dot (`gpt-6.1-sol`), the
 * item-name rule (`ITEM_NAME_PATTERN`) allows only letters, digits and dashes, so the kernel's writeAll refuses the set.
 * Over the kernel's REAL configuration service on a temp home; nothing reads a real home.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Log } from '@ferretry/kernel/contract';
import { sampleLogin } from '@ferretry/plugin-logins/contract/testing';
import { createConfigFiles } from '../../../../../core/kernel/host/config/service.ts';
import { createNodeHostFs } from '../../../../../core/kernel/host/state/host-fs.ts';
import {
  INSTRUCTION_ITEMS,
  ITEM_NAME_PATTERN,
  MODEL_SET_ITEMS,
  PROFILE_ITEMS,
  RUNTIME_ITEMS,
  RUNTIMES_CONFIG,
  type RuntimeFile,
} from '../../../contract/index.ts';
import { writeAllConfigWriter } from '../../../daemon/adapters/config-write-all.ts';
import { pinnedProfileName } from '../../../daemon/lib/account/builtin-autonomous.ts';
import { realisedEdits } from '../../../daemon/lib/account/runtimes-edits.ts';
import {
  assembleRuntimesModel,
  NO_COMPONENTS,
  type RuntimesFiles,
} from '../../../daemon/lib/account/runtimes-model.ts';

const homes: string[] = [];
afterEach(async () => {
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});

const silentLog: Log = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => silentLog,
};

/** A real Codex model id: OpenAI's ids carry dots, Anthropic's never do (which is why Claude's add works). */
const CODEX_MODEL = 'gpt-6.1-sol';

const files = (runtimes: ReadonlyMap<string, RuntimeFile>): RuntimesFiles => ({
  runtimes,
  profiles: new Map(),
  modelSets: new Map(),
  settings: undefined,
  logins: [sampleLogin('codex-login', { harness: 'codex', harnesses: ['codex'], store: 'host' })],
  templates: new Map(),
  components: NO_COMPONENTS,
  starters: { codex: CODEX_MODEL },
});

async function world() {
  const home = await mkdtemp(join(tmpdir(), 'fy-qa-f1-'));
  homes.push(home);
  const config = createConfigFiles({
    home,
    fs: createNodeHostFs(),
    clock: { nowMs: () => 1_000_000, after: () => () => undefined, every: () => () => undefined } as never,
    log: silentLog,
    binary: 'fy',
    defs: [RUNTIMES_CONFIG, RUNTIME_ITEMS, PROFILE_ITEMS, MODEL_SET_ITEMS, INSTRUCTION_ITEMS].map(def => ({
      plugin: 'runtimes',
      def: def as never,
    })),
  });
  await config.reload();
  return { port: config.port('runtimes'), configDirectory: join(home, 'config') };
}

describe('QA F1: a runtime on the built-in Codex profile', () => {
  it('names its pinned profile by a valid item name, whatever the model id', () => {
    expect(pinnedProfileName('codex', CODEX_MODEL)).toMatch(ITEM_NAME_PATTERN);
  });

  it('is saved: its pinned profile and model set land as files', async () => {
    const before = assembleRuntimesModel(files(new Map()));
    const next = assembleRuntimesModel(
      files(new Map([['qacodex4', { login: 'codex-login', profile: 'ferretry-codex' } as RuntimeFile]])),
    );
    expect(next.model.runtimes.qacodex4).toBeDefined();

    const { edits, refused } = realisedEdits(before.model, next.model, next.derived);
    expect(refused).toEqual([]);
    const { port, configDirectory } = await world();
    const writer = writeAllConfigWriter(port, configDirectory);

    await writer.write(
      // Only what this change writes: the new runtime and its pinned profile and model set (the derived runtime of the
      // login is no file and is not this change's).
      edits
        .filter(edit => edit.path !== 'runtimes/codex-login.yaml')
        .map(edit => ({
          path: join(configDirectory, edit.path),
          content: '',
          mode: 0o600,
          ...(edit.patch === undefined ? {} : { patch: edit.patch }),
        })),
    );

    expect([...port.collection(RUNTIME_ITEMS as never).keys()]).toEqual(['qacodex4']);
    expect([...port.collection(PROFILE_ITEMS as never).keys()]).toHaveLength(1);
  });

  it('says WHY a name is refused, never an empty reason', async () => {
    const { port, configDirectory } = await world();
    const writer = writeAllConfigWriter(port, configDirectory);

    const refusal = await writer
      .write([{ path: join(configDirectory, 'profiles/has.dot.yaml'), content: 'contents: []\n', mode: 0o600 }])
      .then(
        () => undefined,
        (error: unknown) => error as Error,
      );

    expect(refusal?.message).not.toMatch(/\(bad_name\):\s*$/u);
    expect(refusal?.message).toContain('has.dot');
  });
});
