/**
 * The Model sets tab (docs/design/account-model.md §4.2, K1–K7, E20–E22): the model sets on this machine, one set's
 * page, and its Edit and New forms. The pages themselves are `ComponentKindPages`, shared with the Profiles tab's
 * "Built from" section; a model set belongs to Runtimes, so it keeps a tab of its own.
 */

import type { MachineTabProps } from '../shell/machine-tab.ts';
import { ComponentKindPages } from './component-kind-pages.tsx';

export function ModelSetsTab(props: MachineTabProps & { readonly machineNames?: ReadonlyMap<string, string> }) {
  return <ComponentKindPages {...props} kind="modelSets" />;
}
