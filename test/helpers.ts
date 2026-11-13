import {once} from 'node:events';
import type {TypedEmitter} from '../src/types.ts';

/** Resolves with the arguments of the next `event`, or rejects after `milliseconds`. */
export const nextEvent = async <Events extends {[Name in keyof Events]: unknown[]}, Name extends keyof Events & string>(
	emitter: TypedEmitter<Events>,
	event: Name,
	milliseconds = 10_000,
): Promise<Events[Name]> => once(emitter as never, event, {signal: AbortSignal.timeout(milliseconds)}) as Promise<Events[Name]>;

export const sleep = async (milliseconds: number): Promise<void> => new Promise(resolve => {
	setTimeout(resolve, milliseconds);
});

/** Collects every emission of `event` into an array. */
export const record = <Events extends {[Name in keyof Events]: unknown[]}, Name extends keyof Events & string>(emitter: TypedEmitter<Events>, event: Name): Array<Events[Name]> => {
	const seen: Array<Events[Name]> = [];
	emitter.on(event, (...args) => {
		seen.push(args);
	});
	return seen;
};

/** Polls until `predicate` holds, failing after `milliseconds`. */
export const waitFor = async (predicate: () => boolean | Promise<boolean>, milliseconds = 10_000): Promise<void> => {
	const deadline = Date.now() + milliseconds;
	while (!(await predicate())) {
		if (Date.now() > deadline) {
			throw new Error('Timed out waiting for a condition');
		}

		await sleep(10);
	}
};
