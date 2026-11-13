export type RetryInterval = number | ((attempt: number) => number);

export type BackoffOptions = {
	/** Delay before the second attempt, in milliseconds. Default 250. */
	readonly initial?: number;
	/** Upper bound for any delay, in milliseconds. Default 2000. */
	readonly max?: number;
	/** How much each delay grows over the previous one. Default 2. */
	readonly factor?: number;
};

/** Delays that grow by `factor` from `initial` up to `max`. `attempt` 1 is the first retry. */
export const exponentialBackoff = ({initial = 250, max = 2000, factor = 2}: BackoffOptions = {}) =>
	(attempt: number): number => Math.min(max, initial * (factor ** Math.max(0, attempt - 1)));

export const defaultRetryInterval = exponentialBackoff();

export const toRetryDelay = (retryInterval: RetryInterval): ((attempt: number) => number) =>
	typeof retryInterval === 'function' ? retryInterval : () => retryInterval;

/**
 * SQLSTATE classes worth retrying: 08 connection exception, 53 insufficient resources
 * (too many connections) and 57 operator intervention (shutting down, starting up).
 * Errors without a SQLSTATE come from the socket (ECONNREFUSED, ECONNRESET, timeouts).
 * Everything else, such as a wrong password or a missing database, fails the same way every time.
 */
export const isRetryableError = (error: unknown): boolean => {
	const code = (error as {code?: unknown} | undefined)?.code;
	if (typeof code !== 'string' || !/^[0-9A-Z]{5}$/.test(code)) {
		return true;
	}

	return ['08', '53', '57'].includes(code.slice(0, 2));
};

export type RetryBudget = {readonly retryLimit: number; readonly retryTimeout: number};

/** True once `attempts` failed attempts used up the retry count or the time budget. */
export const isRetryBudgetSpent = ({retryLimit, retryTimeout}: RetryBudget, attempts: number, elapsed: number): boolean =>
	attempts >= retryLimit || elapsed >= retryTimeout;
