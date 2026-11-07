import { implementDaemon } from '@ferretry/kernel/manifest';
import { LayoutsChanged, LAYOUTS_ITEMS, LAYOUTS_SELECTION, LAYOUTS_THEMES } from '../contract/index.ts';
import manifest from '../manifest.ts';
import { configDoorOf } from './lib/config-door.ts';
import { layoutsRoutes } from './lib/routes.ts';
import { createLayoutsService } from './lib/service.ts';

/**
 * Layouts (daemon half, §5.3): serves the owner's layout and theme and edits `config/layout.yaml`. Any change to the
 * layout, a layout item or a theme (our own write or a hand edit) tells every open app through `layouts.changed`.
 */
export default implementDaemon(manifest, {
  build: ({ kernel }) => {
    const service = createLayoutsService(kernel.config, configDoorOf(kernel.config));
    const tell = (): void => kernel.events.publish(LayoutsChanged, { layout: service.current().layout.id });
    for (const def of [LAYOUTS_SELECTION, LAYOUTS_ITEMS, LAYOUTS_THEMES]) kernel.config.watch(def, tell);
    return {
      routes: layoutsRoutes(service),
      provides: {
        layouts: { list: async () => service.list(), current: async () => service.current() },
      },
    };
  },
});
