/**
 * Time behind a port so date-dependent logic (plan filenames, vault notes) is
 * testable and `@chamba/core` stays free of ambient `Date` calls.
 */
export interface ClockPort {
  now(): Date;
  /** Current date as `YYYY-MM-DD`. */
  today(): string;
}
