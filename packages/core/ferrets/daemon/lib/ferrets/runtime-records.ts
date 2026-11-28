import {
  type FerretRuntimeRecord,
  type FerretRuntimeRename,
  recordedHarnessOf,
  type RuntimeStartResolution,
  type StartRequest,
} from '../../../contract/index.ts';
import { ok, type Result } from '@ferretry/std';
import type { FerretsCore } from './core.ts';

/** Every ferret and the runtime it launched as (`FerretsApi.runtimeRecords`): the record, with the session config's words. */
export async function runtimeRecords({ registry, ports }: FerretsCore): Promise<readonly FerretRuntimeRecord[]> {
  await ports.ready?.();
  const read = ports.session?.runtimeFacts?.bind(ports.session);
  const rows = await Promise.all(
    registry.list().map(async (ferret): Promise<FerretRuntimeRecord | undefined> => {
      const facts = await read?.(ferret.id).catch(() => undefined);
      const agent = facts?.agent ?? ferret.runtime;
      if (agent === undefined) return undefined;
      return {
        id: ferret.id,
        name: ferret.name,
        harness: recordedHarnessOf(ferret.harness),
        agent,
        ...(facts?.executable === undefined ? {} : { executable: facts.executable }),
        state: ferret.state,
      };
    }),
  );
  return rows.filter(row => row !== undefined);
}

/**
 * Re-points every ferret on a renamed runtime (`FerretsApi.repointRuntime`). Each ferret is rewritten on its own mutation
 * lane, so a start, stop or resume of it is never interleaved: the record's `runtime` through the ordinary durable write,
 * the session config's `agent` and `command[0]` through the session storage's locked read-modify-write. A ferret that
 * does not name the old runtime is not written at all, and one that cannot be rewritten is skipped, never reported moved.
 */
export async function repointRuntime(
  { registry, ports, serial, write }: FerretsCore,
  rename: FerretRuntimeRename,
): Promise<number> {
  await ports.ready?.();
  let moved = 0;
  for (const { id } of registry.list()) {
    try {
      const done = await serial.run(id, async () => {
        ports.mutationAllowed?.(id);
        const configMoved = (await ports.session?.repointRuntime?.(id, rename)) ?? false;
        const record = registry.get(id);
        if (record?.runtime !== rename.from) return configMoved;
        await write({ ...record, runtime: rename.to }, record.state, 'moved');
        return true;
      });
      if (done) moved += 1;
    } catch {
      // One ferret that cannot be rewritten still resolves through the runtime's former names; the rest still move.
    }
  }
  return moved;
}

/** The refusal's sentence when a derived runtime's name moved off the login a ferret started on: it picks a runtime. */
const loginGoneSentence = (login: string): string =>
  `the login ${login} this ferret used was removed or renamed; pick a runtime to continue`;

/**
 * The harness and login a relaunch spends, from what Runtimes resolved. A DERIVED runtime (made from a ready login, no
 * file holds the name) is only that login's: if its name now answers on ANOTHER login than the one the ferret started on
 * (that login was removed or renamed), a relaunch would silently spend a different account, so it is refused. An explicit
 * runtime file keeps its own say: re-pointing it is the owner's act, and a ferret on it follows the file as it always did.
 */
export function accountOf<Failure>(
  answer: Extract<RuntimeStartResolution, { ok: true }>,
  stored: string | undefined,
  refuse: (reason: string) => Result<never, Failure>,
): Result<Pick<Extract<RuntimeStartResolution, { ok: true }>, 'harness' | 'login' | 'model'>, Failure> {
  if (answer.derived === true && stored !== undefined && stored !== answer.login)
    return refuse(loginGoneSentence(stored));
  return ok({
    harness: answer.harness,
    login: answer.login,
    ...(answer.model === undefined ? {} : { model: answer.model }),
  });
}

/** Persist the runtime's selected model with the start, so every subsequent launch uses the same choice. */
export function withRuntimeModel(request: StartRequest, model: string | undefined): StartRequest {
  return model === undefined || request.options?.model !== undefined
    ? request
    : { ...request, options: { ...request.options, model } };
}
