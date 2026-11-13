import assert from 'node:assert/strict';
import {test} from 'node:test';
import {assertChannelName, channelChanges, channelChangesSql, channelNameProblem, listenSql, notifySql, quoteIdentifier, unlistenSql} from '../src/channel.ts';
import {closedError, connectionFailedError, notConnectedError} from '../src/errors.ts';
import {pickClientClass} from '../src/client-class.ts';
import {parsePayload, serializePayload, toError} from '../src/payload.ts';
import {defaultRetryInterval, exponentialBackoff, isRetryableError, isRetryBudgetSpent, toRetryDelay} from '../src/retry.ts';
import {toClientConfig, toSettings} from '../src/settings.ts';
import {TimeoutError, withTimeout} from '../src/timeout.ts';

test('channel names must be non-empty strings without NUL of at most 63 bytes', () => {
	assert.equal(channelNameProblem('orders'), undefined);
	assert.equal(channelNameProblem('x'.repeat(63)), undefined);
	assert.equal(channelNameProblem('é'.repeat(32)), 'must be at most 63 bytes long');
	assert.equal(channelNameProblem(''), 'must be a non-empty string');
	assert.equal(channelNameProblem(42), 'must be a non-empty string');
	assert.equal(channelNameProblem('a\0b'), 'must not contain a NUL character');
	assert.equal(assertChannelName('ok'), 'ok');
	assert.throws(() => assertChannelName(''), {name: 'TypeError', message: 'Invalid channel name "": it must be a non-empty string.'});
});

test('identifiers are always quoted, with embedded quotes doubled', () => {
	assert.equal(quoteIdentifier('orders'), '"orders"');
	assert.equal(quoteIdentifier('My-"Chan'), '"My-""Chan"');
	assert.equal(listenSql(['a', 'B']), 'LISTEN "a"; LISTEN "B"');
	assert.equal(unlistenSql('a"'), 'UNLISTEN "a"""');
	assert.equal(notifySql, 'SELECT pg_notify($1, $2)');
});

test('channelChanges lists what to LISTEN and UNLISTEN', () => {
	const changes = channelChanges(new Set(['a', 'b']), new Set(['b', 'c']));
	assert.deepEqual(changes, {toListen: ['a'], toUnlisten: ['c']});
	assert.equal(channelChangesSql(changes), 'LISTEN "a"; UNLISTEN "c"');
	assert.deepEqual(channelChanges(new Set(), new Set()), {toListen: [], toUnlisten: []});
});

test('payloads parse, an empty one is undefined, and parse failures become errors', () => {
	assert.deepEqual(parsePayload(JSON.parse, '{"a":1}'), {ok: true, payload: {a: 1}});
	assert.deepEqual(parsePayload(JSON.parse, ''), {ok: true, payload: undefined});
	const failed = parsePayload(JSON.parse, '{');
	assert.equal(failed.ok, false);
	assert.ok(!failed.ok && failed.error instanceof SyntaxError);
	const thrown = parsePayload(() => {
		throw 'plain string';
	}, 'x');
	assert.ok(!thrown.ok && thrown.error.message === 'plain string');
	assert.equal(serializePayload(JSON.stringify, undefined), '');
	assert.equal(serializePayload(JSON.stringify, {a: 1}), '{"a":1}');
	const error = new Error('e');
	assert.equal(toError(error), error);
});

test('exponentialBackoff grows by factor up to max', () => {
	assert.deepEqual([1, 2, 3, 4, 5, 6, 7, 8].map(defaultRetryInterval), [250, 500, 1000, 2000, 2000, 2000, 2000, 2000]);
	assert.deepEqual([0, 1, 2, 3].map(exponentialBackoff({initial: 10, max: 50, factor: 3})), [10, 10, 30, 50]);
	assert.equal(toRetryDelay(42)(9), 42);
	assert.equal(toRetryDelay(attempt => attempt * 2)(3), 6);
});

test('only connection, resource and operator SQLSTATEs and socket errors are retried', () => {
	for (const error of [new Error('ECONNREFUSED'), Object.assign(new Error('x'), {code: 'ECONNRESET'}), {code: '57P01'}, {code: '57P03'}, {code: '53300'}, {code: '08006'}, undefined]) {
		assert.equal(isRetryableError(error), true, JSON.stringify(error));
	}

	for (const code of ['28P01', '3D000', '42601']) {
		assert.equal(isRetryableError({code}), false, code);
	}
});

test('isRetryBudgetSpent checks the attempt count and the elapsed time', () => {
	assert.equal(isRetryBudgetSpent({retryLimit: 3, retryTimeout: 1000}, 2, 999), false);
	assert.equal(isRetryBudgetSpent({retryLimit: 3, retryTimeout: 1000}, 3, 0), true);
	assert.equal(isRetryBudgetSpent({retryLimit: Infinity, retryTimeout: 1000}, 99, 1000), true);
});

test('settings default like pg-listen, except that retrying never stops', () => {
	const settings = toSettings({});
	assert.equal(settings.healthCheckInterval, 30_000);
	assert.equal(settings.healthCheckTimeout, 10_000);
	assert.equal(settings.retryLimit, Infinity);
	assert.equal(settings.retryTimeout, Infinity);
	assert.equal(settings.retryDelay(1), 250);
	assert.equal(settings.parse, JSON.parse);
	assert.equal(settings.serialize, JSON.stringify);
	assert.equal(settings.native, false);
	const custom = toSettings({paranoidChecking: false, paranoidCheckTimeout: 5, retryLimit: 0, retryTimeout: 7, retryInterval: 3, native: true});
	assert.deepEqual([custom.healthCheckInterval, custom.healthCheckTimeout, custom.retryLimit, custom.retryTimeout, custom.retryDelay(5), custom.native], [false, 5, Infinity, 7, 3, true]);
});

test('client config keeps TCP keepalive on and accepts a connection string', () => {
	assert.deepEqual(toClientConfig('postgres://x'), {connectionString: 'postgres://x', keepAlive: true});
	assert.deepEqual(toClientConfig({host: 'h', keepAlive: false}), {host: 'h', keepAlive: true});
	assert.deepEqual(toClientConfig(undefined), {keepAlive: true});
});

test('errors carry stable codes', () => {
	assert.equal(notConnectedError().code, 'ERR_PG_LISTEN_NOT_CONNECTED');
	assert.equal(closedError().code, 'ERR_PG_LISTEN_CLOSED');
	const cause = new Error('boom');
	const failed = connectionFailedError(cause, 1, true);
	assert.equal(failed.message, 'Connecting to Postgres failed (gave up after 1 attempt): boom');
	assert.equal(failed.cause, cause);
	assert.equal(connectionFailedError('text', 2, false).message, 'Connecting to Postgres failed (not retrying this error): text');
});

test('withTimeout settles like the promise or rejects with a TimeoutError', async () => {
	assert.equal(await withTimeout(Promise.resolve(1), 100, 'slow'), 1);
	await assert.rejects(withTimeout(new Promise(() => undefined), 5, 'slow'), (error: unknown) => error instanceof TimeoutError && error.message === 'slow' && error.code === 'ERR_PG_LISTEN_TIMEOUT' && error.name === 'TimeoutError');
});

test('pickClientClass uses pg-native only when asked and when it is installed', () => {
	class Plain {}
	class Native {}
	assert.equal(pickClientClass({Client: Plain as never}, false), Plain);
	assert.equal(pickClientClass({Client: Plain as never, native: {Client: Native as never}}, true), Native);
	assert.throws(() => pickClientClass({Client: Plain as never, native: null}, true), /npm install pg-native/);
});
