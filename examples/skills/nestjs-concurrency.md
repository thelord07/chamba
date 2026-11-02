---
name: nestjs-concurrency
description: NestJS concurrency and resource safety — singleton services with no per-request mutable state, p-limit/queues for fan-out, timeouts on HttpService, idempotent queue and webhook handlers, and shutdown hooks that close connections. Use for high-concurrency endpoints and background jobs.
scope: backend
---

# NestJS Concurrency & Resource Safety Playbook

**Measure first.** Look at metrics, traces or a profile (in staging, never against
production resources) before adding queues, pools or locks.
Apply these patterns where the plan marks a `hot-path` or where a race is demonstrable.

---

## 1. Singleton services must not hold per-request mutable state

NestJS services are singletons by default. Instance variables are shared across all
concurrent requests.

**Bad:**
```ts
@Injectable()
export class ReportService {
  private currentUserId: string; // shared across all requests!

  async generate(userId: string) {
    this.currentUserId = userId;           // race condition
    const data = await this.fetchData();
    return this.format(data);
  }
}
```

**Good — pass state as arguments:**
```ts
@Injectable()
export class ReportService {
  async generate(userId: string) {
    const data = await this.fetchData(userId);
    return this.format(data, userId);
  }
}
```

---

## 2. Bounded concurrency for fan-out with `p-limit`

Never `Promise.all` over a list of unknown size — it creates unbounded concurrency
and can exhaust connections, memory, or downstream rate limits.

```ts
import pLimit from 'p-limit';

@Injectable()
export class NotificationService {
  async notifyAll(userIds: string[]) {
    const limit = pLimit(10); // at most 10 in-flight at once
    await Promise.all(
      userIds.map((id) => limit(() => this.sendOne(id))),
    );
  }
}
```

---

## 3. Timeouts on `HttpService` (Axios)

Every external HTTP call on a request path must have a timeout. Without one, a slow
downstream can hold your connection pool indefinitely.

```ts
import { HttpService } from '@nestjs/axios';
import { firstValueFrom, timeout } from 'rxjs';

@Injectable()
export class PaymentClient {
  constructor(private http: HttpService) {}

  async charge(payload: ChargePayload) {
    const response$ = this.http.post('/charge', payload).pipe(
      timeout(5000), // throws TimeoutError after 5 s
    );
    return firstValueFrom(response$);
  }
}
```

Set a default timeout globally in `HttpModule.register({ timeout: 5000 })` and
override per-call only when the operation genuinely needs more.

---

## 4. Idempotent queue and webhook handlers

A message can be delivered more than once (at-least-once delivery). Handlers must be
idempotent: processing the same message twice must produce the same state.

Claim the key atomically **in the same transaction** as the write — a separate
"seen?" check followed by "mark" is itself a check-then-act race (two workers both see
"not seen" and both process):

```ts
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { DataSource } from 'typeorm';
import { Order } from './order.entity';

@Processor('orders')
export class OrderProcessor extends WorkerHost {
  constructor(private readonly dataSource: DataSource) {
    super();
  }

  async process(job: Job<{ orderId: string; idempotencyKey: string }>) {
    const { orderId, idempotencyKey } = job.data;
    await this.dataSource.transaction(async (tx) => {
      // processed_jobs.key has a UNIQUE constraint
      const claimed = await tx.query(
        'INSERT INTO processed_jobs (key) VALUES ($1) ON CONFLICT (key) DO NOTHING RETURNING key',
        [idempotencyKey],
      );
      // with TypeORM on Postgres, query() returns the RETURNING rows
      if (claimed.length === 0) return; // already processed — no-op

      await tx.update(Order, { id: orderId }, { status: 'fulfilled' });
    });
  }
}
```

If the write fails, the transaction rolls back the claim too, so a retry can run again.

For webhooks, store the webhook event ID in a `processed_events` table with a UNIQUE
constraint and catch the unique-violation error rather than doing a check-then-insert.

---

## 5. Shutdown hooks — close connections cleanly

Without shutdown hooks, in-flight requests and open DB connections are dropped hard on
`SIGTERM`, which can corrupt state or leave locks open.

```ts
// main.ts
const app = await NestFactory.create(AppModule);
app.enableShutdownHooks(); // listens for SIGTERM / SIGINT

await app.listen(3000);
```

Implement `OnModuleDestroy` in any service that holds a long-lived resource:

```ts
@Injectable()
export class WorkerService implements OnModuleDestroy {
  private worker: Worker | null = null;

  async onModuleDestroy() {
    await this.worker?.terminate();
    this.worker = null;
  }
}
```

For database connections, check what your integration does on shutdown: `@nestjs/typeorm`
closes its `DataSource` on application shutdown; for a raw Knex instance or a Prisma
client you provide yourself, call `knex.destroy()` / `prisma.$disconnect()` in
`onModuleDestroy`. Don't close the same connection twice.

---

## 6. No shared mutable global state across requests

Avoid module-level or static mutable variables reachable from request handlers.
If you need a shared counter or cache, use a proper store (Redis, DB) — an in-process
value is not shared across instances. A local cache is fine for read-mostly data if it
is bounded (size/TTL, e.g. `lru-cache`) and never holds per-request data.

---

## Restraint rule

Don't add a queue, a lock, or a concurrency limit "just in case." Confirm the hot
path and the actual failure mode first, then apply the minimal fix.
