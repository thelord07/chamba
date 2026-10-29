/**
 * Time behind a port so date-dependent logic (plan filenames, vault notes) is
 * testable and `@chamba/core` stays free of ambient `Date` calls.
 */
export interface ClockPort {
  now(): Date;
  /** Current date as `YYYY-MM-DD`. */
  today(): string;
  /**
   * Sleep for `ms` milliseconds.
   * In production: `new Promise(resolve => setTimeout(resolve, ms))`.
   * In tests (FakeParche): the fake clock advances without real delay.
   * Optional: callers that need sleep must check for its presence or use a
   * clock that implements it.
   */
  sleep?(ms: number): Promise<void>;
}
