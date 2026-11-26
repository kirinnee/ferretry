import type { ChildEnvironment } from '@ferretry/kernel/contract';
import { err, ok, type Result } from '@ferretry/std';
import {
  LaunchRefusal,
  type Harness,
  type LaunchPart,
  type LaunchPartSource,
  type LaunchSpec,
  type StartFailure,
} from '../../../contract/index.ts';
import type { issueToken } from '../tokens/tokens.ts';

/** A replacement's checked environment stays sealed until the runner spends it; no launch credential is rotated yet. */
export interface PreparedLaunch {
  readonly harness: Harness;
  readonly spec: LaunchSpec;
  readonly env: ChildEnvironment;
  readonly issued: ReturnType<typeof issueToken>;
}

export async function prepareLaunchHome(harness: Harness, spec: LaunchSpec): Promise<Result<void, StartFailure>> {
  try {
    await harness.prepareHome(spec);
    return ok(undefined);
  } catch (error) {
    return err({
      code: 'failed',
      reason:
        error instanceof LaunchRefusal
          ? error.message
          : `the ${spec.harness} harness could not prepare this ferret's home, so it was not started`,
    });
  }
}

/** Optional additions may fail; a required launch part's refusal stops the launch. */
export async function collectLaunchParts(
  sources: readonly LaunchPartSource[],
  base: Omit<LaunchSpec, 'parts'>,
): Promise<Result<readonly LaunchPart[], StartFailure>> {
  const answers = await Promise.all(
    sources.map(async source => {
      try {
        return { ok: true as const, parts: await source.parts(base) };
      } catch (error) {
        return { ok: false as const, required: source.required === true, error };
      }
    }),
  );
  const refused = answers.find(answer => !answer.ok && answer.required);
  if (refused !== undefined && !refused.ok)
    return err({
      code: 'failed',
      reason:
        refused.error instanceof LaunchRefusal
          ? refused.error.message
          : 'a part of this launch that must be checked could not be read, so the ferret was not started',
    });
  return ok(answers.flatMap(answer => (answer.ok ? answer.parts : [])));
}
