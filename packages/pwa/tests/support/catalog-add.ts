import { byText, click, settle } from './dom-form.ts';

/** More › Install from a file…, the way a person reaches it. */
export const chooseInstallFromFile = async (root: ParentNode = document): Promise<void> => {
  await click(root.querySelector('[data-catalog-more]'));
  await settle();
  await click(byText(document, '[role="menuitem"]', 'Install from a file'));
  await settle();
};
