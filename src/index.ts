import pg from 'pg';
import type {ClientConfig} from 'pg';
import {pickClientClass, type PgModule} from './client-class.ts';
import {createSubscriberWith} from './subscriber.ts';
import type {Options, Subscriber} from './types.ts';

/**
 * Creates a subscriber with its own dedicated connection. Takes the same connection config as
 * `new pg.Client()`, or a connection string, and pg-listen's options.
 */
export const createSubscriber = <Channels extends Record<string, unknown> = Record<string, any>>(
	connection?: string | ClientConfig,
	options: Options = {},
): Subscriber<Channels> => createSubscriberWith<Channels>(pickClientClass(pg as unknown as PgModule, options.native ?? false), connection, options);

export default createSubscriber;
export {assertChannelName, quoteIdentifier} from './channel.ts';
export {exponentialBackoff, isRetryableError} from './retry.ts';
export {TimeoutError} from './timeout.ts';
export type {BackoffOptions, RetryInterval} from './retry.ts';
export type {CodedError} from './errors.ts';
export type {Parse, Serialize} from './payload.ts';
export type {ChannelEvents, ClientConfig, MissedEvent, Notification, Options, ParseErrorEvent, Subscriber, SubscriberEvents, TypedEmitter} from './types.ts';
