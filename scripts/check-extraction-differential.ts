/**
 * `extract_units` is offered by BOTH servers — the npm one in
 * `src/mcp/tools.ts` and the Rust one in `crate/src/mcp/extract.rs`. One tool
 * name, one schema, two implementations, so the contract is identical output.
 *
 * `crate/fixtures/mcp-extract-units.json` pins the cases somebody thought of.
 * This generates them: documents in every format, carrying quantities of every
 * dimension, every refusal and the near misses around them, inside documents
 * that are sometimes broken — because jsonc-parser, saphyr, toml, rust-ini and
 * csv are transcribed in this repo, and their acceptance and their error text
 * are part of every answer.
 *
 * Run: bun scripts/check-extraction-differential.ts
 *   UNITS_LE_DIFFERENTIAL_SEED=<n>  reproduce a specific failure
 *   UNITS_LE_DIFFERENTIAL_CASES=<n> how many calls (default 1500)
 *   UNITS_LE_BIN=<path>             the Rust binary (default the release build)
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { TOOLS } from '../src/mcp/tools';

const ROOT = join(import.meta.dir, '..');
const BINARY = process.env.UNITS_LE_BIN ?? join(ROOT, 'crate', 'target', 'release', 'units-le');
const SEED = Number(process.env.UNITS_LE_DIFFERENTIAL_SEED ?? 20261004);
const CASES = Number(process.env.UNITS_LE_DIFFERENTIAL_CASES ?? 1500);

function seeded(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** Every dimension, every refusal, and the near misses around them. */
const QUANTITIES = [
	'30s', '300ms', '1h30m', '1h30', '30s1h', '2d', '1w', '90min', '45sec', '5us', '5µs', '5μs', '10ns', 'PT1H30M', 'P1DT2H', 'PT0.5S', 'PT1,5S', 'P1M', 'P1Y', 'PT1M', 'P', 'PT',
	'512MiB', '2GB', '1.5KB', '1.0KB', '64Ki', '1TiB', '100B', '1PB', '500mb', '500Mb', '1Kb', '10b',
	'15%', '0.5%', '120%', '-5%', '44.1kHz', '60Hz', '2.4GHz', '1KHz', '1THz',
	'500m', '1M', '2k', '3K', '4G', '5T', '6P', '1y', '2Y',
	'1,5s', '1.000s', '1.500MB', '0.825s', '1.2.3s', '1h + 30m', '30s*2', '2*30s', '1h-30m', '-30s', '+30s', '1h / 2',
	'99999999999999999999999999999999999999s', '999999999999999999999999999999999PiB', '1.00000000000000000000000000000000000001s',
	'30', '1.5', 'v1.2.3', '2026-08-12', '0x1d', 'abc', '30sec', '5 s', '30 s', '1e3s', '١٢s', '30S', '30Sec', '5mins', '2hrs', '3days',
];
const KEYS = ['timeout', 'ttl', 'cache', 'limits', 'a', 'b.c', 'café', 'retry_30s', 'key with space', '1'];

function generate(count: number, seed: number) {
	const random = seeded(seed);
	const pick = <T>(list: readonly T[]): T => list[Math.floor(random() * list.length)] as T;
	const quantity = () => (random() < 0.85 ? pick(QUANTITIES) : `${pick(QUANTITIES)}${pick([' ', '', ',', ';'])}${pick(QUANTITIES)}`);
	const several = () => Array.from({ length: 1 + Math.floor(random() * 6) }, quantity);
	const out: Array<{ name: string; args: Record<string, unknown> }> = [];
	for (let index = 0; index < count; index++) {
		const format = pick(['json', 'jsonc', 'yaml', 'yaml', 'toml', 'toml', 'ini', 'env', 'csv', 'tsv', 'text', 'text']);
		const values = several();
		let content: string;
		if (format === 'json' || format === 'jsonc') {
			const body: Record<string, unknown> = {};
			for (const [i, v] of values.entries()) body[`${pick(KEYS)}${i}`] = random() < 0.3 ? { nested: v, list: [v, 30, true] } : random() < 0.1 ? 30 : v;
			content = JSON.stringify(body, null, random() < 0.5 ? 2 : undefined);
			if (format === 'jsonc' && random() < 0.4) content = `{ // comment\n${content.slice(1).replace(/}$/, ',}')}`;
			if (random() < 0.1) content = pick([content.slice(0, -1), `${content} trailing`, '', '   ', `// c\n${content}`, `{,${content.slice(1)}`, "{'a': '30s'}"]);
		} else if (format === 'yaml') {
			content = values.map((v, i) => (random() < 0.2 ? `- ${v}` : `${pick(KEYS).replace(/ /g, '_')}${i}: ${random() < 0.3 ? JSON.stringify(v) : v}`)).join('\n');
			if (random() < 0.15) content = `---\n${content}\n---\nother: ${quantity()}`;
			if (random() < 0.1) content = pick([`${content}\n  bad: [`, `a: b: c`, `${content}\n\t- tab`, `key: "unterminated`, `- a\nb: c`, `%YAML 1.2\n---\n${content}`, `&a x: *b`]);
			content += random() < 0.05 ? pick(['\n%YAML', '\n%TAG', '\n%FOO bar', '\n%a: 1']) : '\n';
		} else if (format === 'toml') {
			content = values.map((v, i) => `${pick(['a', 'b', '"c d"', 'e.f'])}${i} = ${random() < 0.9 ? JSON.stringify(v) : v}`).join('\n');
			if (random() < 0.3) content = `[section]\n${content}\n[[arr]]\nx = ${JSON.stringify(quantity())}`;
			if (random() < 0.1) content = pick([`${content}\na = `, `${content}\n[section]\n[section]`, `a = "1"\na = "2"`, `${content}\nbare = 30s`, `x = 0x8000000000000000`]);
		} else if (format === 'ini') {
			content = `[${pick(['server', 'cache', ''])}]\n${values.map((v, i) => `${pick(KEYS)}${i}${pick(['=', ' = ', ':'])}${v}`).join('\n')}`;
			if (random() < 0.1) content = pick([`${content}\n[unterminated`, `${content}\n  ; indented comment`, `${content}\nbare key`, `= value`, `[s] ; c\na=1s`, `a = "quoted 30s`]);
		} else if (format === 'env') {
			content = values.map((v, i) => `${random() < 0.2 ? 'export ' : ''}${pick(KEYS).toUpperCase().replace(/\W/g, '_')}${i}=${random() < 0.3 ? `"${v}"` : v}${random() < 0.2 ? ' # comment' : ''}`).join('\n');
		} else if (format === 'csv' || format === 'tsv') {
			const sep = format === 'csv' ? ',' : '\t';
			content = Array.from({ length: 1 + Math.floor(random() * 4) }, () => several().map((v) => (random() < 0.2 ? `"${v}"` : v)).join(sep)).join(random() < 0.2 ? '\r\n' : '\n');
			if (random() < 0.1) content = `${content}${sep}"unterminated`;
		} else {
			content = values.map((v) => `${pick(['waits', 'holds', 'at', 'is', '(', '='])} ${v}${pick(['.', ',', '', ')', ' and'])}`).join(' ');
		}
		if (random() < 0.05) content = content.replace(/\n/g, '\r\n');
		if (random() < 0.03) content = `\ufeff${content}`;
		const r = random();
		const args: Record<string, unknown> = { content };
		if (format !== 'text') {
			if (r < 0.6) args.format = format;
			else if (r < 0.85) args.filename = `config.${format === 'env' ? 'env' : format}`;
			else if (r < 0.9) args.filename = format === 'env' ? '.env' : `x.${format.toUpperCase()}`;
		} else if (r < 0.3) args.filename = pick(['notes.txt', 'deploy.tf', 'README.md', 'nginx.conf']);
		if (random() < 0.15) args.dimension = pick(['duration', 'bytes', 'percent', 'frequency', 'DURATION', 'length', 7]);
		if (random() < 0.08) args.maxResults = pick([1, 2, 3, 0, 5001, 1.5, '10', null]);
		if (random() < 0.03) args.format = pick(['YAML', ' .json ', 'yml', 'properties', 'conf', 42]);
		if (random() < 0.02) delete args.content;
		out.push({ name: `${index}`, args });
	}
	return out;
}
type Generated = ReturnType<typeof generate>[number];

function canonical(value: unknown): string {
	if (value === null || typeof value !== 'object') return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
	const entries = Object.entries(value as Record<string, unknown>)
		.filter(([, item]) => item !== undefined)
		.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
	return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
}

async function fromNpm(documents: readonly Generated[]): Promise<string[]> {
	const tool = TOOLS.find((candidate) => candidate.name === 'extract_units');
	if (!tool) throw new Error('the npm server no longer offers extract_units');
	const answers: string[] = [];
	for (const document of documents) {
		try {
			answers.push(canonical(JSON.parse(JSON.stringify(await tool.handler(document.args)))));
		} catch (error) {
			answers.push(`error: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	return answers;
}

async function fromCrate(documents: readonly Generated[]): Promise<string[]> {
	if (!existsSync(BINARY)) throw new Error(`no binary at ${BINARY} — build it first: cd crate && cargo build --release`);
	const child = Bun.spawn([BINARY, 'mcp'], { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
	const draining = new Response(child.stdout).text();
	child.stdin.write(
		`${documents
			.map((document, id) =>
				JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'extract_units', arguments: document.args } }),
			)
			.join('\n')}\n`,
	);
	child.stdin.end();
	const stdout = await draining;
	await child.exited;
	const answers: string[] = new Array(documents.length);
	for (const line of stdout.split('\n')) {
		if (line.trim().length === 0) continue;
		const response = JSON.parse(line) as {
			id: number;
			result?: { structuredContent?: unknown; isError?: boolean; content?: { text: string }[] };
			error?: unknown;
		};
		if (response.error !== undefined) throw new Error(`the crate server refused document ${response.id}: ${JSON.stringify(response.error)}`);
		answers[response.id] = response.result?.isError
			? `error: ${response.result.content?.[0]?.text}`
			: canonical(response.result?.structuredContent);
	}
	const missing = answers.findIndex((answer) => answer === undefined);
	if (missing !== -1) throw new Error(`the crate server never answered document ${missing}: ${await new Response(child.stderr).text()}`);
	return answers;
}

const documents = generate(CASES, SEED);
console.log(`differential: ${documents.length} generated documents, seed ${SEED}, binary ${BINARY.replace(ROOT, '.')}`);
const [npm, crate] = await Promise.all([fromNpm(documents), fromCrate(documents)]);
const failures: string[] = [];
let quantities = 0;
let refused = 0;
let unparsed = 0;
for (const [index, document] of documents.entries()) {
	const ours = npm[index] as string;
	if (!ours.startsWith('error:')) {
		const answer = JSON.parse(ours);
		quantities += answer.data.quantities.length;
		refused += answer.data.refused;
		unparsed += answer.diagnostics.length;
	}
	if (ours !== crate[index]) {
		failures.push(
			`the two extract_units servers disagree on "${document.name}"\n  arguments: ${JSON.stringify(document.args).slice(0, 700)}\n  npm:   ${ours.slice(0, 900)}\n  crate: ${(crate[index] as string).slice(0, 900)}`,
		);
	}
}
console.log(`  ${quantities} quantities, ${refused} of them refusals, ${unparsed} documents that did not parse, ${npm.filter((a) => a.startsWith('error:')).length} refused calls`);
if (failures.length > 0) {
	console.error(`\nDIFFERENTIAL FAILED — ${failures.length} problem(s):\n`);
	for (const failure of failures.slice(0, 8)) console.error(`${failure}\n`);
	process.exit(1);
}
console.log('OK: both extract_units servers gave identical answers on every document.');
