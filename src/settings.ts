import type {ClientConfig} from 'pg';
import type {Parse, Serialize} from './payload.ts';
import {defaultRetryInterval, toRetryDelay} from './retry.ts';
import type {Options} from './types.ts';

export type Settings = {
	readonly native: boolean;
	readonly healthCheckInterval: number | false;
	readonly healthCheckTimeout: number;
	readonly retryDelay: (attempt: number) => number;
	readonly retryLimit: number;
	readonly retryTimeout: number;
	readonly parse: Parse;
	readonly serialize: Serialize;
};

/** pg-listen treated 0 as "no limit" for retryLimit and retryTimeout, so this does too. */
const limitOrInfinity = (limit: number | undefined): number => limit === undefined || limit === 0 ? Number.POSITIVE_INFINITY : limit;

export const toSettings = (options: Options): Settings => ({
	native: options.native ?? false,
	healthCheckInterval: options.paranoidChecking ?? 30_000,
	healthCheckTimeout: options.paranoidCheckTimeout ?? 10_000,
	retryDelay: toRetryDelay(options.retryInterval ?? defaultRetryInterval),
	retryLimit: limitOrInfinity(options.retryLimit),
	retryTimeout: limitOrInfinity(options.retryTimeout),
	parse: options.parse ?? JSON.parse,
	serialize: options.serialize ?? JSON.stringify,
});

/** TCP keepalive stays on, as in pg-listen, so the OS also notices dead peers. */
export const toClientConfig = (connection: string | ClientConfig | undefined): ClientConfig => ({
	...(typeof connection === 'string' ? {connectionString: connection} : connection),
	keepAlive: true,
});
