import { describe, expect, test } from 'bun:test';
import { CAPABILITY_NAMES as APP_CAPABILITY_NAMES } from '@ferretry/app';
import { CHANGE_REFUSALS } from '@ferretry/app/ui';
import { CAPABILITY_NAMES, GRANT_REFUSALS } from '../../contract/policy.ts';

/**
 * THE APP SHELL'S MIRRORS OF GATE'S VOCABULARY (shell contract S1, R3 n2). `@ferretry/app` does not depend on Gate, so
 * it mirrors two lists: the capability names its `authority(capability, axis)` takes, and the refusal reasons its
 * grants reader parses. Each must be Gate's list exactly, in order — a capability Gate adds that the app does not know
 * would read as `undetermined`, and a refusal the app does not know would make every grants answer unreadable.
 */
describe("the app shell's mirrors of Gate's policy vocabulary", () => {
  test('CAPABILITY_NAMES is Gate’s list, in order', () => {
    expect([...APP_CAPABILITY_NAMES]).toEqual([...CAPABILITY_NAMES]);
  });

  test('CHANGE_REFUSALS is Gate’s GRANT_REFUSALS, in order', () => {
    expect([...CHANGE_REFUSALS]).toEqual([...GRANT_REFUSALS]);
  });
});
