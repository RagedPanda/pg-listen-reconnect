// Compares pg-listen-reconnect with pg-listen 1.7.0 on a throwaway Postgres server that this
// script starts in a temporary directory (it needs initdb and pg_ctl, see test/postgres.ts).
//
//   npm run bench
//   BENCH_NOTIFICATIONS=5000 BENCH_RUNS=3 BENCH_OUTAGE_MS=5000 npm run bench
//
// - Delivery: one statement sends BENCH_NOTIFICATIONS notifications with JSON payloads
//   (`SELECT pg_notify(...) FROM generate_series(...)`) from another connection; the clock stops
//   when the subscriber has emitted all of them. Reported as notifications per second.
// - notify(): BENCH_NOTIFICATIONS / 10 sequential `await subscriber.notify(channel, {index})` calls.
// - Reconnect: pg_terminate_backend on the listening connection; the clock stops at the next
//   `connected` event, which both libraries emit once LISTEN ran again.
// - Half-open: a TCP proxy between the subscriber and the server stops forwarding without closing
//   the connection, as a dead NAT entry or a cut link would. Health checks run every second
//   (pg-listen-reconnect also gets `paranoidCheckTimeout: 2000`); the clock stops at `connected`.
// - Outage: the server is stopped for BENCH_OUTAGE_MS, then started again; each library either
//   reconnects or gives up, with its default options.
// Delivery, notify() and reconnect report the median of BENCH_RUNS runs after one warmup.
import {once} from 'node:events';
import {createRequire} from 'node:module';
import os from 'node:os';
import {performance} from 'node:perf_hooks';
import createSubscriber from '../src/index.ts';
import {startPostgres, type Postgres} from '../test/postgres.ts';
import {startProxy} from '../test/proxy.ts';

const notificationCount = Number(process.env['BENCH_NOTIFICATIONS'] ?? 20_000);
const runs = Number(process.env['BENCH_RUNS'] ?? 7);
const outageMilliseconds = Number(process.env['BENCH_OUTAGE_MS'] ?? 5000);
const warmups = 1;

/** The API both libraries share, which is what makes moving between them an import change. */
type AnySubscriber = {
	readonly events: {on: (event: string, listener: (...args: any[]) => void) => unknown; once: (event: string, listener: (...args: any[]) => void) => unknown};
	connect: () => Promise<void>;
	close: () => Promise<void>;
	listenTo: (channel: string) => Promise<unknown> | undefined;
	notify: (channel: string, payload: unknown) => Promise<unknown>;
};

type Library = {readonly name: string; readonly create: (config: object, options?: object) => AnySubscriber};

const require = createRequire(import.meta.url);
const pgListen = (require('pg-listen') as {default: (config: object, options?: object) => AnySubscriber}).default;

const libraries: readonly Library[] = [
	{name: 'pg-listen-reconnect', create: (config, options) => createSubscriber(config, {...options, paranoidCheckTimeout: 2000}) as unknown as AnySubscriber},
	{name: 'pg-listen 1.7.0', create: (config, options) => pgListen(config, options)},
];

const median = (values: readonly number[]): number => {
	const sorted = values.toSorted((left, right) => left - right);
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
};

const repeat = async (measure: () => Promise<number>): Promise<number> => {
	const results = [];
	for (let run = 0; run < warmups + runs; run++) {
		const result = await measure();
		if (run >= warmups) {
			results.push(result);
		}
	}

	return median(results);
};

const connected = async (library: Library, postgres: Postgres, channel: string): Promise<AnySubscriber> => {
	const subscriber = library.create(postgres.config);
	subscriber.events.on('error', () => undefined);
	await subscriber.connect();
	await subscriber.listenTo(channel);
	return subscriber;
};

/** Resolves once `count` notifications arrived on the subscriber. */
const received = async (subscriber: AnySubscriber, count: number): Promise<void> => new Promise(resolve => {
	let seen = 0;
	const onNotification = (): void => {
		seen++;
		if (seen === count) {
			resolve();
		}
	};

	subscriber.events.on('notification', onNotification);
});

const delivery = async (library: Library, postgres: Postgres): Promise<number> => {
	const subscriber = await connected(library, postgres, 'bench');
	try {
		return await repeat(async () => {
			const done = received(subscriber, notificationCount);
			const start = performance.now();
			await postgres.query('SELECT pg_notify($1, json_build_object($2::text, index)::text) FROM generate_series(1, $3::int) AS index', ['bench', 'index', notificationCount]);
			await done;
			(subscriber.events as unknown as {removeAllListeners: (event: string) => void}).removeAllListeners('notification');
			return notificationCount / ((performance.now() - start) / 1000);
		});
	} finally {
		await subscriber.close();
	}
};

const notifyCalls = async (library: Library, postgres: Postgres): Promise<number> => {
	const subscriber = await connected(library, postgres, 'unused');
	const calls = Math.max(1, Math.round(notificationCount / 10));
	try {
		return await repeat(async () => {
			const start = performance.now();
			for (let index = 0; index < calls; index++) {
				await subscriber.notify('sent', {index});
			}

			return calls / ((performance.now() - start) / 1000);
		});
	} finally {
		await subscriber.close();
	}
};

const reconnect = async (library: Library, postgres: Postgres): Promise<number> => {
	const subscriber = await connected(library, postgres, 'reconnect');
	try {
		return await repeat(async () => {
			const back = once(subscriber.events as never, 'connected');
			const start = performance.now();
			await postgres.terminateOthers();
			await back;
			return performance.now() - start;
		});
	} finally {
		await subscriber.close();
	}
};

const halfOpenWindow = 10_000;

const halfOpen = async (library: Library, postgres: Postgres): Promise<string> => {
	const proxy = await startProxy(postgres.port);
	const subscriber = library.create({...postgres.config, port: proxy.port}, {paranoidChecking: 1000});
	subscriber.events.on('error', () => undefined);
	try {
		await subscriber.connect();
		await subscriber.listenTo('half-open');
		const back = new Promise<string>(resolve => {
			const start = performance.now();
			subscriber.events.once('connected', () => resolve(`reconnected after ${Math.round(performance.now() - start)} ms`));
		});
		proxy.freeze();
		const timeout = new Promise<string>(resolve => setTimeout(() => resolve(`still on the dead connection after ${halfOpenWindow / 1000} s`), halfOpenWindow).unref());
		return await Promise.race([back, timeout]);
	} finally {
		await Promise.race([subscriber.close(), new Promise(resolve => setTimeout(resolve, 2000).unref())]);
		await proxy.close();
	}
};

const outage = async (library: Library, postgres: Postgres): Promise<string> => {
	const subscriber = await connected(library, postgres, 'outage');
	const outcome = new Promise<string>(resolve => {
		subscriber.events.once('connected', () => resolve('reconnected'));
		subscriber.events.once('error', (error: Error) => resolve(`gave up: "${error.message.slice(0, 80)}"`));
	});
	try {
		await postgres.stop();
		await new Promise(resolve => setTimeout(resolve, outageMilliseconds));
		const restartedAt = performance.now();
		await postgres.start();
		const timeout = new Promise<string>(resolve => setTimeout(() => resolve('no event within 30 s'), 30_000).unref());
		const result = await Promise.race([outcome, timeout]);
		return result === 'reconnected' ? `reconnected ${Math.round(performance.now() - restartedAt)} ms after the server was back` : result;
	} finally {
		await subscriber.close();
	}
};

const postgres = await startPostgres();
try {
	const version = (await postgres.query('SHOW server_version')).rows[0] as {server_version: string};
	console.log(`Node.js ${process.version}, ${os.cpus()[0]?.model ?? os.arch()} (${os.cpus().length} cores), ${os.platform()} ${os.release()}, PostgreSQL ${version.server_version} on 127.0.0.1`);
	console.log(`Median of ${runs} runs after ${warmups} warmup; ${notificationCount.toLocaleString('en')} notifications per delivery run, ${Math.round(notificationCount / 10).toLocaleString('en')} notify() calls per run; outage ${outageMilliseconds} ms\n`);
	console.log(`| | ${libraries.map(library => library.name).join(' | ')} |`);
	console.log(`| --- |${libraries.map(() => ' ---: |').join('')}`);
	const rows: Array<[string, (library: Library) => Promise<string>]> = [
		['Delivery (notifications/s)', async library => Math.round(await delivery(library, postgres)).toLocaleString('en')],
		['notify() (calls/s)', async library => Math.round(await notifyCalls(library, postgres)).toLocaleString('en')],
		['Reconnect after pg_terminate_backend (ms)', async library => (await reconnect(library, postgres)).toFixed(1)],
		['Half-open connection, health check every 1 s', async library => halfOpen(library, postgres)],
		[`Server down for ${outageMilliseconds / 1000} s`, async library => outage(library, postgres)],
	];
	for (const [name, measure] of rows) {
		const cells = [];
		for (const library of libraries) {
			cells.push(await measure(library));
		}

		console.log(`| ${name} | ${cells.join(' | ')} |`);
	}
} finally {
	await postgres.destroy();
}
