// A TCP proxy in front of Postgres that can fake the network failures a real deployment sees.
import {createConnection, createServer, type Socket} from 'node:net';

export type Proxy = {
	readonly port: number;
	/** Stops forwarding on every open connection without closing it: a half-open connection. */
	readonly freeze: () => void;
	/** Closes every open connection, as a network blip or a load balancer timeout would. */
	readonly dropAll: () => void;
	/** While true, new connections are accepted and never answered, like a server behind a dead link. */
	readonly stall: (stalling: boolean) => void;
	/** While true, new connections are closed straight away, like a server that is down. */
	readonly refuse: (refusing: boolean) => void;
	readonly connections: () => number;
	readonly close: () => Promise<void>;
};

export const startProxy = async (targetPort: number): Promise<Proxy> => {
	const pairs = new Set<[Socket, Socket]>();
	const frozen = new Set<[Socket, Socket]>();
	const stalled = new Set<Socket>();
	let refusing = false;
	let stalling = false;
	const server = createServer(client => {
		if (refusing) {
			client.destroy();
			return;
		}

		if (stalling) {
			client.on('error', () => undefined);
			stalled.add(client);
			return;
		}

		const upstream = createConnection({host: '127.0.0.1', port: targetPort});
		const pair: [Socket, Socket] = [client, upstream];
		pairs.add(pair);
		client.pipe(upstream);
		upstream.pipe(client);
		const drop = (): void => {
			pairs.delete(pair);
			client.destroy();
			upstream.destroy();
		};

		client.on('error', drop).on('close', drop);
		upstream.on('error', drop).on('close', drop);
	});
	await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
	const {port} = server.address() as {port: number};
	const destroyAll = (): void => {
		for (const [client, upstream] of pairs) {
			client.destroy();
			upstream.destroy();
		}

		pairs.clear();
	};

	return {
		port,
		freeze: () => {
			for (const [client, upstream] of pairs) {
				client.unpipe(upstream);
				upstream.unpipe(client);
				client.pause();
				upstream.pause();
				frozen.add([client, upstream]);
			}

			pairs.clear();
		},
		dropAll: destroyAll,
		stall: value => {
			stalling = value;
		},
		refuse: value => {
			refusing = value;
		},
		connections: () => pairs.size + stalled.size,
		close: async () => {
			destroyAll();
			for (const socket of stalled) {
				socket.destroy();
			}

			for (const [client, upstream] of frozen) {
				client.destroy();
				upstream.destroy();
			}

			await new Promise<void>(resolve => server.close(() => resolve()));
		},
	};
};
