---
name: knex-postgres-performance
description: Optimize Knex + PostgreSQL data access — fix N+1 query patterns with whereIn/joins, keyset pagination, indexes and EXPLAIN, transactions and SELECT FOR UPDATE, JSONB with GIN indexes, and large-table migrations. Use to optimize a slow Knex query or a database hot path.
scope: backend
---

# Knex + PostgreSQL Performance Playbook

**Measure first.** Run `EXPLAIN (ANALYZE, BUFFERS)` before writing a single line.
Optimize only what the plan marks as a `hot-path` or what profiling proves is slow.

---

## 1. Fix N+1 with `whereIn` or a join

**Bad — N+1:**
```ts
const orders = await db('orders').select('*');
for (const order of orders) {
  order.items = await db('order_items').where('order_id', order.id);
}
```

**Good — `whereIn`:**
```ts
const orders = await db('orders').select('*');
const ids = orders.map((o) => o.id);
const items = await db('order_items').whereIn('order_id', ids);
const byOrder = Map.groupBy(items, (i) => i.order_id);
for (const order of orders) order.items = byOrder.get(order.id) ?? [];
```
(`Map.groupBy` needs Node 21+; on older Node group with a plain loop.) If `ids` can be
large, chunk it (e.g. 1,000 per `whereIn`) — Postgres caps bind parameters at 65,535.

**Good — join when you need aggregates:**
```ts
await db('orders')
  .join('order_items', 'orders.id', 'order_items.order_id')
  .select('orders.id', 'orders.created_at', db.raw('COUNT(order_items.id) AS item_count'))
  .groupBy('orders.id');
```

---

## 2. Select only the columns you need

```ts
// bad: SELECT *
await db('users').select('*');

// good: named columns
await db('users').select('id', 'email', 'role');
```

---

## 3. Keyset pagination (avoid OFFSET on large tables)

`OFFSET N` scans and discards N rows every time. Use a cursor instead:

```ts
// First page
const page1 = await db('events')
  .orderBy([{ column: 'created_at', order: 'desc' }, { column: 'id', order: 'desc' }])
  .limit(50)
  .select('id', 'created_at', 'type');

// Next page — pass last row's values as cursor
const { created_at: cursor_ts, id: cursor_id } = page1[page1.length - 1];
const page2 = await db('events')
  .where((b) =>
    b
      .where('created_at', '<', cursor_ts)
      .orWhere((b2) => b2.where('created_at', cursor_ts).where('id', '<', cursor_id)),
  )
  .orderBy([{ column: 'created_at', order: 'desc' }, { column: 'id', order: 'desc' }])
  .limit(50)
  .select('id', 'created_at', 'type');
```

Index needed: `CREATE INDEX CONCURRENTLY ON events (created_at DESC, id DESC)`.

---

## 4. Indexes — add and verify

`CREATE INDEX CONCURRENTLY` cannot run inside a transaction, and Knex wraps each
migration in one by default — disable it for that migration:

```ts
// migration: safe on busy tables
exports.config = { transaction: false };

exports.up = async (knex) => {
  await knex.raw('CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_events_ts ON events (created_at DESC)');
};
exports.down = async (knex) => {
  await knex.raw('DROP INDEX CONCURRENTLY IF EXISTS idx_events_ts');
};
```

Verify the index is used:
```sql
EXPLAIN (ANALYZE, BUFFERS)
SELECT id, created_at FROM events WHERE created_at > now() - interval '7 days' ORDER BY created_at DESC LIMIT 50;
```
Look for `Index Scan` or `Index Only Scan`. If you see `Seq Scan` with high cost, check selectivity.

---

## 5. Transactions and `SELECT … FOR UPDATE`

Use a transaction for check-then-act patterns to avoid races:

```ts
await db.transaction(async (trx) => {
  // Lock the row for the duration of the transaction
  const [seat] = await trx('seats')
    .where({ id: seatId, status: 'available' })
    .forUpdate()   // SELECT … FOR UPDATE
    .select('id', 'status');

  if (!seat) throw new Error('Seat no longer available');

  await trx('seats').where({ id: seatId }).update({ status: 'reserved', user_id: userId });
  await trx('reservations').insert({ seat_id: seatId, user_id: userId });
});
```

Prefer a unique constraint as a last-resort guard even with locking.

---

## 6. JSONB — GIN indexes and selective reads

```sql
-- GIN index for containment queries (@>, ?)
CREATE INDEX CONCURRENTLY ON products USING GIN (attributes);

-- Expression index on one key (smaller; serves `attributes->>'category' = ?`)
CREATE INDEX CONCURRENTLY ON products ((attributes->>'category'));
```

In Knex — read only the key you need, not the whole document:
```ts
// bad: loads entire document, filters in app
const rows = await db('products').select('attributes');
const electronics = rows.filter((r) => r.attributes.category === 'electronics');

// good: filter and extract in DB
const rows = await db('products')
  .whereRaw("attributes->>'category' = ?", ['electronics'])
  .select('id', 'name', db.raw("attributes->>'price' AS price"));
```

---

## 7. Large-table migrations without long locks

Every `ALTER TABLE` takes an ACCESS EXCLUSIVE lock, even when it's metadata-only (adding a
nullable column, or — on Postgres 11+ — a column with a constant default). Keep that lock
short and make the migration fail fast instead of queueing behind a long query:
`lock_timeout`. A **volatile** default (e.g. `gen_random_uuid()`) or a type
change rewrites the whole table — avoid those on big tables.

Backfill in batches, each in its own short transaction — not inside the migration's
transaction:

```ts
exports.config = { transaction: false };

exports.up = async (knex) => {
  // short DDL transaction; SET LOCAL applies to this connection only
  await knex.transaction(async (trx) => {
    await trx.raw("SET LOCAL lock_timeout = '5s'");
    await trx.schema.alterTable('orders', (t) => {
      t.integer('priority'); // nullable, no default: metadata-only
    });
  });

  // batched backfill — each UPDATE commits on its own
  let lastId = 0;
  for (;;) {
    const rows = await knex('orders')
      .where('id', '>', lastId)
      .orderBy('id')
      .limit(500)
      .select('id');
    if (rows.length === 0) break;
    const ids = rows.map((r) => r.id);
    await knex('orders')
      .whereIn('id', ids)
      .whereNull('priority')
      .update({ priority: knex.raw('CASE WHEN total > 1000 THEN 1 ELSE 0 END') });
    lastId = ids[ids.length - 1];
  }
};
```

To make the column `NOT NULL` without scanning under the exclusive lock: add
`CHECK (priority IS NOT NULL) NOT VALID`, then `VALIDATE CONSTRAINT` (SHARE UPDATE
EXCLUSIVE — reads and writes continue), then `SET NOT NULL` (Postgres 12+ uses the
validated check and skips the scan), then drop the check. Same idea for foreign keys:
add `NOT VALID`, then `VALIDATE`.

---

## Restraint rule

Don't add an index, change a query, or rewrite a migration "just in case." Confirm the
hot path first, then measure with EXPLAIN, then act.
