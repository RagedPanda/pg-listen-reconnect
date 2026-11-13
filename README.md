# pg-listen-reconnect

[![npm version](https://img.shields.io/npm/v/pg-listen-reconnect)](https://www.npmjs.com/package/pg-listen-reconnect)
[![CI](https://github.com/RagedPanda/pg-listen-reconnect/actions/workflows/ci.yml/badge.svg)](https://github.com/RagedPanda/pg-listen-reconnect/actions/workflows/ci.yml)
[![coverage](https://img.shields.io/badge/coverage-100%25-brightgreen)](https://github.com/RagedPanda/pg-listen-reconnect/actions/workflows/ci.yml)
[![types](https://img.shields.io/npm/types/pg-listen-reconnect)](https://www.npmjs.com/package/pg-listen-reconnect)
[![pg](https://img.shields.io/npm/dependency-version/pg-listen-reconnect/peer/pg)](https://node-postgres.com)
[![license](https://img.shields.io/npm/l/pg-listen-reconnect)](LICENSE)

A Postgres LISTEN/NOTIFY client for [`pg`](https://node-postgres.com) that stays subscribed. When the connection drops, it reconnects with backoff, runs LISTEN again for every channel, and tells you that notifications may have been missed, so you can re-sync. It has the same API as [pg-listen](https://github.com/andywer/pg-listen), so moving over is an import change.

```ts
import createSubscriber from 'pg-listen-reconnect';

const subscriber = createSubscriber({connectionString: process.env.DATABASE_URL});

subscriber.notifications.on('orders', payload => {
	console.log('order changed', payload);
});
subscriber.events.on('missed', ({channels, disconnectedAt}) => {
	// NOTIFY is not stored: reload whatever may have changed since disconnectedAt.
});

await subscriber.connect();
await subscriber.listenTo('orders');
await subscriber.notify('orders', {id: 42, status: 'paid'});
```

## Why

LISTEN only works while one connection stays open. A pool hands out a different connection each time, so a listener needs its own `pg.Client`, and that client's connection will eventually drop: a database restart, a failover, a proxy idle timeout, a network blip. `pg` does not reconnect on its own, and the pg maintainer points people to LISTEN/NOTIFY libraries instead of adding it to `pg` ([brianc/node-postgres#3548](https://github.com/brianc/node-postgres/issues/3548)).

The usual library for this is **pg-listen**. Its last release, 1.7.0, came out in May 2022, and it fails in the cases that matter:

- **It gives up on a database restart.** It stops retrying after 3 seconds by default, emits `error` and stays disconnected for good ([pg-listen#56](https://github.com/andywer/pg-listen/issues/56)). In the benchmark below, it gave up while the server was down for 5 seconds.
- **It does not notice a half-open connection.** Its health check sends `SELECT 1` with no timeout, so when the network silently drops packets the query waits forever and the subscriber stays on a dead connection. In the benchmark it was still on the dead connection after 10 seconds, and in a separate check its `notify()` calls on such a connection never settled.
- **`close()` does not stop reconnecting** ([pg-listen#61](https://github.com/andywer/pg-listen/issues/61)), and the first `connect()` does not retry at all ([pg-listen#32](https://github.com/andywer/pg-listen/issues/32)).
- **The retry interval is fixed** ([pg-listen#41](https://github.com/andywer/pg-listen/issues/41)), there is no ESM build ([pg-listen#79](https://github.com/andywer/pg-listen/issues/79)), and installing it with `pg` raises questions about which `pg` it uses ([pg-listen#55](https://github.com/andywer/pg-listen/issues/55)).
- **A bad JSON payload is reported on `error`**, the event its README says to exit the process on.
- **Nothing tells you what you missed.** Postgres does not keep notifications for a client that is not listening, so anything sent during the outage is gone, and your app has no hook to catch up.

pg-listen-reconnect keeps pg-listen's API and fixes those: retries never stop by default and back off exponentially, a health check that gets no answer counts as a lost connection, `close()` stops everything, the first `connect()` retries, bad payloads go to their own `parseError` event, and every reconnect ends with a `missed` event.

## Install

```sh
npm install pg-listen-reconnect pg
```

Dependencies:

- **`pg`** (8.7.0 or later in 8.x) is a peer dependency: you already have it, and the subscriber uses your copy and your version.
- **`@types/pg`** is an optional peer dependency, only for TypeScript users. The types refer to `pg`'s `ClientConfig`.
- There are **no runtime dependencies**. pg-listen needed `debug`, `pg-format` and `typed-emitter`; this package uses bind parameters and quoted identifiers instead of `pg-format`, and Node's `EventEmitter` with its own types.

## Usage

### Listen to channels

```ts
import createSubscriber from 'pg-listen-reconnect';

const subscriber = createSubscriber('postgres://user:password@localhost/app');

subscriber.notifications.on('jobs', payload => {
	// payload is the parsed JSON
});
subscriber.events.on('notification', ({channel, payload, processId}) => {
	// every notification on every channel
});

await subscriber.connect();
await subscriber.listenTo('jobs');
```

The first argument is anything `new pg.Client()` takes: a connection string, a config object, or nothing to use the `PG*` environment variables. TCP keepalive is always turned on.

`connect()` retries under the same policy as reconnects, so the app can start before the database is up. Errors that retrying cannot fix, such as a wrong password or a missing database, reject right away. `connect()` and `listenTo()` can be called in any order and more than once.

### Send notifications

```ts
await subscriber.notify('jobs', {id: 7});
```

The payload is serialized with `JSON.stringify` and sent as a bind parameter of `SELECT pg_notify($1, $2)`, so it is never pasted into SQL. `notify()` rejects with `ERR_PG_LISTEN_NOT_CONNECTED` while the subscriber is reconnecting.

### Catch up after a reconnect

```ts
subscriber.events.on('missed', async ({channels, disconnectedAt, reconnectedAt, attempts}) => {
	await reloadJobsChangedSince(disconnectedAt);
});
subscriber.events.on('reconnect', attempt => {
	console.warn(`reconnecting, attempt ${attempt}`);
});
subscriber.events.on('connected', () => {
	console.info('listening');
});
```

`missed` fires after every reconnect, once LISTEN ran again on the new connection, so nothing sent after it is lost. Use it to reload whatever the notifications are about. `connected` fires before it, and also after the first `connect()`.

### Typed channels

```ts
type Channels = {
	orders: {id: number; status: 'paid' | 'shipped'};
	ping: undefined;
};

const subscriber = createSubscriber<Channels>(config);
subscriber.notifications.on('orders', order => order.status); // typed
await subscriber.notify('orders', {id: 1, status: 'paid'});
await subscriber.notify('ping');
// @ts-expect-error: unknown channel
await subscriber.listenTo('order');
```

The types are a promise about what senders put in the payload. Nothing checks them at runtime; validate in `parse` if other code also sends to the channel.

### Payloads that are not JSON

```ts
subscriber.events.on('parseError', ({error, channel, payload}) => {
	console.warn(`bad payload on ${channel}: ${payload}`);
});
```

Without a `parseError` listener, the failure is emitted on `error` with the channel in the message, as pg-listen does. To receive raw strings, pass `parse: payload => payload` and `serialize: payload => payload`.

### Errors and shutdown

```ts
subscriber.events.on('error', error => {
	// Reconnecting failed for good: the retry budget ran out or the error cannot be fixed by retrying.
	// The subscriber is closed now.
	console.error(error);
	process.exit(1);
});

process.on('SIGTERM', async () => {
	await subscriber.close();
});
```

`error` only fires once the subscriber gave up, which with the default options means an error that retrying cannot fix. `close()` stops reconnecting, health checks and any connection attempt in progress, and resolves even when the connection is dead.

## Migrating from pg-listen

Change the import:

```diff
-import createSubscriber from 'pg-listen';
+import createSubscriber from 'pg-listen-reconnect';
```

`createSubscriber(connectionConfig, options)`, the `events` and `notifications` emitters, `connect`, `close`, `listenTo`, `unlisten`, `unlistenAll`, `notify`, `getSubscribedChannels` and the options `native`, `paranoidChecking`, `retryInterval`, `retryLimit`, `retryTimeout`, `parse` and `serialize` work as before. A test runs pg-listen's README example unchanged apart from the import. What behaves differently:

- **Retrying never stops by default**, instead of after 3 seconds. Set `retryTimeout` or `retryLimit` to give up earlier; `0` still means no limit, as in pg-listen.
- **The default retry interval backs off** from 250 ms to 2 s instead of a fixed 500 ms. Pass `retryInterval: 500` for the old behavior.
- **The health check has a timeout** (`paranoidCheckTimeout`, 10 s), and a failed or late check reconnects instead of only emitting `error`.
- **`error` means the subscriber gave up and is closed.** pg-listen also emitted it for health-check failures and bad payloads; bad payloads now go to `parseError` when you listen to it.
- **`notify()` and `listenTo()` don't go to a dead connection.** While reconnecting, `notify()` rejects with `ERR_PG_LISTEN_NOT_CONNECTED`, and `listenTo()` and `unlisten()` are applied by the reconnect.
- **New events:** `missed` and `parseError`. `reconnect` still gets the attempt number.
- **Channel names are checked** (1 to 63 bytes, no NUL) and always quoted, so they are case-sensitive: `listenTo('Orders')` and `NOTIFY orders` are different channels, as they were with pg-listen, which quoted names with `pg-format`.
- **`pg` is a peer dependency**, 8.7.0 or later. There is no `debug` logging; use the events.

## API

### `createSubscriber<Channels>(connection?, options?)`

Also the default export. Returns a subscriber; nothing connects until `connect()`.

- `connection`: a connection string or a `pg` `ClientConfig`. Default: `pg`'s defaults and the `PG*` environment variables.
- `Channels`: optional map from channel name to payload type. Default: any channel, any payload.

| Option | Default | |
| --- | --- | --- |
| `native` | `false` | Use `pg.native.Client`. Needs the `pg-native` package. |
| `paranoidChecking` | `30000` | Milliseconds between `SELECT 1` health checks, or `false` to turn them off. |
| `paranoidCheckTimeout` | `10000` | Milliseconds a health check may take before the connection counts as dead. |
| `retryInterval` | `exponentialBackoff()` | Milliseconds before the next attempt, or `(failedAttempts) => ms`. |
| `retryLimit` | `Infinity` | Most attempts per outage, and for `connect()`. `0` means no limit. |
| `retryTimeout` | `Infinity` | Most milliseconds of retrying per outage, and for `connect()`. `0` means no limit. |
| `parse` | `JSON.parse` | Turns a received payload into a value. An empty payload is `undefined` with the default. |
| `serialize` | `JSON.stringify` | Turns the value given to `notify()` into a payload. `undefined` is sent as an empty payload with the default. |

Only connection errors are retried: errors without a SQLSTATE (socket errors) and SQLSTATE classes 08 (connection), 53 (insufficient resources, such as too many connections) and 57 (operator intervention, such as a shutdown). Anything else, such as `28P01` (wrong password) or `3D000` (missing database), fails at once.

### Subscriber

| Member | |
| --- | --- |
| `connect(): Promise<void>` | Connects and listens to every channel added so far. Resolves when listening; rejects with `ERR_PG_LISTEN_CONNECTION_FAILED` (the `cause` is the last error) or `ERR_PG_LISTEN_CLOSED`. |
| `close(): Promise<void>` | Stops reconnecting and health checks and ends the connection, waiting at most 1 s before dropping the socket. Safe to call more than once. |
| `listenTo(channel): Promise<void>` | Starts listening. While disconnected, the channel is listened to by the next connection. |
| `unlisten(channel)`, `unlistenAll()` | Stop listening. |
| `notify(channel, payload?): Promise<void>` | Sends the serialized payload with `pg_notify`. Rejects with `ERR_PG_LISTEN_NOT_CONNECTED` while disconnected, `ERR_PG_LISTEN_CLOSED` after `close()`. |
| `getSubscribedChannels(): string[]` | The channels that are listened to, or will be on the next connection. |
| `isConnected(): boolean` | True while a connection is up and listening. |
| `events` | Emitter for the events below. |
| `notifications` | Emitter with one event per channel, named after the channel, whose argument is the parsed payload. |

### Events on `subscriber.events`

| Event | Arguments | |
| --- | --- | --- |
| `connected` | | After `connect()` and after every reconnect, once LISTEN ran for every channel. |
| `notification` | `{channel, payload, processId}` | Every notification on a channel that is listened to. |
| `reconnect` | `attempt` | Before each connection attempt after the connection was lost, starting at 1 for each outage. |
| `missed` | `{channels, disconnectedAt, reconnectedAt, attempts}` | After a reconnect: anything sent to `channels` between `disconnectedAt` and `reconnectedAt` was lost. |
| `parseError` | `{error, channel, payload, processId}` | `parse` threw. Without a listener, emitted as `error`. |
| `error` | `error` | Reconnecting failed for good; the subscriber is closed. |

### Helpers

- `exponentialBackoff({initial = 250, max = 2000, factor = 2})` returns a `retryInterval` function.
- `isRetryableError(error)` is the retry rule above.
- `assertChannelName(name)` throws a `TypeError` for a name LISTEN cannot use; `quoteIdentifier(name)` quotes it.
- `TimeoutError` (code `ERR_PG_LISTEN_TIMEOUT`) is the error a late health check fails with.

Errors from the subscriber carry a `code`: `ERR_PG_LISTEN_CONNECTION_FAILED`, `ERR_PG_LISTEN_NOT_CONNECTED`, `ERR_PG_LISTEN_CLOSED`.

## Benchmarks

Both libraries run against the same throwaway PostgreSQL server on 127.0.0.1, one after another, with the same channel and payload (`{"index": n}`).

- **Delivery**: one `pg` client sends 20,000 notifications in one `SELECT pg_notify(...) FROM generate_series(...)`; the time runs until the subscriber received all of them.
- **notify()**: 2,000 `notify()` calls, one after another.
- **Reconnect**: time from `pg_terminate_backend` on the listening connection until LISTEN works again on the new one.
- **Half-open**: a TCP proxy between the subscriber and the server stops forwarding without closing anything, as a dead network path does. Both use a 1 s health check; pg-listen-reconnect also gets `paranoidCheckTimeout: 2000`.
- **Server down**: the server is stopped for 5 s and started again, with each library's default retry options.

Median of 7 runs after 1 warmup. Node.js 24.17.0, Apple M5 (10 cores), macOS (Darwin 27.0.0), PostgreSQL 14.24:

| | pg-listen-reconnect 0.1.0 | pg-listen 1.7.0 |
| --- | ---: | ---: |
| Delivery | 1,276,521 notifications/s | 1,323,495 notifications/s |
| notify() | 28,522 calls/s | 35,138 calls/s |
| Reconnect after `pg_terminate_backend` | 2.8 ms | 2.9 ms |
| Half-open connection, 1 s health check | reconnected after 3,006 ms | still on the dead connection after 10 s |
| Server down for 5 s | reconnected 665 ms after the server was back | gave up and stayed disconnected |

Delivery is within 4% of pg-listen. `notify()` is about 19% slower: it sends `SELECT pg_notify($1, $2)` with bind parameters (as a prepared statement), where pg-listen sends a `NOTIFY` with the payload escaped into the SQL text. Reconnecting after a clean disconnect is as fast. The difference is in the last two rows.

The benchmark starts its own server with `initdb` and `pg_ctl` in a temp directory, so it needs the PostgreSQL server binaries on the `PATH` (or in `PG_BIN`). Rerun it with:

```sh
npm run bench
BENCH_NOTIFICATIONS=5000 BENCH_RUNS=3 BENCH_OUTAGE_MS=2000 npm run bench
```

## Good to know

- **Notifications sent while disconnected are lost.** That is how Postgres works; `missed` tells you when to re-sync, it can't bring them back. If you can't lose events, keep them in a table and use NOTIFY only as a wake-up.
- **A half-open connection is noticed within `paranoidChecking + paranoidCheckTimeout`**, 40 s with the defaults. Lower both if you need to notice sooner; each check is one `SELECT 1`.
- **Channel names are case-sensitive and quoted.** `NOTIFY Orders` in SQL sends to `orders`; send with `notify()` or `pg_notify('Orders', ...)` to match `listenTo('Orders')`.
- **`notify()` does not queue while reconnecting.** It rejects, so the caller decides whether to retry.
- **Tested with `pg` 8.7.0 and the latest 8.x.** `pg` 8.0.0 hangs on Node 24, so older versions are not supported.
- **One connection per subscriber.** Create one subscriber per process and listen to all channels on it.

## Related

- [pg-listen](https://github.com/andywer/pg-listen): the library whose API this one keeps.
- [pg-listener](https://github.com/vitaly-t/pg-listener): LISTEN/NOTIFY with reconnects for [pg-promise](https://github.com/vitaly-t/pg-promise).
- [pg-rx-listen](https://www.npmjs.com/package/pg-rx-listen): LISTEN/NOTIFY as RxJS observables.
- [pg-pubsub](https://github.com/voxpelli/node-pg-pubsub): an older publish/subscribe wrapper over `pg`.
- [node-postgres](https://node-postgres.com): the `pg` driver itself.

## License

MIT
