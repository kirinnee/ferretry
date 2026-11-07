/**
 * Audit kinds this plugin adds. Today both writes record `fleet.configured` (Gate's kind) with a detail action; the
 * route declarations name that kind through Gate's `audit('fleet.configured')`, and these are the detail actions.
 */
export const LESSONS_CONFIGURED_ACTION = 'lessons-config' as const;
export const LESSON_APPLIED_ACTION = 'lesson-apply' as const;
