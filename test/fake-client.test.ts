// Drives the subscriber with a scripted stand-in for pg.Client, for the races and failures
// a real server cannot produce on demand.
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {test} from 'node:test';
import {createSubscriberWith, type ClientClass} from '../src/subscriber.ts';
import type {Options} from '../src/types.ts';
import {nextEvent, record, sleep, waitFor} from './helpers.ts';

type Behavior = {
	connect?: () => Promise<void>;
	query?: (sql: string) => Promise<unknown>;
	end?: () => Promise<void>;
};

class FakeClient extends EventEmitter {
	static behavior: Behavior = {};
	static instances: FakeClient[] = [];
	readonly queries: string[] = [];
	ended = false;

	constructor() {
		super();
		FakeClient.instances.push(this);
	}

	async connect(): Promise<void> {
		return FakeClient.behavior.connect?.();
	}

	async query(sql: string): Promise<unknown> {
		this.queries.push(sql);
		return FakeClient.behavior.query?.(sql) ?? {rows: []};
	}

	async end(): Promise<void> {
		this.ended = true;
		return FakeClient.behavior.end?.();
	}
}

const fakeSubscriber = (behavior: Behavior, options: Options = {}) => {
	FakeClient.behavior = behavior;
	FakeClient.instances = [];
	return createSubscriberWith(FakeClient as unknown as ClientClass, undefined, {paranoidChecking: false, retryInterval: 1, ...options});
};

const latest = (): FakeClient => FakeClient.instances.at(-1) as FakeClient;

const deferred = () => {
	let resolve!: () => void;
	const promise = new Promise<void>(done => {
		resolve = done;
	});
	return {promise, resolve};
};

test('a LISTEN that the server rejects removes the channel again', async () => {
	const subscriber = fakeSubscriber({query: async sql => sql.startsWith('LISTEN') ? Promise.reject(Object.assign(new Error('nope'), {code: '42000'})) : {}});
	await subscriber.connect();
	await assert.rejects(subscriber.listenTo('a'), /nope/);
	assert.deepEqual(subscriber.getSubscribedChannels(), []);
	await subscriber.close();
});

test('an UNLISTEN cut off by a lost connection is left to the reconnect, other failures throw', async () => {
	let failWith: 'lost' | 'sql' | undefined;
	const subscriber = fakeSubscriber({query: async () => {
		if (failWith === 'lost') {
			latest().emit('error', new Error('socket gone'));
			throw new Error('Connection terminated');
		}

		if (failWith === 'sql') {
			throw new Error('syntax');
		}

		return {};
	}});
	await subscriber.connect();
	await subscriber.listenTo('a');
	await subscriber.listenTo('b');
	failWith = 'sql';
	await assert.rejects(subscriber.unlisten('a'), /syntax/);
	failWith = 'lost';
	const missed = nextEvent(subscriber.events, 'missed');
	await subscriber.unlisten('b');
	failWith = undefined;
	assert.deepEqual((await missed)[0].channels, []);
	await subscriber.close();
});

test('an end event without an error event also counts as a lost connection', async () => {
	const subscriber = fakeSubscriber({});
	await subscriber.connect();
	const first = latest();
	const missed = nextEvent(subscriber.events, 'missed');
	first.emit('end');
	await missed;
	assert.notEqual(latest(), first);
	assert.equal(first.ended, true);
	await subscriber.close();
});

test('notifications for a channel no longer listened to are dropped', async () => {
	const subscriber = fakeSubscriber({});
	await subscriber.connect();
	const received = record(subscriber.events, 'notification');
	latest().emit('notification', {processId: 1, channel: 'stale', payload: '1'});
	latest().emit('notification', {processId: 1, channel: 'error'});
	await subscriber.listenTo('error');
	latest().emit('notification', {processId: 1, channel: 'error'});
	assert.deepEqual(received.map(([notification]) => notification), [{processId: 1, channel: 'error', payload: undefined}]);
	await subscriber.close();
});

test('channels removed while a reconnect runs its LISTENs are unlistened before it finishes', async () => {
	const gate = deferred();
	let holdListen = false;
	const subscriber = fakeSubscriber({query: async sql => {
		if (holdListen && sql.startsWith('LISTEN')) {
			holdListen = false;
			await gate.promise;
		}

		return {};
	}});
	await subscriber.connect();
	await subscriber.listenTo('a');
	await subscriber.listenTo('b');
	holdListen = true;
	const missed = nextEvent(subscriber.events, 'missed');
	latest().emit('error', new Error('lost'));
	await waitFor(() => latest().queries.length === 1);
	await subscriber.unlisten('a');
	gate.resolve();
	assert.deepEqual((await missed)[0].channels, ['b']);
	assert.deepEqual(latest().queries, ['LISTEN "a"; LISTEN "b"', 'UNLISTEN "a"']);
	await subscriber.close();
});

test('a health check that fails after the connection was already replaced is ignored', async () => {
	const gate = deferred();
	let stall = true;
	const subscriber = fakeSubscriber({query: async sql => {
		if (sql === 'SELECT 1' && stall) {
			stall = false;
			await gate.promise;
			throw new Error('late failure');
		}

		return {};
	}}, {paranoidChecking: 5, paranoidCheckTimeout: 10_000});
	await subscriber.connect();
	const first = latest();
	await waitFor(() => first.queries.includes('SELECT 1'));
	const missed = nextEvent(subscriber.events, 'missed');
	first.emit('error', new Error('lost'));
	await missed;
	const instances = FakeClient.instances.length;
	gate.resolve();
	await sleep(30);
	assert.equal(FakeClient.instances.length, instances);
	assert.equal(subscriber.isConnected(), true);
	await subscriber.close();
});

test('a health check that is still running when the next one is due is not doubled', async () => {
	const gate = deferred();
	const subscriber = fakeSubscriber({query: async sql => sql === 'SELECT 1' ? gate.promise : {}}, {paranoidChecking: 5, paranoidCheckTimeout: 10_000});
	await subscriber.connect();
	await sleep(50);
	assert.equal(latest().queries.filter(sql => sql === 'SELECT 1').length, 1);
	gate.resolve();
	await subscriber.close();
});

test('close() drops the socket when ending the connection hangs', async () => {
	const subscriber = fakeSubscriber({end: async () => new Promise(() => undefined)});
	await subscriber.connect();
	let destroyed = false;
	Object.assign(latest(), {connection: {stream: {destroy: () => {
		destroyed = true;
	}}}});
	await subscriber.close();
	assert.equal(destroyed, true);
});

test('an initial connect that fails can be retried by calling connect() again', async () => {
	let fail = true;
	const subscriber = fakeSubscriber({connect: async () => fail ? Promise.reject(Object.assign(new Error('bad password'), {code: '28P01'})) : undefined});
	await assert.rejects(subscriber.connect(), {code: 'ERR_PG_LISTEN_CONNECTION_FAILED'});
	fail = false;
	await subscriber.connect();
	assert.equal(subscriber.isConnected(), true);
	await subscriber.close();
});
