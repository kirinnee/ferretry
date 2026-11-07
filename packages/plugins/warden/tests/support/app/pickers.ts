/** One login as the account picker offers it: the shell's `PickerAccount`, filled with what the Warden form reads. */

import type { PickerAccount } from '../../../app/lib/account-picker.ts';

export const pickerAccount = (overrides: Partial<PickerAccount> & { wrapper: string }): PickerAccount => ({
  id: `rt-${overrides.wrapper}`,
  displayName: overrides.wrapper,
  kind: overrides.wrapper.startsWith('codex') ? 'codex' : 'claude',
  agent: true,
  credentialId: `login-${overrides.wrapper}`,
  defaultModel: null,
  models: [],
  available: true,
  unavailableReason: null,
  ...overrides,
});
