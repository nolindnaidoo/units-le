/**
 * Records what the original crates make of a few thousand documents, so the
 * transcriptions beside this directory can be held to them.
 *
 * The documents are seeded: half built to be valid, half thrown together
 * from each format's syntax, which is where a parser's edges are. The Rust
 * program here reads them with the pinned crates and answers in one
 * canonical form; `parsers.test.ts` reproduces the form from the TypeScript
 * loaders and compares.
 *
 * Run from a repo carrying `src/parsers/`, with cargo and the crates cached:
 *   bun src/parsers/reference/generate.ts
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

type Case = { readonly format: string; readonly text: string };

let seed = 20261017;
const random = (n: number): number => {
	seed = (seed * 1103515245 + 12345) & 0x7fffffff;
	return seed % n;
};
const pick = <T>(items: readonly T[]): T => items[random(items.length)] as T;
const thrown = (pieces: readonly string[], most: number): string =>
	Array.from({ length: 1 + random(most) }, () => pick(pieces)).join('');

const PIECES: Record<string, readonly string[]> = {
	yaml: [
		'a',
		'b',
		':',
		': ',
		' ',
		'\n',
		'  ',
		'- ',
		'[',
		']',
		'{',
		'}',
		', ',
		'"x"',
		"'y'",
		'"\\u00e9\\t"',
		'1',
		'0x1F',
		'0o17',
		'1.5',
		'.inf',
		'-.nan',
		'+12',
		'1e3',
		'0.',
		'true',
		'null',
		'~',
		'&a ',
		'*a',
		'!foo ',
		'!!int ',
		'!!str ',
		'#c',
		'---\n',
		'...\n',
		'|\n  t\n',
		'>-\n  t\n',
		'\t',
		'? ',
		'é',
		'%YAML 1.2\n',
		'9223372036854775808',
		'\r\n',
	],
	toml: [
		'a',
		'b',
		' = ',
		'=',
		'\n',
		'[t]',
		'[[t]]',
		'[a.b]',
		'"s"',
		"'l'",
		'"""m\n"""',
		"'''r'''",
		'1',
		'+1',
		'-0',
		'1_000',
		'0x_ff',
		'0xff',
		'0o17',
		'0b101',
		'1.5',
		'1e3',
		'inf',
		'-nan',
		'true',
		'1979-05-27',
		'1979-05-27T07:32:00Z',
		'07:32',
		'[1, 2.5]',
		'{x = 1}',
		'{\n x = 1 }',
		'.',
		',',
		'#c',
		' ',
		'é',
		'9223372036854775808',
		'"\\u00e9"',
		'"\\e"',
		'"\\x41"',
		'\r\n',
		'\t',
	],
	json: [
		'{',
		'}',
		'[',
		']',
		',',
		':',
		'"a"',
		'"é"',
		'"\\u00e9"',
		'"\\ud83c\\udfaf"',
		'"\\ud83c"',
		'"\\x"',
		'1',
		'-0',
		'1.5e3',
		'01',
		'1.',
		'-',
		'1e',
		'true',
		'null',
		'nul',
		' ',
		'\n',
		'//c\n',
		'/*c*/',
		'/*c',
		"'s'",
		'+1',
		'0x1',
		'word',
		'"open',
		' ',
		' ',
	],
	ini: [
		'[s]',
		'[',
		']',
		'k',
		'key',
		' = ',
		'=',
		':',
		'\n',
		'\r\n',
		' ',
		';c',
		'#c',
		'"q"',
		"'q'",
		'v',
		'\\',
		'é',
		'\u0085',
		'\t',
		'[a.b]',
		'[ s ]',
	],
	csv: [
		'a',
		'b',
		',',
		'\t',
		'\n',
		'\r\n',
		'\r',
		'"',
		'""',
		' ',
		'é',
		'"x"',
		'"x',
		'x"',
		'﻿',
	],
};
// The constructs coverage found the plain pieces missing.
const MORE: Record<string, readonly string[]> = {
	yaml: [
		'|+\n  t\n\n',
		'>2\n   t\n',
		'{a: 1, b: [x, y]}',
		'? [k]\n: v\n',
		'"\\x41\\u263A\\N\\_"',
		"'it''s'",
		'multi\n  line',
		'v # c',
		'%TAG ! tag:x,1:\n---\n',
		'!<tag:yaml.org,2002:str> 5',
		'&c [1, 2]',
		'*c',
		'﻿',
		'- - x\n  - y\n',
		'"\\q"',
		'- ? a\n  : b\n',
		'!!float 1',
		'!!bool yes',
		'!!null ',
		'0b101',
		'1_000',
		'.NaN',
	],
	toml: [
		'1979-05-27T07:32:00.999-07:00',
		'1979-05-27 07:32:00',
		'07:32:00.5',
		'1979-05-27T25:00:00Z',
		'2024-02-30',
		'1979-05-27T07:32',
		'"\\t\\n\\\\\\"\\U0001F3AF"',
		'"\\z"',
		'"""a\\\n  b"""',
		'a b',
		'"" = 1',
		'a."b".c',
		'+inf',
		'1e+3',
		'1.0e-3',
		'0.1_0',
		'1__0',
		'_1',
		'0b2',
		'0o8',
		'[[a.b]]',
		'[a]\n[a]',
		'x = 1\nx = 2',
		'a = {b = 1}\na.c = 2',
		'[\n1,\n2,\n]',
		'{a = {b = [1, {c = 2}]}}',
	],
	json: [
		'"\\b\\f\\n\\r\\t\\/\\\\"',
		'"\\u00G0"',
		'"\\udc00"',
		'1E+2',
		'-0.0e-0',
		'00',
		'1.e3',
		'[[[[',
		']]]]',
		'{"a":{"b":{}}}',
	],
};
for (const [format, extra] of Object.entries(MORE)) {
	PIECES[format] = [...(PIECES[format] ?? []), ...extra];
}
PIECES.jsonc = PIECES.json as readonly string[];
PIECES.tsv = PIECES.csv as readonly string[];
PIECES.csvtrim = PIECES.csv as readonly string[];

const SCALARS = ['1', '-2.5', '"s"', '"é\\n"', 'true', 'null'];

function validJson(depth: number): string {
	if (depth > 2 || random(3) === 0) return pick(SCALARS);
	if (random(2) === 0)
		return `[${Array.from({ length: random(4) }, () => validJson(depth + 1)).join(', ')}]`;
	return `{${Array.from({ length: random(4) }, (_, at) => `"k${random(3)}${at}": ${validJson(depth + 1)}`).join(', ')}}`;
}

function validYaml(): string {
	const lines = Array.from({ length: 1 + random(5) }, (_, at) => {
		const value = pick([
			'0o17',
			'-.Inf',
			'.nan',
			'False',
			'null',
			'"q\\t\\u00e9"',
			"'s''t'",
			'!!int 8',
			'|\n  block\n',
			'>\n  folded\n  text\n',
			'&n 1',
			'\n  - a\n  - b',
			'1',
			'0x1F',
			'1.5',
			'.inf',
			'true',
			'~',
			'"q"',
			"'s'",
			'plain text',
			'[1, two]',
			'{a: 1}',
			'!!str 7',
			'!x y',
		]);
		return `${pick(['k', 'key', 'é'])}${at}: ${value}`;
	});
	return `${lines.join('\n')}\n${random(3) === 0 ? '---\nnext: 1\n' : ''}`;
}

function validToml(): string {
	const lines = Array.from({ length: 1 + random(5) }, (_, at) => {
		const value = pick([
			'0o17',
			'0b11',
			'"\\u00e9\\t"',
			'"""\nmulti\n"""',
			"'''raw'''",
			'1979-05-27T07:32:00Z',
			'1979-05-27T07:32:00.5+01:00',
			'07:32:00',
			'[[1], ["a"]]',
			'{x = {y = 1}}',
			'1',
			'1_000',
			'0xff',
			'1.5',
			'1e3',
			'-inf',
			'nan',
			'true',
			'"s"',
			"'l'",
			'1979-05-27',
			'[1, 2.5, "x"]',
			'{x = 1, y = "z"}',
		]);
		return `k${at} = ${value}`;
	});
	return `${lines.join('\n')}\n${random(2) === 0 ? '[t]\nx = 1\n[[arr]]\ny = 2\n' : ''}`;
}

function validIni(): string {
	const lines = Array.from({ length: 1 + random(5) }, (_, at) =>
		random(4) === 0
			? `[s${at}]`
			: `k${at} ${pick(['=', ':'])} ${pick(['1', 'v', '"q"', ' padded ', 'a=b'])}`,
	);
	return `${lines.join('\n')}\n`;
}

function validCsv(delimiter: string): string {
	return Array.from({ length: 1 + random(4) }, () =>
		Array.from({ length: 1 + random(4) }, () =>
			pick(['a', '1', '"q,x"', '"q""d"', '', ' s ']),
		).join(delimiter),
	).join(pick(['\n', '\r\n']));
}

const CURATED: Case[] = [
	{ format: 'json', text: '' },
	{ format: 'json', text: '{"a": 1, "a": 2}' },
	{ format: 'json', text: '{"a": 1,}' },
	{ format: 'jsonc', text: '{\n  // c\n  "a": 1,,\n}' },
	{ format: 'jsonc', text: '/* \u{1F3AF} */ {"a": 1}' },
	{ format: 'yaml', text: 'a: [1\n' },
	{ format: 'yaml', text: 'a: b: c\n' },
	{ format: 'yaml', text: '\t- x\n' },
	{ format: 'yaml', text: 'a: &x 1\nb: *x\na: 2\n' },
	{ format: 'yaml', text: '%YAML 1.2' },
	{ format: 'toml', text: '[a\nb = 1\n' },
	{ format: 'toml', text: 'a = \n' },
	{ format: 'toml', text: 'a = 9223372036854775808\n' },
	{ format: 'toml', text: 'a = 1e400\n' },
	{ format: 'toml', text: 'a.b = 1\n[a]\nc = 2\n' },
	{ format: 'ini', text: '[a\nb=1\n' },
	{ format: 'ini', text: 'rate = \u008542\nbare\n' },
	{ format: 'csv', text: 'a,b\n"1,2\n' },
	{ format: 'csvtrim', text: ' "1" , 2 \n3,"4"x\n' },
	{ format: 'csvtrim', text: 'a,b\n"1,2\n' },
	{ format: 'tsv', text: 'a\tb\n"x\n' },
];

function cases(): Case[] {
	const out = [...CURATED];
	const valid: Record<string, () => string> = {
		json: () => validJson(0),
		jsonc: () => `// c\n${validJson(0)}`,
		yaml: validYaml,
		toml: validToml,
		ini: validIni,
		csv: () => validCsv(','),
		tsv: () => validCsv('\t'),
		csvtrim: () => validCsv(','),
	};
	for (const format of Object.keys(PIECES)) {
		for (let at = 0; at < 600; at++) {
			const text =
				at % 2 === 0
					? (valid[format] as () => string)()
					: thrown(PIECES[format] as readonly string[], 12);
			out.push({ format, text });
		}
	}
	return out;
}

const all = cases();
const manifest = join(import.meta.dirname, 'Cargo.toml');
const run = spawnSync(
	'cargo',
	['run', '--quiet', '--release', '--offline', '--manifest-path', manifest],
	{
		input: JSON.stringify(all),
		maxBuffer: 1 << 28,
		env: {
			...process.env,
			CARGO_TARGET_DIR: mkdtempSync(join(tmpdir(), 'parsers-reference-')),
		},
	},
);
if (run.status !== 0) throw new Error(run.stderr.toString());
const answers = JSON.parse(run.stdout.toString()) as unknown[];
writeFileSync(
	join(import.meta.dirname, 'answers.json'),
	`${JSON.stringify(all.map((one, at) => ({ ...one, answer: answers[at] })))}\n`,
);
console.log(`recorded ${all.length} documents`);
