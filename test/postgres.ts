// Starts a throwaway Postgres server in a temporary directory, so the tests can kill its
// connections or restart it without touching any database that is already running.
import {spawn} from 'node:child_process';
import {existsSync, mkdtempSync, readdirSync, rmSync} from 'node:fs';
import {createServer} from 'node:net';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';

/**
 * Runs a command to completion. stdio is ignored rather than piped: the server pg_ctl starts would
 * inherit the pipes and keep them open, so waiting for them to close would never finish.
 */
const run = async (command: string, args: readonly string[]): Promise<void> => new Promise((resolve, reject) => {
	const child = spawn(command, args, {stdio: 'ignore'});
	child.once('error', reject);
	child.once('exit', code => {
		if (code === 0) {
			resolve();
		} else {
			reject(new Error(`${path.basename(command)} exited with code ${code}`));
		}
	});
});
const executable = (name: string): string => process.platform === 'win32' ? `${name}.exe` : name;

const hasPgCtl = (directory: string | undefined): directory is string => directory !== undefined && directory !== '' && existsSync(path.join(directory, executable('pg_ctl')));

/** Debian and Ubuntu keep the server binaries off PATH, one directory per major version. */
const debianBinDirectories = (): string[] => {
	const root = '/usr/lib/postgresql';
	return existsSync(root) ? readdirSync(root).sort((left, right) => Number(right) - Number(left)).map(version => path.join(root, version, 'bin')) : [];
};

/** Where initdb and pg_ctl live: $PG_BIN, then PATH, then the Debian layout, then $PGBIN (Windows runners). */
export const findPostgresBin = (): string | undefined => [
	process.env['PG_BIN'],
	...(process.env['PATH'] ?? '').split(path.delimiter),
	...debianBinDirectories(),
	process.env['PGBIN'],
].find(directory => hasPgCtl(directory));

export const postgresBin = findPostgresBin();

/** Why the integration tests are skipped, for `test(name, {skip})`. */
export const skipWithoutPostgres: string | false = postgresBin === undefined ? 'no Postgres server binaries found (set PG_BIN to their directory)' : false;

export const freePort = async (): Promise<number> => new Promise((resolve, reject) => {
	const server = createServer();
	server.once('error', reject);
	server.listen(0, '127.0.0.1', () => {
		const {port} = server.address() as {port: number};
		server.close(() => resolve(port));
	});
});

export type Postgres = {
	readonly port: number;
	readonly config: {host: string; port: number; user: string; database: string};
	readonly start: () => Promise<void>;
	readonly stop: () => Promise<void>;
	/** Runs one query on a short-lived connection. */
	readonly query: (sql: string, values?: unknown[]) => Promise<pg.QueryResult>;
	/** Kills every other backend, as `pg_terminate_backend` would after a failover or by an admin. */
	readonly terminateOthers: () => Promise<number>;
	readonly destroy: () => Promise<void>;
};

export const startPostgres = async (): Promise<Postgres> => {
	const bin = postgresBin as string;
	const dataDirectory = mkdtempSync(path.join(os.tmpdir(), 'pg-listen-reconnect-'));
	const port = await freePort();
	const config = {host: '127.0.0.1', port, user: 'postgres', database: 'postgres'};
	await run(path.join(bin, executable('initdb')), ['-D', dataDirectory, '-U', 'postgres', '--auth=trust', '-E', 'UTF8', '--no-sync']);
	// No Unix socket: the temporary directory's path can be longer than the 103 bytes a socket path may have.
	// Windows has no shell to strip the quotes, and no socket directory by default.
	const socketOption = process.platform === 'win32' ? '' : ` -c unix_socket_directories=''`;
	const serverOptions = `-p ${port} -c listen_addresses=127.0.0.1 -c fsync=off${socketOption}`;
	const start = async (): Promise<void> => {
		await run(path.join(bin, executable('pg_ctl')), ['-D', dataDirectory, '-o', serverOptions, '-l', path.join(dataDirectory, 'server.log'), '-w', 'start']);
	};

	const stop = async (): Promise<void> => {
		await run(path.join(bin, executable('pg_ctl')), ['-D', dataDirectory, '-m', 'immediate', '-w', 'stop']);
	};

	const query = async (sql: string, values: unknown[] = []): Promise<pg.QueryResult> => {
		const client = new pg.Client(config);
		await client.connect();
		try {
			return await client.query(sql, values);
		} finally {
			await client.end();
		}
	};

	await start();
	return {
		port,
		config,
		start,
		stop,
		query,
		terminateOthers: async () => (await query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE pid <> pg_backend_pid() AND backend_type = $1', ['client backend'])).rowCount ?? 0,
		destroy: async () => {
			await stop().catch(() => undefined);
			rmSync(dataDirectory, {recursive: true, force: true});
		},
	};
};
