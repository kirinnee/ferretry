import type { VerbInvocation } from '@ferretry/kernel/manifest';
import type { AccountCommandDeps } from './fleet/account-ports.ts';
import { runRecommend } from './fleet/recommend.ts';
import { modelSetAdd, modelSetEdit, modelSetLs, modelSetRm, modelSetShow } from './model-set/commands.ts';
import { profileBuild, profileEdit, profileLs, profileRm, profileShow } from './profile/commands.ts';
import {
  runtimeAdd,
  runtimeDisable,
  runtimeEnable,
  runtimeLs,
  runtimeRename,
  runtimeRm,
  runtimeSet,
  runtimeShow,
} from './runtime/commands.ts';
import { runtimeImport, runtimeScan } from './setup/commands.ts';

/** One verb: it prints through `deps.out`, sets the exit code there and refuses by throwing an `AccountCommandError`. */
export type VerbBody = (deps: AccountCommandDeps, invocation: VerbInvocation) => Promise<void>;

/** Every verb the manifest declares, by its exact verb line. A verb the manifest adds is a type error here. */
export const VERB_BODIES = {
  'runtime ls': runtimeLs,
  'runtime add': runtimeAdd,
  'runtime show': runtimeShow,
  'runtime set': runtimeSet,
  'runtime disable': runtimeDisable,
  'runtime enable': runtimeEnable,
  'runtime rename': runtimeRename,
  'runtime rm': runtimeRm,
  'runtime import': runtimeImport,
  'runtime scan': runtimeScan,
  recommend: runRecommend,
  'profile ls': profileLs,
  'profile show': profileShow,
  'profile build': profileBuild,
  'profile edit': profileEdit,
  'profile rm': profileRm,
  'model-set ls': modelSetLs,
  'model-set show': modelSetShow,
  'model-set add': modelSetAdd,
  'model-set edit': modelSetEdit,
  'model-set rm': modelSetRm,
} as const satisfies Record<string, VerbBody>;
