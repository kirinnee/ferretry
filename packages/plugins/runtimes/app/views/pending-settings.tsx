/**
 * The three Settings tabs this plugin declares (`runtimes`, `profiles`, `model-sets`) until their screens are ported.
 *
 * The screens themselves (today's Runtimes, Profiles and Components tabs) were never assigned to a plugin's app half,
 * so they are not here; see NEEDS-APP-SHELL.txt. This says so on screen instead of drawing an empty tab.
 */

import type { AppComponent, SettingsProps } from '@ferretry/kernel/manifest';

export const pendingSettings =
  (title: string): AppComponent<SettingsProps> =>
  () => (
    <section aria-label={title} data-runtimes-tab-pending={title}>
      <h2>{title}</h2>
      <p>This screen is not built yet in this version of Ferretry.</p>
    </section>
  );
