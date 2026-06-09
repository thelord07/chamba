import type { ClockPort } from '@chamba/core';

/** Node-backed `ClockPort` using the system clock. */
export class SystemClock implements ClockPort {
  now(): Date {
    return new Date();
  }

  today(): string {
    return this.now().toISOString().slice(0, 10);
  }
}
