/**
 * The three surfaces Lessons contributes (§2.3): the Lessons screen, a ferret's toolbar panel and the Settings tab.
 * Each reads the ferret directory through Lessons' own client, since a half talks only to its own plugin.
 */

import { daemonHomeHref, useOptionalRouter } from '@ferretry/app';
import { useEffect, useMemo, useState } from 'react';
import type { LessonsFerret } from '../../contract/index.ts';
import { fetchLessonsFerrets, type LessonsConnection } from './api.ts';
import { FerretLessonsPanel } from './ferret-lessons-panel.tsx';
import { LessonsPage } from './lessons-page.tsx';
import { LessonsSettingsSurface } from './lessons-settings.tsx';

/** The screen's path (per daemon, so under `/d/<daemon>/`), which a "View in Lessons" returns to. */
export const LESSONS_PATH = 'lessons';

/** Where "View in Lessons" goes from the route on screen: the Lessons screen of the daemon the reader is under. */
export const lessonsHref = (route: object): string => {
  const daemon = 'daemon' in route && typeof route.daemon === 'string' ? route.daemon : undefined;
  return daemon === undefined ? `/${LESSONS_PATH}` : `${daemonHomeHref(daemon)}/${LESSONS_PATH}`;
};

/** The ferret directory: `null` until the first read answers, and for a daemon that cannot answer it. */
function useLessonsFerrets(connection: LessonsConnection): readonly LessonsFerret[] | null {
  const [ferrets, setFerrets] = useState<readonly LessonsFerret[] | null>(null);
  useEffect(() => {
    let current = true;
    fetchLessonsFerrets(connection).then(
      next => {
        if (current) setFerrets(next);
      },
      () => undefined,
    );
    return () => {
      current = false;
    };
  }, [connection]);
  return ferrets;
}

export function lessonsSurfaces(connection: LessonsConnection) {
  function LessonsScreen() {
    const ferrets = useLessonsFerrets(connection);
    const router = useOptionalRouter();
    const navigate = useMemo(() => (router === null ? undefined : router.navigate), [router]);
    return (
      <LessonsPage
        connection={connection}
        ferrets={ferrets}
        {...(navigate === undefined ? {} : { onNavigate: to => navigate(to) })}
      />
    );
  }

  function FerretLessons({ subject }: { readonly subject?: string }) {
    const ferrets = useLessonsFerrets(connection);
    const router = useOptionalRouter();
    if (subject === undefined) return null;
    return (
      <FerretLessonsPanel
        connection={connection}
        ferretId={subject}
        ferrets={ferrets}
        {...(router === null ? {} : { onViewLessons: () => router.navigate(lessonsHref(router.route)) })}
      />
    );
  }

  function LessonsSettings() {
    const ferrets = useLessonsFerrets(connection);
    return <LessonsSettingsSurface connection={connection} ferrets={ferrets} />;
  }

  return { LessonsScreen, FerretLessons, LessonsSettings };
}
