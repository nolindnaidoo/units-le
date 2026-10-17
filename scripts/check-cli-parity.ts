/**
 * Requires the npm command line to behave exactly as the Rust one does.
 *
 * Both install a command named `units-le`, so a person or a CI step cannot tell
 * which one they have. This is a different contract from
 * `check-extraction-parity.ts`, which holds the extension's engine equal to
 * the crate's: here the whole terminal surface is compared, the walk, the
 * quantities and refusals, the key paths, the exit codes, stdout and stderr
 * byte for byte, and every reply `units-le mcp` writes, byte for byte too.
 *
 * Every case runs both binaries over one generated tree with stdout piped,
 * which is how a script sees them. `--version` is compared too: every surface
 * carries one version, and two binaries of one name disagreeing about it is
 * the first thing a person comparing them would see.
 *
 * Run: bun run build:cli && cargo build --locked --manifest-path crate/Cargo.toml
 *      bun scripts/check-cli-parity.ts
 */
import { spawnSync } from 'node:child_process';
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmdirSync,
	symlinkSync,
	unlinkSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..');
const RUST =
	process.env.UNITS_LE_BIN ??
	join(
		ROOT,
		'crate',
		'target',
		'debug',
		`units-le${process.platform === 'win32' ? '.exe' : ''}`,
	);
const NODE_CLI = join(ROOT, 'cli', 'cli.js');
/**
 * Node, by name, not `process.execPath`: this script runs under Bun, and the
 * package is run by Node wherever `npx` runs it. Bun's errors are not Node's.
 */
const NODE = process.env.NODE_BIN ?? 'node';

interface Case {
	readonly args: readonly string[];
	readonly stdin?: string | Buffer;
}

interface Outcome {
	readonly status: number | null;
	readonly stdout: string;
	readonly stderr: string;
}

for (const [label, path] of [
	['the Rust binary', RUST],
	['cli/cli.js', NODE_CLI],
] as const) {
	if (!existsSync(path)) {
		console.error(`FAIL: ${label} is missing at ${path}. Build it first.`);
		process.exit(1);
	}
}

const tree = mkdtempSync(join(tmpdir(), 'units-le-cli-parity-'));
const created: string[] = [];
const dirs: string[] = [tree];

function dir(relative: string): void {
	mkdirSync(join(tree, relative));
	dirs.push(join(tree, relative));
}

function file(relative: string, content: string | Buffer): void {
	writeFileSync(join(tree, relative), content);
	created.push(join(tree, relative));
}

function link(relative: string, target: string): void {
	// Windows grants symlinks to administrators and developer mode only, and
	// both binaries then see the same tree without the link.
	try {
		symlinkSync(target, join(tree, relative));
	} catch {
		return;
	}
	created.push(join(tree, relative));
}

const canLock = process.platform !== 'win32' && process.getuid?.() !== 0;

const TEXT = [
	'timeouts 30s, 250ms, 1h, 2d and 1.5h',
	'sizes 512MiB 10MB 1GB 1.5KB 4kb 100B 1Mb',
	'ratios 80% 0.5% 100%',
	'clocks 2.4GHz 60Hz 1kHz',
	'refusals 500m 1,5s 1h + 30m 99999999999999999999999d',
	'ünïcödé then 5s and é 3GB',
	'',
].join('\n');

function build(): void {
	dir('repo');
	dir('repo/.git');
	file('repo/.gitignore', 'ignored.txt\nbuild/\n');
	file('repo/.ignore', 'dot-ignored.txt\n');
	file('repo/notes.txt', TEXT);
	file('repo/config.json', '{"server": {"timeout": "30s", "limits": ["512MiB", "500m"]}, "load": "80%"}\n');
	file('repo/settings.jsonc', '{\n  // a comment\n  "ttl": "1h",\n}\n');
	file('repo/broken.json', '{"timeout": "30s",\n');
	file('repo/deploy.yaml', 'resources:\n  limits:\n    memory: 512Mi\n    cpu: 500m\n  timeout: 30s\n');
	file('repo/bad.yaml', 'a: [1, 2\n');
	file('repo/Cargo.toml', '[profile]\ntimeout = "45s"\nsize = "2GB"\n');
	file('repo/setup.ini', '[cache]\nttl = 15m\nsize = 64KiB\n');
	file('repo/.env', 'TIMEOUT=10s\nMAX=1GB\n');
	file('repo/app.env', 'RATE=1kHz\n');
	file('repo/rows.csv', 'name,limit\nalpha,256MB\nbeta,"1,5s"\n');
	file('repo/rows.tsv', 'name\tttl\ngamma\t2h\n');
	file('repo/README.md', '| key | value |\n| --- | --- |\n| timeout | 30s |\n');
	// Escaped in the document, so the value cannot be found verbatim and has no position.
	file('repo/escaped.json', '{"t": "30\\u0073"}\n');
	file('repo/bom.json', '\uFEFF{"t": "5s"}\n');
	file('repo/crlf.txt', 'wait 5s\r\nthen 10ms\r\n');
	file('repo/clean.md', 'no quantities, only 42 and 7\n');
	file('repo/empty.txt', '');
	file('repo/latin1.txt', Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]));
	file('repo/binary.dat', Buffer.from([0x00, 0x01, 0x02, 0x03]));
	// ripgrep's sniff reads 8 KiB: a NUL inside it is binary, one past it is not.
	file('repo/late-nul.dat', Buffer.concat([Buffer.alloc(100, 0x61), Buffer.from([0])]));
	file('repo/past-sniff.txt', Buffer.concat([Buffer.from('5s '), Buffer.alloc(8192, 0x61), Buffer.from([0])]));
	file('repo/ünïcödé.txt', '5s\n');
	file('repo/ignored.txt', '5s\n');
	file('repo/dot-ignored.txt', '5s\n');
	file('repo/.hidden.txt', '5s\n');
	dir('repo/build');
	file('repo/build/out.txt', '5s\n');
	dir('repo/nested');
	file('repo/nested/.gitignore', 'local.txt\n');
	file('repo/nested/local.txt', '5s\n');
	file('repo/nested/kept.txt', '7ms\n');
	link('repo/linked.txt', 'notes.txt');
	link('repo/linked-dir', 'nested');
	dir('none');
	file('none/plain.txt', 'nothing to see\n');
	dir('refusals');
	file('refusals/only.txt', '500m\n');
	dir('many');
	file('many/big.txt', `${TEXT}`.repeat(800));
	if (canLock) {
		file('repo/locked.txt', 'x\n');
		chmodSync(join(tree, 'repo', 'locked.txt'), 0o000);
		dir('closed');
		dir('closed/shut');
		file('closed/shut/inside.txt', 'x\n');
		file('closed/open.txt', '5s\n');
		chmodSync(join(tree, 'closed', 'shut'), 0o000);
	}
}

function cases(): readonly Case[] {
	const repo = join(tree, 'repo');
	const at = (name: string) => join(repo, name);
	const corpus = join(ROOT, 'crate', 'fixtures', 'documents');
	return [
		{ args: ['--help'] },
		{ args: ['-h'] },
		{ args: ['--version'] },
		{ args: ['-V'] },
		{ args: [repo, '--help'] },
		{ args: [] },
		{ args: [repo] },
		{ args: [`${repo}/`] },
		{ args: ['repo'] },
		{ args: ['./repo/nested/'] },
		{ args: [repo, '--hidden'] },
		{ args: [repo, '--no-ignore'] },
		{ args: [repo, '--hidden', '--no-ignore'] },
		{ args: [repo, '--strict'] },
		{ args: [repo, '--dimension', 'duration'] },
		{ args: [repo, '--dimension', 'BYTES'] },
		{ args: [repo, '--dimension', 'percent', '--dimension', 'frequency'] },
		{ args: [repo, '--dimension', 'mass'] },
		{ args: [repo, '--dimension'] },
		{ args: [repo, '--format', 'json'] },
		{ args: [repo, '--format', '.YAML'] },
		{ args: [repo, '--format', 'handwriting'] },
		{ args: [repo, '--format'] },
		{ args: [repo, '--nope'] },
		{ args: [repo, '-'] },
		{ args: [at('notes.txt')] },
		{ args: [at('config.json'), at('settings.jsonc'), at('broken.json')] },
		{ args: [at('deploy.yaml'), at('bad.yaml'), at('Cargo.toml'), at('setup.ini')] },
		{ args: [at('.env'), at('app.env'), at('rows.csv'), at('rows.tsv'), at('README.md')] },
		{ args: [at('bom.json'), at('crlf.txt'), at('clean.md'), at('empty.txt')] },
		{ args: [at('escaped.json')] },
		{ args: [at('latin1.txt'), at('binary.dat')] },
		{ args: [at('latin1.txt'), '--strict'] },
		{ args: [at('binary.dat'), '--strict'] },
		{ args: [at('ünïcödé.txt')] },
		{ args: [at('ignored.txt'), at('.hidden.txt'), at('dot-ignored.txt')] },
		{ args: [at('notes.txt'), at('notes.txt')] },
		{ args: [at('nested'), at('nested/kept.txt')] },
		{ args: [at('linked.txt')] },
		{ args: [at('linked-dir')] },
		{ args: [join(tree, 'none')] },
		{ args: [join(tree, 'refusals')] },
		{ args: [join(tree, 'refusals'), '--strict'] },
		{ args: [join(tree, 'refusals'), '--dimension', 'bytes'] },
		{ args: [join(tree, 'many')] },
		...(canLock
			? [
					{ args: [join(tree, 'closed')] },
					{ args: [at('locked.txt')] },
					{ args: [at('locked.txt'), '--strict'] },
				]
			: []),
		{ args: [join(tree, 'missing')] },
		{ args: [repo, join(tree, 'missing')] },
		{ args: [join(tree, 'mïssing')] },
		{ args: ['--stdin'] },
		{ args: ['--stdin', repo] },
		{ args: ['--stdin'], stdin: TEXT },
		{ args: ['--stdin', '--dimension', 'bytes'], stdin: TEXT },
		{ args: ['--stdin', '--format', 'json'], stdin: '{"a": {"b": "30s"}}' },
		{ args: ['--stdin', '--format', 'json'], stdin: '{"a": ' },
		{ args: ['--stdin', '--format', 'json'], stdin: '\uFEFF{"a": "5s"}' },
		{ args: ['--stdin'], stdin: `\uFEFF${TEXT}` },
		{ args: ['--stdin'], stdin: Buffer.from([0x63, 0xe9, 0x0a]) },
		{ args: ['--stdin'], stdin: Buffer.from([0x61, 0x00, 0x35, 0x73]) },
		{ args: ['--stdin'], stdin: '' },
		{ args: [corpus] },
		{ args: [corpus, '--hidden', '--no-ignore', '--strict'] },
	];
}

function run(command: readonly string[], testCase: Case): Outcome {
	const [program, ...rest] = command as [string, ...string[]];
	const result = spawnSync(program, [...rest, ...testCase.args], {
		input: testCase.stdin ?? '',
		cwd: tree,
		maxBuffer: 256 * 1024 * 1024,
	});
	return {
		status: result.status,
		stdout: result.stdout.toString('utf8'),
		stderr: result.stderr.toString('utf8'),
	};
}

function compareCli(): string[] {
	const failures: string[] = [];
	for (const testCase of cases()) {
		const rust = run([RUST], testCase);
		const node = run([NODE, NODE_CLI], testCase);
		for (const field of ['status', 'stdout', 'stderr'] as const) {
			if (rust[field] === node[field]) continue;
			failures.push(
				`units-le ${testCase.args.join(' ')}\n  ${field} differs\n` +
					describeDifference(String(rust[field]), String(node[field])),
			);
		}
	}
	return failures;
}

function mcpLines(): readonly string[] {
	const repo = join(tree, 'repo');
	let id = 0;
	const request = (method: string, params?: unknown) =>
		JSON.stringify({
			jsonrpc: '2.0',
			id: ++id,
			method,
			...(params === undefined ? {} : { params }),
		});
	const call = (name: string, args?: unknown) =>
		request('tools/call', args === undefined ? { name } : { name, arguments: args });
	const extract = (args: Record<string, unknown>) => call('extract_units', args);
	const scan = (args: Record<string, unknown>) => call('units_le_scan', args);
	return [
		request('initialize', { protocolVersion: '2024-11-05' }),
		JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
		request('tools/list'),
		request('ping'),
		request('resources/list'),
		request('tools/call'),
		request('tools/call', { arguments: {} }),
		request('tools/call', null),
		call('no_such_tool', {}),
		JSON.stringify({ jsonrpc: '2.0', id: 'tëxt-id', method: 'ping' }),
		JSON.stringify({ jsonrpc: '2.0', id: null, method: 'ping' }),
		JSON.stringify({ id: 77, method: 'ping' }),
		JSON.stringify({ jsonrpc: '2.0', id: 78 }),
		'not json',
		'',
		'   ',
		'[1, 2]',
		`${request('ping')}\r`,
		extract({ content: TEXT }),
		extract({ content: TEXT, dimension: 'duration', maxResults: 2 }),
		extract({ content: TEXT, dimension: 'Bytes' }),
		extract({ content: TEXT, dimension: 'mass' }),
		extract({ content: TEXT, dimension: 7 }),
		extract({ content: '{"a": "30s"}', format: 'json' }),
		extract({ content: 7 }),
		extract({}),
		call('extract_units', null),
		scan({ path: repo }),
		scan({ paths: [repo, join(tree, 'none')], dimension: 'bytes' }),
		scan({ path: repo, hidden: true, ignored: true }),
		scan({ path: repo, format: 'json' }),
		scan({ path: repo, format: 7 }),
		scan({ path: repo, dimension: 'mass' }),
		scan({ path: repo, dimension: null }),
		scan({ path: join(repo, 'notes.txt'), hidden: 'yes' }),
		scan({ path: join(tree, 'refusals') }),
		scan({ paths: [] }),
		scan({ paths: [3] }),
		scan({ path: 3, paths: [join(repo, 'clean.md')] }),
		scan({}),
		scan({ path: join(tree, 'missing') }),
		...(canLock ? [scan({ path: join(tree, 'closed') })] : []),
	];
}

function serve(command: readonly string[], input: string | Buffer): Outcome {
	const [program, ...rest] = command as [string, ...string[]];
	const result = spawnSync(program, [...rest, 'mcp'], { input, cwd: tree });
	return {
		status: result.status,
		stdout: result.stdout.toString('utf8'),
		stderr: result.stderr.toString('utf8'),
	};
}

function compareMcp(): string[] {
	const failures: string[] = [];
	const lines = mcpLines();
	const sessions: readonly (readonly [string, string | Buffer])[] = [
		['the whole session', `${lines.join('\n')}\n`],
		['a last line with no newline', lines[3] as string],
		[
			'a line that is not UTF-8',
			Buffer.concat([
				Buffer.from(`${lines[3]}\n`),
				Buffer.from([0x7b, 0xff, 0x7d, 0x0a]),
				Buffer.from(`${lines[3]}\n`),
			]),
		],
	];
	for (const [label, input] of sessions) {
		const rust = serve([RUST], input);
		const node = serve([NODE, NODE_CLI], input);
		for (const field of ['status', 'stdout', 'stderr'] as const) {
			if (rust[field] === node[field]) continue;
			failures.push(
				`units-le mcp, ${label}\n  ${field} differs\n` +
					describeDifference(String(rust[field]), String(node[field])),
			);
		}
	}
	return failures;
}

/** The first differing line, which is the one worth reading in a long output. */
function describeDifference(rust: string, node: string): string {
	const left = rust.split('\n');
	const right = node.split('\n');
	const index = left.findIndex((line, at) => line !== right[at]);
	const at = index === -1 ? left.length : index;
	const clip = (line: string | undefined) =>
		line === undefined || line.length <= 2000 ? line : `${line.slice(0, 2000)}…`;
	return `  line ${at + 1}\n  rust: ${clip(left[at])}\n  node: ${clip(right[at])}`;
}

function cleanUp(): void {
	const unlock: readonly (readonly [string, number])[] = [
		[join(tree, 'repo', 'locked.txt'), 0o600],
		[join(tree, 'closed', 'shut'), 0o700],
	];
	for (const [path, mode] of unlock) if (existsSync(path)) chmodSync(path, mode);
	for (const path of created) unlinkSync(path);
	for (const path of [...dirs].reverse()) rmdirSync(path);
}

build();
let failures: string[];
try {
	failures = [...compareCli(), ...compareMcp()];
} finally {
	cleanUp();
}

if (failures.length > 0) {
	console.error(failures.join('\n\n'));
	console.error(`\nFAIL: ${failures.length} difference(s) between the npm and Rust CLIs`);
	process.exit(1);
}
console.log(
	`OK: the npm CLI matches the Rust CLI on ${cases().length} commands and ${mcpLines().length} MCP lines`,
);
