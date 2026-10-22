/**
 * Values written back into their files: only the keys that changed, with the owner's comments kept.
 *
 * Every program that changes the configuration — the app's reviewed fleet changes, a first-run import,
 * a clone, the Warden settings form — computes the value it wants and asks this module for the TEXT,
 * so a comment the owner wrote survives every save (`./yaml-text.ts`).
 *
 * Pure.
 */
import { type ConfigFileAddress, configFilePath, configSchemaId, configSchemaModeline } from '@ferretry/protocol';
import type { AccountModel } from '../account/schema.ts';
import { checkConfigFile } from './check.ts';
import { ABSENT_CONFIG_ETAG, type EffectiveConfig } from './evaluate.ts';
import { type ConfigValues, configFileBody, SINGLETON_DEFAULTS } from './kinds.ts';
import { accountModelFiles } from './model.ts';
import { editConfigText, sameConfigValue } from './yaml-text.ts';

/** A file as it is on disk now: its text and its etag. */
export interface ConfigFileOnDisk {
  readonly text: string;
  readonly etag: string;
}

/** One file to write, or to remove (`content: undefined`), with the etag it must still have. */
export interface ConfigFileEdit {
  readonly path: string;
  readonly content: string | undefined;
  readonly expect: string;
}

/** What an EMPTY file of this kind means, written out: a singleton's defaults, anything else nothing. */
function emptyBody(address: ConfigFileAddress): unknown {
  const schema = configSchemaId(address);
  return address.kind in SINGLETON_DEFAULTS
    ? configFileBody(schema, SINGLETON_DEFAULTS[address.kind as keyof typeof SINGLETON_DEFAULTS])
    : {};
}

/**
 * The text a file must have to mean `value`, edited from `existing`; `undefined` when the file
 * already means exactly that (or, absent, when an empty file would).
 */
export function renderConfigFile(
  path: string,
  address: ConfigFileAddress,
  value: ConfigValues[keyof ConfigValues],
  existing: string | undefined,
): string | undefined {
  const schema = configSchemaId(address);
  const target = configFileBody(schema, value) as Record<string, unknown>;
  const checked = existing === undefined ? undefined : checkConfigFile(path, existing);
  const current = checked?.ok === true ? configFileBody(schema, checked.value) : emptyBody(address);
  if ((existing !== undefined || address.kind in SINGLETON_DEFAULTS) && checked?.ok !== false) {
    if (sameConfigValue(current, target)) return undefined;
  }
  return editConfigText(existing, target, current, configSchemaModeline(address));
}

/**
 * The edits that move the fleet's files from the model in effect to `next`: every file whose meaning
 * changes, rewritten key by key, and every file `next` no longer has, removed. A file that is on disk
 * but was never in effect (it does not check) is left alone unless `next` writes it — a broken file
 * the owner is still fixing is never deleted from under them.
 *
 * `moved` names the files a rename gives a new path, new path → old path: the new file is edited from
 * the OLD file's text, so the owner's comments move with it, and the old one is removed as usual.
 */
export function fleetFileEdits(
  model: AccountModel,
  next: AccountModel,
  onDisk: ReadonlyMap<string, ConfigFileOnDisk>,
  moved: ReadonlyMap<string, string> = new Map(),
): readonly ConfigFileEdit[] {
  const before = accountModelFiles(model);
  const after = accountModelFiles(next);
  const edits: ConfigFileEdit[] = [];
  for (const [path, { address, value }] of after) {
    const disk = onDisk.get(path);
    const source = disk === undefined ? onDisk.get(moved.get(path) ?? '') : undefined;
    if (source !== undefined) {
      // A moved file is always written, even when it already means exactly this: it is new at its path.
      const content = renderConfigFile(path, address, value, source.text) ?? source.text;
      edits.push({ path, content, expect: ABSENT_CONFIG_ETAG });
      continue;
    }
    const content = renderConfigFile(path, address, value, disk?.text);
    if (content === undefined) continue;
    edits.push({ path, content, expect: disk?.etag ?? ABSENT_CONFIG_ETAG });
  }
  for (const path of before.keys()) {
    if (after.has(path)) continue;
    const disk = onDisk.get(path);
    if (disk === undefined) continue;
    edits.push({ path, content: undefined, expect: disk.etag });
  }
  return edits;
}

/** A runtime's old name and its new one. */
export interface RuntimeRename {
  readonly from: string;
  readonly to: string;
}

/**
 * The edits that re-point every NON-fleet file that names a runtime when it is renamed: each Warden
 * login in `warden.yaml` and the lesson miner's runtime in `learning.yaml`. Neither names more than
 * the runtime, so swapping the word loosens nothing; both carry the etag they were composed against.
 */
export function renamedRuntimeMentions(
  effective: Pick<EffectiveConfig, 'warden' | 'learning'>,
  onDisk: ReadonlyMap<string, ConfigFileOnDisk>,
  { from, to }: RuntimeRename,
): readonly ConfigFileEdit[] {
  const edits: ConfigFileEdit[] = [];
  const edit = (address: ConfigFileAddress, value: ConfigValues[keyof ConfigValues]): void => {
    const path = configFilePath(address);
    const disk = onDisk.get(path);
    const content = renderConfigFile(path, address, value, disk?.text);
    if (content !== undefined) edits.push({ path, content, expect: disk?.etag ?? ABSENT_CONFIG_ETAG });
  };
  const { warden, learning } = effective;
  if (warden.accounts.some(account => account.agent === from)) {
    edit(
      { kind: 'warden' },
      {
        ...warden,
        accounts: warden.accounts.map(account => (account.agent === from ? { ...account, agent: to } : account)),
      },
    );
  }
  if (learning.agent === from) edit({ kind: 'learning' }, { ...learning, agent: to });
  return edits;
}
