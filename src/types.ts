import type {ClientConfig} from 'pg';
import type {Parse, Serialize} from './payload.ts';
import type {RetryInterval} from './retry.ts';

export type {ClientConfig};

/** A notification as received, with the payload already parsed. */
export type Notification<Payload = unknown> = {
	readonly processId: number;
	readonly channel: string;
	readonly payload: Payload;
};

/** A notification whose payload could not be parsed. */
export type ParseErrorEvent = {
	readonly error: Error;
	readonly processId: number;
	readonly channel: string;
	/** The payload as received. */
	readonly payload: string;
};

/**
 * Passed to `missed` after a reconnect. Postgres does not keep notifications for a client that
 * was not listening, so anything sent to these channels between `disconnectedAt` and now is gone.
 */
export type MissedEvent = {
	/** The channels that are listened to again. */
	readonly channels: readonly string[];
	/** When the lost connection was noticed. */
	readonly disconnectedAt: Date;
	/** When the new connection was listening again. */
	readonly reconnectedAt: Date;
	/** How many connection attempts it took. */
	readonly attempts: number;
};

export type SubscriberEvents = {
	/** After the first connection and after every reconnect, once LISTEN ran for every channel. */
	readonly connected: [];
	/** Connecting failed for good: the retry budget ran out or the error cannot be fixed by retrying. The subscriber is closed. */
	readonly error: [error: Error];
	/** Every notification on a channel this subscriber listens to. */
	readonly notification: [notification: Notification];
	/** A connection attempt after the connection was lost. `attempt` starts at 1 for each outage. */
	readonly reconnect: [attempt: number];
	/** After a reconnect, once LISTEN ran again: re-sync anything that changed while disconnected. */
	readonly missed: [event: MissedEvent];
	/** A payload that `parse` rejected. Without a listener, it is emitted as `error` instead. */
	readonly parseError: [event: ParseErrorEvent];
};

/** The typed subset of an EventEmitter the subscriber exposes. */
export type TypedEmitter<Events extends {[Name in keyof Events]: unknown[]}> = {
	on<Name extends keyof Events & string>(event: Name, listener: (...args: Events[Name]) => void): TypedEmitter<Events>;
	once<Name extends keyof Events & string>(event: Name, listener: (...args: Events[Name]) => void): TypedEmitter<Events>;
	off<Name extends keyof Events & string>(event: Name, listener: (...args: Events[Name]) => void): TypedEmitter<Events>;
	addListener<Name extends keyof Events & string>(event: Name, listener: (...args: Events[Name]) => void): TypedEmitter<Events>;
	removeListener<Name extends keyof Events & string>(event: Name, listener: (...args: Events[Name]) => void): TypedEmitter<Events>;
	removeAllListeners(event?: keyof Events & string): TypedEmitter<Events>;
	listenerCount(event: keyof Events & string): number;
};

/** One event per channel, whose only argument is the parsed payload. */
export type ChannelEvents<Channels extends Record<string, unknown>> = {[Channel in keyof Channels & string]: [payload: Channels[Channel]]};

export type Options = {
	/** Use pg-native's client (`pg.native.Client`). Default false. */
	readonly native?: boolean;
	/**
	 * Milliseconds between health-check queries on the listening connection, or false to turn them off.
	 * A check that fails or gets no answer within `paranoidCheckTimeout` counts as a lost connection. Default 30000.
	 */
	readonly paranoidChecking?: number | false;
	/** Milliseconds a health-check query may take before the connection counts as dead. Default 10000. */
	readonly paranoidCheckTimeout?: number;
	/**
	 * Milliseconds to wait before attempt `attempt + 1`, as a number or a function of the number of failed
	 * attempts. Default: `exponentialBackoff()`, 250 ms doubling up to 2 s.
	 */
	readonly retryInterval?: RetryInterval;
	/** Most connection attempts per outage (and for `connect()`) before giving up. Default Infinity. */
	readonly retryLimit?: number;
	/** Most milliseconds to keep trying per outage (and for `connect()`) before giving up. Default Infinity. */
	readonly retryTimeout?: number;
	/** Turns a received payload into a value. Default `JSON.parse`. */
	readonly parse?: Parse;
	/** Turns a value given to `notify()` into a payload. Default `JSON.stringify`. */
	readonly serialize?: Serialize;
};

export type Subscriber<Channels extends Record<string, unknown> = Record<string, any>> = {
	/** Emits `connected`, `error`, `notification`, `reconnect`, `missed` and `parseError`. */
	readonly events: TypedEmitter<SubscriberEvents>;
	/** One event per channel, named after the channel, with the parsed payload. */
	readonly notifications: TypedEmitter<ChannelEvents<Channels>>;
	/** Connects, retrying under the same policy as reconnects, and listens to every channel added so far. */
	connect(): Promise<void>;
	/** Stops reconnecting and health checks and ends the connection. Safe to call more than once. */
	close(): Promise<void>;
	/** True while a connection is up and listening. */
	isConnected(): boolean;
	getSubscribedChannels(): string[];
	/** Starts listening. While reconnecting, the channel is listened to as part of the reconnect. */
	listenTo(channel: keyof Channels & string): Promise<void>;
	/** Stops listening to one channel. */
	unlisten(channel: keyof Channels & string): Promise<void>;
	/** Stops listening to every channel. */
	unlistenAll(): Promise<void>;
	/** Sends `payload`, serialized, with `pg_notify`. Rejects while disconnected. */
	notify<Channel extends keyof Channels & string>(channel: Channel, ...payload: undefined extends Channels[Channel] ? [payload?: Channels[Channel]] : [payload: Channels[Channel]]): Promise<void>;
};
