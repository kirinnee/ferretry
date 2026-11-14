import { provideToShell } from '@ferretry/app';
import { implementApp } from '@ferretry/kernel/manifest';
import manifest from '../manifest.ts';
import { lessonsCommands } from './command-bar.ts';
import { lessonsSurfaces } from './src/surfaces.tsx';

/** Lessons' app half (§2.3): the Lessons screen, a ferret's toolbar panel and the Settings tab. */
export default provideToShell(
  implementApp(manifest, {
    build: ({ client }) => {
      const { LessonsScreen, FerretLessons, LessonsSettings } = lessonsSurfaces({ key: manifest.id, client });
      return {
        screens: { lessons: LessonsScreen },
        panels: { 'ferret-lessons': FerretLessons },
        settings: { lessons: LessonsSettings },
      };
    },
  }),
  { commands: lessonsCommands },
);
