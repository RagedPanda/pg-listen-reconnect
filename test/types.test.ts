// Checked by `npm run typecheck`: the generic channel map types notify() and the per-channel emitter.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import createSubscriber, {type Subscriber} from '../src/index.ts';

type Channels = {orders: {id: number}; ping: undefined};

const typeChecks = async (subscriber: Subscriber<Channels>): Promise<void> => {
	await subscriber.notify('orders', {id: 1});
	await subscriber.notify('ping');
	// @ts-expect-error -- the payload must match the channel's type
	await subscriber.notify('orders', {id: 'x'});
	// @ts-expect-error -- orders needs a payload
	await subscriber.notify('orders');
	// @ts-expect-error -- unknown channel
	await subscriber.listenTo('nope');
	subscriber.notifications.on('orders', payload => {
		const id: number = payload.id;
		assert.equal(typeof id, 'number');
	});
	subscriber.events.on('missed', ({channels, disconnectedAt}) => {
		assert.ok(channels.length >= 0 && disconnectedAt instanceof Date);
	});
	// @ts-expect-error -- not an event
	subscriber.events.on('nope', () => undefined);
};

test('the untyped default accepts any channel and payload', () => {
	const subscriber = createSubscriber();
	assert.equal(typeof subscriber.notify, 'function');
	assert.equal(typeof typeChecks, 'function');
});
