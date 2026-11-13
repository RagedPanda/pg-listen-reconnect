export type Parse = (serialized: string) => unknown;
export type Serialize = (payload: unknown) => string;

export type ParsedPayload = {readonly ok: true; readonly payload: unknown} | {readonly ok: false; readonly error: Error};

/** An empty payload, which is what `NOTIFY channel` sends, parses to undefined. */
export const parsePayload = (parse: Parse, serialized: string): ParsedPayload => {
	if (serialized === '') {
		return {ok: true, payload: undefined};
	}

	try {
		return {ok: true, payload: parse(serialized)};
	} catch (error) {
		return {ok: false, error: toError(error)};
	}
};

/** `notify(channel)` without a payload sends an empty one. */
export const serializePayload = (serialize: Serialize, payload: unknown): string => payload === undefined ? '' : serialize(payload);

export const toError = (value: unknown): Error => value instanceof Error ? value : new Error(String(value));
