import { forSubject } from '@ferretry/app';
import type { AppComponent, PanelProps } from '@ferretry/kernel/manifest';
import { implementApp } from '@ferretry/kernel/manifest';
import manifest from '../manifest.ts';
import { lessonsSurfaces } from './src/surfaces.tsx';

/** Lessons' app half (§2.3): the Lessons screen, a ferret's toolbar panel and the Settings tab. */
export default implementApp(manifest, {
  build: ({ client }) => {
    const { LessonsScreen, FerretLessons, LessonsSettings } = lessonsSurfaces({ key: manifest.id, client });
    return {
      screens: { lessons: LessonsScreen },
      panels: {
        'ferret-lessons': FerretLessons,
        // The first-run step's body: the Settings tab's view, only for its own step.
        'onboarding-step': forSubject('lessons.lessons', LessonsSettings as AppComponent<PanelProps>),
      },
      settings: { lessons: LessonsSettings },
    };
  },
});
