import { createContext } from 'react';

/**
 * The title of the Settings tab being drawn (the shell's one h2 for the panel), or `undefined` outside a Settings panel.
 * A tab draws no heading of its own for it; a `SettingGroup` whose label IS that title says so by name, not by a second heading.
 */
export const PanelTitleContext = createContext<string | undefined>(undefined);
