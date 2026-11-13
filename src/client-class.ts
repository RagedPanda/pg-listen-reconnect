import type {ClientClass} from './subscriber.ts';

export type PgModule = {readonly Client: ClientClass; readonly native?: {readonly Client: ClientClass} | null};

/** pg's client class, or pg-native's when `native` is set. */
export const pickClientClass = (pgModule: PgModule, native: boolean): ClientClass => {
	if (!native) {
		return pgModule.Client;
	}

	const nativeClient = pgModule.native?.Client;
	if (nativeClient === undefined) {
		throw new Error('The native option needs the pg-native package: npm install pg-native');
	}

	return nativeClient;
};
