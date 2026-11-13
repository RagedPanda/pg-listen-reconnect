import {EventEmitter} from 'node:events';
import type {Client, ClientConfig, Notification as PgNotification} from 'pg';
import {assertChannelName, channelChanges, channelChangesSql, listenSql, notifySql, notifyStatementName, unlistenAllSql, unlistenSql} from './channel.ts';
import {closedError, connectionFailedError, notConnectedError} from './errors.ts';
import {parsePayload, serializePayload, toError} from './payload.ts';
import {isRetryableError, isRetryBudgetSpent} from './retry.ts';
import {toClientConfig, toSettings, type Settings} from './settings.ts';
import {withTimeout} from './timeout.ts';
import type {MissedEvent, Options, Subscriber, SubscriberEvents} from './types.ts';

export type ClientClass = new (config: ClientConfig) => Client;

const noop = (): void => undefined;

const delay = async (milliseconds: number, signal: AbortSignal): Promise<void> => new Promise(resolve => {
	const timer = setTimeout(done, milliseconds);
	signal.addEventListener('abort', done, {once: true});
	function done(): void {
		clearTimeout(timer);
		signal.removeEventListener('abort', done);
		resolve();
	}
});

/**
 * Settles like `promise`, or rejects with a closed error once `signal` aborts. pg never settles
 * `connect()` for a client ended while it connects, so close() must not wait for it.
 */
const untilAborted = async <Value>(promise: Promise<Value>, signal: AbortSignal): Promise<Value> => new Promise((resolve, reject) => {
	const onAbort = (): void => {
		reject(closedError());
	};

	signal.addEventListener('abort', onAbort, {once: true});
	promise.then(resolve, reject).finally(() => {
		signal.removeEventListener('abort', onAbort);
	});
});

/** How long `close()` waits for a graceful goodbye before it drops the socket. */
const closeGracePeriod = 1000;

/** Drops the socket of a client whose connection may be half-open, so ending it cannot hang. */
const destroySocket = (client: Client): void => {
	(client as unknown as {connection?: {stream?: {destroy?: () => void}}}).connection?.stream?.destroy?.();
};

/** Stops using a client: no more events reach the subscriber, and late errors are swallowed. */
const discard = (client: Client): void => {
	client.removeAllListeners();
	client.on('error', noop);
	client.end().catch(noop);
};

type Connected = {readonly client: Client; readonly attempts: number};

/** The subscriber, with the client class passed in so tests can supply failing clients. */
export const createSubscriberWith = <Channels extends Record<string, unknown>>(
	ClientClass: ClientClass,
	connection: string | ClientConfig | undefined,
	options: Options,
): Subscriber<Channels> => {
	const settings: Settings = toSettings(options);
	const clientConfig = toClientConfig(connection);
	const events = new EventEmitter<SubscriberEvents>();
	const notifications = new EventEmitter();
	events.setMaxListeners(0);
	notifications.setMaxListeners(0);

	const channels = new Set<string>();
	const opening = new Set<Client>();
	const abort = new AbortController();
	let client: Client | undefined;
	let connecting: Promise<void> | undefined;
	let closing: Promise<void> | undefined;
	let stopHealthCheck = noop;

	const onNotification = ({processId, channel, payload = ''}: PgNotification): void => {
		if (!channels.has(channel)) {
			return;
		}

		const parsed = parsePayload(settings.parse, payload);
		if (!parsed.ok) {
			const event = {error: parsed.error, processId, channel, payload};
			if (events.listenerCount('parseError') > 0) {
				events.emit('parseError', event);
			} else {
				parsed.error.message = `Could not parse the payload of a notification on "${channel}": ${parsed.error.message}`;
				events.emit('error', parsed.error);
			}

			return;
		}

		events.emit('notification', {processId, channel, payload: parsed.payload});
		if (notifications.listenerCount(channel) > 0) {
			notifications.emit(channel, parsed.payload);
		}
	};

	/** Brings a fresh connection's LISTENs in line with `channels`, including changes made while it ran. */
	const reconcileChannels = async (candidate: Client): Promise<void> => {
		const listened = new Set<string>();
		for (let changes = channelChanges(channels, listened); changes.toListen.length + changes.toUnlisten.length > 0; changes = channelChanges(channels, listened)) {
			await candidate.query(channelChangesSql(changes));
			for (const channel of changes.toListen) {
				listened.add(channel);
			}

			for (const channel of changes.toUnlisten) {
				listened.delete(channel);
			}
		}
	};

	const openClient = async (): Promise<Client> => {
		const candidate = new ClientClass(clientConfig);
		candidate.on('error', noop);
		opening.add(candidate);
		try {
			await untilAborted(candidate.connect(), abort.signal);
			await reconcileChannels(candidate);
			opening.delete(candidate);
			return candidate;
		} catch (error) {
			opening.delete(candidate);
			discard(candidate);
			throw error;
		}
	};

	/** Connects with retries. Rejects once closed, or when retrying cannot help or the budget is spent. */
	const establish = async (onAttempt: (attempt: number) => void, attempt = 1, startedAt = Date.now()): Promise<Connected> => {
		if (abort.signal.aborted) {
			throw closedError();
		}

		onAttempt(attempt);
		try {
			return {client: await openClient(), attempts: attempt};
		} catch (error) {
			if (abort.signal.aborted) {
				throw closedError();
			}

			const retryable = isRetryableError(error);
			if (!retryable || isRetryBudgetSpent(settings, attempt, Date.now() - startedAt)) {
				throw connectionFailedError(error, attempt, retryable);
			}

			await delay(settings.retryDelay(attempt), abort.signal);
			return establish(onAttempt, attempt + 1, startedAt);
		}
	};

	const startHealthCheck = (current: Client): (() => void) => {
		const interval = settings.healthCheckInterval;
		if (interval === false) {
			return noop;
		}

		let checking = false;
		const check = async (): Promise<void> => {
			if (checking) {
				return;
			}

			checking = true;
			try {
				await withTimeout(current.query('SELECT 1'), settings.healthCheckTimeout, `The health check got no answer within ${settings.healthCheckTimeout} ms.`);
			} catch (error) {
				onConnectionLost(current, error);
			} finally {
				checking = false;
			}
		};

		const timer = setInterval(check, interval);
		timer.unref();
		return () => {
			clearInterval(timer);
		};
	};

	const activate = (fresh: Client): void => {
		client = fresh;
		fresh.on('notification', onNotification);
		fresh.on('error', error => {
			onConnectionLost(fresh, error);
		});
		fresh.on('end', () => {
			onConnectionLost(fresh, undefined);
		});
		stopHealthCheck = startHealthCheck(fresh);
	};

	const shutDown = (): Client | undefined => {
		abort.abort();
		stopHealthCheck();
		for (const candidate of opening) {
			discard(candidate);
		}

		const current = client;
		client = undefined;
		return current;
	};

	const reconnect = (disconnectedAt: Date): void => {
		connecting = establish(attempt => events.emit('reconnect', attempt)).then(({client: fresh, attempts}) => {
			activate(fresh);
			const missed: MissedEvent = {channels: [...channels], disconnectedAt, reconnectedAt: new Date(), attempts};
			events.emit('connected');
			events.emit('missed', missed);
		}, (error: unknown) => {
			if (!abort.signal.aborted) {
				shutDown();
				events.emit('error', toError(error));
			}
		}).finally(() => {
			connecting = undefined;
		});
	};

	function onConnectionLost(lost: Client, _error: unknown): void {
		if (lost !== client) {
			return;
		}

		client = undefined;
		stopHealthCheck();
		stopHealthCheck = noop;
		discard(lost);
		destroySocket(lost);
		reconnect(new Date());
	}

	const connect = async (): Promise<void> => {
		if (abort.signal.aborted) {
			throw closedError();
		}

		if (client !== undefined) {
			return;
		}

		connecting ??= establish(noop).then(({client: fresh}) => {
			activate(fresh);
			events.emit('connected');
		}).finally(() => {
			connecting = undefined;
		});
		return connecting;
	};

	const endGracefully = async (current: Client): Promise<void> => {
		current.removeAllListeners();
		current.on('error', noop);
		try {
			await withTimeout(current.end(), closeGracePeriod, 'Ending the connection took too long.');
		} catch {
			destroySocket(current);
		}
	};

	const close = async (): Promise<void> => {
		closing ??= (async () => {
			const current = shutDown();
			if (current !== undefined) {
				await endGracefully(current);
			}
		})();
		return closing;
	};

	/** Runs `sql` on the live connection. A query cut off by a lost connection is not an error: the reconnect catches up. */
	const runOnConnection = async (sql: string): Promise<void> => {
		const current = client;
		if (current === undefined) {
			return;
		}

		try {
			await current.query(sql);
		} catch (error) {
			if (current === client) {
				throw error;
			}
		}
	};

	const listenTo = async (name: string): Promise<void> => {
		const channel = assertChannelName(name);
		if (channels.has(channel)) {
			return;
		}

		channels.add(channel);
		try {
			await runOnConnection(listenSql([channel]));
		} catch (error) {
			channels.delete(channel);
			throw error;
		}
	};

	const unlisten = async (name: string): Promise<void> => {
		const channel = assertChannelName(name);
		if (channels.delete(channel)) {
			await runOnConnection(unlistenSql(channel));
		}
	};

	const unlistenAll = async (): Promise<void> => {
		channels.clear();
		await runOnConnection(unlistenAllSql);
	};

	const notify = async (name: string, payload?: unknown): Promise<void> => {
		const channel = assertChannelName(name);
		const serialized = serializePayload(settings.serialize, payload);
		if (client === undefined) {
			throw abort.signal.aborted ? closedError() : notConnectedError();
		}

		await client.query({name: notifyStatementName, text: notifySql, values: [channel, serialized]});
	};

	return {
		events,
		notifications,
		connect,
		close,
		isConnected: () => client !== undefined,
		getSubscribedChannels: () => [...channels],
		listenTo,
		unlisten,
		unlistenAll,
		notify,
	} as unknown as Subscriber<Channels>;
};
