import assert from 'node:assert/strict';
import {after, before, describe, test} from 'node:test';
import pg from 'pg';
import createSubscriber, {type Subscriber} from '../src/index.ts';
import {nextEvent, record, sleep, waitFor} from './helpers.ts';
import {skipWithoutPostgres, startPostgres, type Postgres} from './postgres.ts';
import {startProxy} from './proxy.ts';

type Channels = {
	orders: {id: number};
	'My-"Channel': string;
	ping: undefined;
};

describe('against a real Postgres server', {skip: skipWithoutPostgres}, () => {
	let postgres: Postgres;
	const subscribers: Array<Subscriber<any>> = [];
	const track = <Value extends Subscriber<any>>(subscriber: Value): Value => {
		subscribers.push(subscriber);
		return subscriber;
	};

	before(async () => {
		postgres = await startPostgres();
	});

	after(async () => {
		await Promise.all(subscribers.map(async subscriber => subscriber.close()));
		await postgres.destroy();
	});

	test('delivers parsed notifications on the events and per-channel emitters', async () => {
		const subscriber = track(createSubscriber<Channels>(postgres.config));
		const connected = nextEvent(subscriber.events, 'connected');
		await subscriber.connect();
		await connected;
		await subscriber.listenTo('orders');
		const perChannel = nextEvent(subscriber.notifications, 'orders');
		const event = nextEvent(subscriber.events, 'notification');
		await postgres.query('SELECT pg_notify($1, $2)', ['orders', '{"id":7}']);
		assert.deepEqual(await perChannel, [{id: 7}]);
		const [notification] = await event;
		assert.equal(notification.channel, 'orders');
		assert.deepEqual(notification.payload, {id: 7});
		assert.equal(typeof notification.processId, 'number');
		assert.equal(subscriber.isConnected(), true);
	});

	test('notify quotes nothing by hand: odd channel names and payloads round-trip', async () => {
		const subscriber = track(createSubscriber<Channels>(`postgres://postgres@127.0.0.1:${postgres.port}/postgres`));
		await subscriber.connect();
		await subscriber.listenTo('My-"Channel');
		await subscriber.listenTo('ping');
		const quoted = nextEvent(subscriber.notifications, 'My-"Channel');
		await subscriber.notify('My-"Channel', 'it\'s "quoted"; DROP TABLE x; --');
		assert.deepEqual(await quoted, ['it\'s "quoted"; DROP TABLE x; --']);
		const ping = nextEvent(subscriber.notifications, 'ping');
		await subscriber.notify('ping');
		assert.deepEqual(await ping, [undefined]);
	});

	test('connect and listenTo are idempotent, and channels are case-sensitive', async () => {
		const subscriber = track(createSubscriber(postgres.config));
		await Promise.all([subscriber.connect(), subscriber.connect()]);
		await subscriber.connect();
		await subscriber.listenTo('Upper');
		await subscriber.listenTo('Upper');
		assert.deepEqual(subscriber.getSubscribedChannels(), ['Upper']);
		const received = record(subscriber.events, 'notification');
		await postgres.query('SELECT pg_notify($1, $2), pg_notify($3, $4)', ['upper', '1', 'Upper', '2']);
		await waitFor(() => received.length === 1);
		await sleep(50);
		assert.deepEqual(received.map(([notification]) => notification.payload), [2]);
	});

	test('unlisten and unlistenAll stop delivery', async () => {
		const subscriber = track(createSubscriber(postgres.config));
		await subscriber.connect();
		await subscriber.listenTo('a');
		await subscriber.listenTo('b');
		await subscriber.unlisten('a');
		await subscriber.unlisten('never-listened');
		const received = record(subscriber.events, 'notification');
		await postgres.query('SELECT pg_notify($1, $2), pg_notify($3, $4)', ['a', '1', 'b', '2']);
		await waitFor(() => received.length === 1);
		assert.equal(received[0]?.[0].channel, 'b');
		await subscriber.unlistenAll();
		assert.deepEqual(subscriber.getSubscribedChannels(), []);
		await postgres.query('SELECT pg_notify($1, $2)', ['b', '3']);
		await sleep(50);
		assert.equal(received.length, 1);
	});

	test('a payload that is not JSON goes to parseError, or to error when nobody listens to parseError', async () => {
		const subscriber = track(createSubscriber(postgres.config));
		await subscriber.connect();
		await subscriber.listenTo('raw');
		const parseError = nextEvent(subscriber.events, 'parseError');
		await postgres.query('SELECT pg_notify($1, $2)', ['raw', 'not json']);
		const [event] = await parseError;
		assert.equal(event.channel, 'raw');
		assert.equal(event.payload, 'not json');
		assert.ok(event.error instanceof SyntaxError);

		subscriber.events.removeAllListeners('parseError');
		const error = nextEvent(subscriber.events, 'error');
		await postgres.query('SELECT pg_notify($1, $2)', ['raw', '{']);
		const [fallback] = await error;
		assert.match(fallback.message, /Could not parse the payload of a notification on "raw"/);
		assert.equal(subscriber.isConnected(), true);
	});

	test('custom parse and serialize', async () => {
		const subscriber = track(createSubscriber(postgres.config, {parse: text => text.toUpperCase(), serialize: value => `<${String(value)}>`}));
		await subscriber.connect();
		await subscriber.listenTo('custom');
		const received = nextEvent(subscriber.notifications, 'custom');
		await subscriber.notify('custom', 'x');
		assert.deepEqual(await received, ['<X>']);
	});

	test('re-listens after pg_terminate_backend and reports what may have been missed', async () => {
		const subscriber = track(createSubscriber(postgres.config));
		await subscriber.connect();
		await subscriber.listenTo('jobs');
		await subscriber.listenTo('other');
		const reconnects = record(subscriber.events, 'reconnect');
		const missed = nextEvent(subscriber.events, 'missed');
		const before = Date.now();
		assert.ok(await postgres.terminateOthers() >= 1);
		const [event] = await missed;
		assert.deepEqual(event.channels, ['jobs', 'other']);
		assert.equal(event.attempts, reconnects.length);
		assert.ok(event.disconnectedAt.getTime() >= before - 5);
		assert.ok(event.reconnectedAt >= event.disconnectedAt);
		const received = nextEvent(subscriber.notifications, 'jobs');
		await postgres.query('SELECT pg_notify($1, $2)', ['jobs', '1']);
		assert.deepEqual(await received, [1]);
	});

	test('survives a server restart that takes longer than pg-listen\'s 3 s default retryTimeout', async () => {
		const subscriber = track(createSubscriber(postgres.config, {retryInterval: 200}));
		await subscriber.connect();
		await subscriber.listenTo('restart');
		const missed = nextEvent(subscriber.events, 'missed', 20_000);
		await postgres.stop();
		await sleep(3500);
		assert.equal(subscriber.isConnected(), false);
		await assert.rejects(subscriber.notify('restart', 1), {code: 'ERR_PG_LISTEN_NOT_CONNECTED'});
		await postgres.start();
		const [event] = await missed;
		assert.ok(event.attempts > 5);
		assert.ok(event.reconnectedAt.getTime() - event.disconnectedAt.getTime() >= 3500);
		const received = nextEvent(subscriber.notifications, 'restart');
		await subscriber.notify('restart', 2);
		assert.deepEqual(await received, [2]);
	});

	test('the health check notices a half-open connection and reconnects', async () => {
		const proxy = await startProxy(postgres.port);
		try {
			const subscriber = track(createSubscriber({...postgres.config, port: proxy.port}, {paranoidChecking: 100, paranoidCheckTimeout: 300}));
			await subscriber.connect();
			await subscriber.listenTo('half');
			const missed = nextEvent(subscriber.events, 'missed');
			proxy.freeze();
			const [event] = await missed;
			assert.deepEqual(event.channels, ['half']);
			const received = nextEvent(subscriber.notifications, 'half');
			await postgres.query('SELECT pg_notify($1, $2)', ['half', '"back"']);
			assert.deepEqual(await received, ['back']);
		} finally {
			await proxy.close();
		}
	});

	test('connect() retries until the server accepts connections', async () => {
		const proxy = await startProxy(postgres.port);
		try {
			proxy.refuse(true);
			const subscriber = track(createSubscriber({...postgres.config, port: proxy.port}, {retryInterval: 50}));
			const connecting = subscriber.connect();
			await sleep(300);
			assert.equal(subscriber.isConnected(), false);
			proxy.refuse(false);
			await connecting;
			assert.equal(subscriber.isConnected(), true);
		} finally {
			await proxy.close();
		}
	});

	test('channels added and removed while reconnecting are applied by the reconnect', async () => {
		const proxy = await startProxy(postgres.port);
		try {
			const subscriber = track(createSubscriber({...postgres.config, port: proxy.port}, {retryInterval: 50}));
			await subscriber.connect();
			await subscriber.listenTo('kept');
			await subscriber.listenTo('dropped');
			proxy.refuse(true);
			const lost = nextEvent(subscriber.events, 'reconnect');
			proxy.dropAll();
			await lost;
			await subscriber.listenTo('added');
			await subscriber.unlisten('dropped');
			await assert.rejects(subscriber.notify('kept', 1), {code: 'ERR_PG_LISTEN_NOT_CONNECTED'});
			const missed = nextEvent(subscriber.events, 'missed');
			proxy.refuse(false);
			const [event] = await missed;
			assert.deepEqual(event.channels, ['kept', 'added']);
			const received = record(subscriber.events, 'notification');
			await postgres.query('SELECT pg_notify($1, $2), pg_notify($3, $4), pg_notify($5, $6)', ['dropped', '0', 'added', '1', 'kept', '2']);
			await waitFor(() => received.length === 2);
			assert.deepEqual(received.map(([notification]) => notification.channel), ['added', 'kept']);
		} finally {
			await proxy.close();
		}
	});

	test('gives up after retryLimit attempts, emits error and closes', async () => {
		const proxy = await startProxy(postgres.port);
		try {
			const subscriber = track(createSubscriber({...postgres.config, port: proxy.port}, {retryInterval: 20, retryLimit: 3}));
			await subscriber.connect();
			const reconnects = record(subscriber.events, 'reconnect');
			const error = nextEvent(subscriber.events, 'error');
			proxy.refuse(true);
			proxy.dropAll();
			const [failure] = await error;
			assert.equal((failure as {code?: string}).code, 'ERR_PG_LISTEN_CONNECTION_FAILED');
			assert.match(failure.message, /gave up after 3 attempts/);
			assert.deepEqual(reconnects.map(([attempt]) => attempt), [1, 2, 3]);
			assert.equal(subscriber.isConnected(), false);
			await assert.rejects(subscriber.notify('x'), {code: 'ERR_PG_LISTEN_CLOSED'});
			await assert.rejects(subscriber.connect(), {code: 'ERR_PG_LISTEN_CLOSED'});
		} finally {
			await proxy.close();
		}
	});

	test('connect() fails fast on errors retrying cannot fix, such as a missing database', async () => {
		const subscriber = track(createSubscriber({...postgres.config, database: 'does_not_exist'}));
		await assert.rejects(subscriber.connect(), (error: Error & {code?: string; cause?: {code?: string}}) => {
			assert.equal(error.code, 'ERR_PG_LISTEN_CONNECTION_FAILED');
			assert.equal(error.cause?.code, '3D000');
			assert.match(error.message, /not retrying this error/);
			return true;
		});
		assert.equal(subscriber.isConnected(), false);
	});

	test('close() stops a reconnect loop that would retry forever', async () => {
		const proxy = await startProxy(postgres.port);
		try {
			const subscriber = createSubscriber({...postgres.config, port: proxy.port}, {retryInterval: 60_000});
			await subscriber.connect();
			const reconnects = record(subscriber.events, 'reconnect');
			proxy.refuse(true);
			proxy.dropAll();
			await waitFor(() => reconnects.length === 1);
			await sleep(50);
			const startedAt = Date.now();
			await subscriber.close();
			await subscriber.close();
			assert.ok(Date.now() - startedAt < 1000);
			assert.equal(reconnects.length, 1);
		} finally {
			await proxy.close();
		}
	});

	test('close() during a connection attempt abandons it', async () => {
		const proxy = await startProxy(postgres.port);
		try {
			proxy.stall(true);
			const subscriber = createSubscriber({...postgres.config, port: proxy.port});
			const connecting = subscriber.connect();
			await waitFor(() => proxy.connections() === 1);
			await subscriber.close();
			await assert.rejects(connecting, {code: 'ERR_PG_LISTEN_CLOSED'});
		} finally {
			await proxy.close();
		}
	});

	test('close() does not hang on a half-open connection', async () => {
		const proxy = await startProxy(postgres.port);
		try {
			const subscriber = createSubscriber({...postgres.config, port: proxy.port}, {paranoidChecking: false});
			await subscriber.connect();
			proxy.freeze();
			const startedAt = Date.now();
			await subscriber.close();
			assert.ok(Date.now() - startedAt < 3000);
		} finally {
			await proxy.close();
		}
	});

	test('the native option needs pg-native', () => {
		assert.throws(() => createSubscriber(postgres.config, {native: true}), /pg-native/);
	});

	test('pg-listen code runs unchanged apart from the import', async () => {
		const received: unknown[] = [];
		const subscriber = track(createSubscriber(postgres.config, {paranoidChecking: 5000, retryLimit: 0, retryTimeout: 0}));
		subscriber.notifications.on('my-channel', payload => {
			received.push(payload);
		});
		subscriber.events.on('error', error => {
			throw error;
		});
		await subscriber.connect();
		await subscriber.listenTo('my-channel');
		await subscriber.notify('my-channel', {greeting: 'Hey, buddy.'});
		await waitFor(() => received.length === 1);
		assert.deepEqual(received, [{greeting: 'Hey, buddy.'}]);
		assert.ok(pg.Client);
	});
});
