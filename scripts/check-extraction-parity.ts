/**
 * Fails when the extension's extraction drifts from the shared corpus.
 *
 * - fixtures/extraction.json must reproduce under the port: every RFC 5952
 *   normalization, every classification, every refusal by name, and every
 *   document's findings, positions and key paths.
 * - fixtures/mcp-extract-ips.json must reproduce under the npm server's tool,
 *   and — when the release binary is built — under the crate's server too.
 *
 * Run: bun scripts/check-extraction-parity.ts   (IPS_LE_BIN=<path> for the binary)
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { extract } from '../src/extract';
import { TOOLS } from '../src/mcp/tools';

const ROOT = join(import.meta.dir, '..');
const CORPUS = join(ROOT, 'crate', 'fixtures');
const BINARY = process.env.UNITS_LE_BIN ?? join(ROOT, 'crate', 'target', 'release', 'units-le');
const document = (name: string) => readFileSync(join(CORPUS, 'documents', name), 'utf8');
const failures: string[] = [];
const expectEqual = (label: string, actual: unknown, expected: unknown) => {
	if (!isDeepStrictEqual(JSON.parse(JSON.stringify(actual ?? null)), expected ?? null)) {
		failures.push(`${label}\n  got:      ${JSON.stringify(actual ?? null).slice(0, 400)}\n  expected: ${JSON.stringify(expected ?? null).slice(0, 400)}`);
	}
};

const extraction = JSON.parse(readFileSync(join(CORPUS, 'extraction.json'), 'utf8'));
for (const d of extraction.documents) {
	const found = extract(document(d.file), d.fileType).map((one) => ({
		value: one.value,
		dimension: one.dimension,
		base: one.base,
		reason: one.reason ?? null,
		key: one.key ?? null,
	}));
	expectEqual(`document: ${d.name}`, found, d.expected);
}

const mcp = JSON.parse(readFileSync(join(CORPUS, 'mcp-extract-units.json'), 'utf8'));
const argumentsOf = (c: { file?: string; content?: string; arguments: Record<string, unknown> }) => ({
	...c.arguments,
	...(c.file ? { content: document(c.file) } : {}),
	...(c.content !== undefined ? { content: c.content } : {}),
});
const tool = TOOLS[0] as (typeof TOOLS)[number];
for (const c of mcp) {
	try {
		const answer = JSON.parse(JSON.stringify(await tool.handler(argumentsOf(c))));
		if (c.expectedError !== undefined) failures.push(`npm server answered "${c.name}", which the corpus refuses`);
		for (const [key, value] of Object.entries(c.expected ?? {})) expectEqual(`npm server: ${c.name} (${key})`, answer[key], value);
	} catch (error) {
		expectEqual(`npm server refusal: ${c.name}`, (error as Error).message, c.expectedError);
	}
}

let crateChecked = false;
if (existsSync(BINARY)) {
	crateChecked = true;
	const child = Bun.spawn([BINARY, 'mcp'], { stdin: 'pipe', stdout: 'pipe' });
	const out = new Response(child.stdout).text();
	child.stdin.write(
		`${mcp.map((c: never, id: number) => JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'extract_units', arguments: argumentsOf(c) } })).join('\n')}\n`,
	);
	child.stdin.end();
	for (const line of (await out).trim().split('\n')) {
		const response = JSON.parse(line);
		const c = mcp[response.id];
		if (response.result.isError) {
			expectEqual(`crate server refusal: ${c.name}`, response.result.content[0].text, c.expectedError);
			continue;
		}
		for (const [key, value] of Object.entries(c.expected ?? {})) {
			expectEqual(`crate server: ${c.name} (${key})`, response.result.structuredContent[key], value);
		}
	}
}

if (failures.length > 0) {
	console.error(`PARITY FAILED — ${failures.length} difference(s):\n`);
	for (const f of failures) console.error(`${f}\n`);
	process.exit(1);
}
console.log(
	`OK: every extraction.json case reproduces under the port, and every mcp-extract-units.json case under the npm server${crateChecked ? ' and the crate server' : ' (no binary built, so the crate server was not asked)'}.`,
);
