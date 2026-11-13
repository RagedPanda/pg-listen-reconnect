/** Postgres keeps identifiers to NAMEDATALEN - 1 bytes and silently truncates longer ones in LISTEN. */
export const maxChannelBytes = 63;

/** Why a channel name cannot be used, or undefined when it can. */
export const channelNameProblem = (channel: unknown): string | undefined => {
	if (typeof channel !== 'string' || channel === '') {
		return 'must be a non-empty string';
	}

	if (channel.includes('\0')) {
		return 'must not contain a NUL character';
	}

	return Buffer.byteLength(channel, 'utf8') > maxChannelBytes ? `must be at most ${maxChannelBytes} bytes long` : undefined;
};

/** Throws a TypeError for a channel name Postgres would reject, truncate or that cannot be quoted. */
export const assertChannelName = (channel: unknown): string => {
	const problem = channelNameProblem(channel);
	if (problem !== undefined) {
		throw new TypeError(`Invalid channel name ${JSON.stringify(channel)}: it ${problem}.`);
	}

	return channel as string;
};

/**
 * Quotes a channel name as a Postgres identifier. Always quoting keeps the name exactly as given,
 * case included, so `LISTEN` matches `pg_notify(channel, ...)`, which never folds case.
 */
export const quoteIdentifier = (name: string): string => `"${name.replaceAll('"', '""')}"`;

export const listenSql = (channels: Iterable<string>): string => Array.from(channels, channel => `LISTEN ${quoteIdentifier(channel)}`).join('; ');

export const unlistenSql = (channel: string): string => `UNLISTEN ${quoteIdentifier(channel)}`;

export const unlistenAllSql = 'UNLISTEN *';

/** Sends the payload as a bind parameter, so it never needs quoting. */
export const notifySql = 'SELECT pg_notify($1, $2)';

/** A named statement is parsed once per connection, which roughly doubles notify() throughput. */
export const notifyStatementName = 'pg-listen-reconnect:notify';

export type ChannelChanges = {readonly toListen: readonly string[]; readonly toUnlisten: readonly string[]};

/** What a connection that listens to `listened` must run to listen to exactly `wanted`. */
export const channelChanges = (wanted: ReadonlySet<string>, listened: ReadonlySet<string>): ChannelChanges => ({
	toListen: [...wanted].filter(channel => !listened.has(channel)),
	toUnlisten: [...listened].filter(channel => !wanted.has(channel)),
});

export const channelChangesSql = ({toListen, toUnlisten}: ChannelChanges): string =>
	[...toListen.map(channel => listenSql([channel])), ...toUnlisten.map(channel => unlistenSql(channel))].join('; ');
