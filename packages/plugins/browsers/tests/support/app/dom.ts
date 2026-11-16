import { createElement } from 'react';
import { mount } from '@ferretry/app/testing';

/** Registers the shared DOM for suites that read `document` while rendering with react-test-renderer. */
export const withDocument = async (): Promise<void> => {
  const mounted = await mount(createElement('div'));
  await mounted.unmount();
};
