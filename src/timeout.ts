export class TimeoutError extends Error {
	readonly code = 'ERR_PG_LISTEN_TIMEOUT';
	override readonly name = 'TimeoutError';
}

/** Settles like `promise`, or rejects with a TimeoutError after `milliseconds`. */
export const withTimeout = async <Value>(promise: Promise<Value>, milliseconds: number, message: string): Promise<Value> => {
	let timer: NodeJS.Timeout | undefined;
	const timeout = new Promise<never>((_resolve, reject) => {
		timer = setTimeout(() => reject(new TimeoutError(message)), milliseconds);
	});
	try {
		return await Promise.race([promise, timeout]);
	} finally {
		clearTimeout(timer);
	}
};
