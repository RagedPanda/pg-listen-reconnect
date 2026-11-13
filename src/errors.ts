export type CodedError = Error & {readonly code: string};

const codedError = (message: string, code: string, cause?: unknown): CodedError =>
	Object.assign(new Error(message, cause === undefined ? undefined : {cause}), {code});

export const notConnectedError = (): CodedError =>
	codedError('The subscriber is not connected to Postgres right now. Wait for the "connected" event and try again.', 'ERR_PG_LISTEN_NOT_CONNECTED');

export const closedError = (): CodedError => codedError('The subscriber is closed.', 'ERR_PG_LISTEN_CLOSED');

/** Why connecting stopped: the retry budget ran out, or the error is one retrying cannot fix. */
export const connectionFailedError = (cause: unknown, attempts: number, retryable: boolean): CodedError => {
	const reason = cause instanceof Error ? cause.message : String(cause);
	const verdict = retryable ? `gave up after ${attempts} attempt${attempts === 1 ? '' : 's'}` : 'not retrying this error';
	return codedError(`Connecting to Postgres failed (${verdict}): ${reason}`, 'ERR_PG_LISTEN_CONNECTION_FAILED', cause);
};
