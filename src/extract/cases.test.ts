import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { csvParseError, extractCsv } from './csv';
import { readValue } from './grammar';
import { extractIni, iniParseError } from './ini';
import { extractJson, jsonParseError } from './json';
import type { Field } from './policy';
import { extractToml, tomlParseError } from './toml';
import { extractYaml, yamlParseError } from './yaml';

/**
 * Two tables of answers read back from the crates, one row per case: what
 * each reader returns for a document — every string field with its key path,
 * and the parser's error text — and what the grammar makes of one token. They
 * pin the paths a corpus written for the CLI does not visit.
 */
const load = (name: string) =>
	JSON.parse(readFileSync(join(__dirname, '__fixtures__', name), 'utf8'));

const READERS: Record<
	string,
	[(text: string) => Field[], (text: string) => string | undefined]
> = {
	json: [(t) => extractJson(t, false), (t) => jsonParseError(t, false)],
	jsonc: [(t) => extractJson(t, true), (t) => jsonParseError(t, true)],
	yaml: [extractYaml, yamlParseError],
	toml: [extractToml, tomlParseError],
	ini: [extractIni, iniParseError],
	csv: [(t) => extractCsv(t, ','), (t) => csvParseError(t, ',')],
	tsv: [(t) => extractCsv(t, '\t'), (t) => csvParseError(t, '\t')],
};

describe('reader cases, from the crates', () => {
	const cases = load('reader-cases.json').cases as Array<{
		format: string;
		document: string;
		fields: Array<[string | null, string]>;
		error: string | null;
	}>;
	for (const [index, c] of cases.entries()) {
		it(`${c.format} #${index}: ${JSON.stringify(c.document).slice(0, 60)}`, () => {
			const [fields, error] = READERS[c.format] as (typeof READERS)[string];
			expect(fields(c.document).map((f) => [f.key, f.text])).toEqual(c.fields);
			expect(error(c.document) ?? null).toBe(c.error);
		});
	}
});

describe('grammar cases, from the crate', () => {
	const cases = load('grammar-cases.json').cases as Array<{
		token: string;
		quantity: {
			dimension: string | null;
			base: string | null;
			reason: string | null;
		} | null;
	}>;
	for (const c of cases) {
		it(JSON.stringify(c.token), () => {
			const quantity = readValue(c.token);
			expect(
				quantity === undefined
					? null
					: {
							dimension: quantity.dimension,
							base: quantity.base,
							reason: quantity.reason ?? null,
						},
			).toEqual(c.quantity);
		});
	}
});

describe('a YAML directive that runs off the end of the input', () => {
	it('is refused by name, as the crate refuses it, and a directive with its line break still reads', () => {
		for (const text of ['%YAML', 'a: 1\n%TAG', '%a: 1', '%FOO bar']) {
			expect(extractYaml(text)).toEqual([]);
			expect(yamlParseError(text)).toBe(
				'Failed to parse YAML: a directive runs to the end of the input with no line break after it',
			);
		}
		expect(extractYaml('%YAML 1.2\n---\na: 30s\n').map((f) => f.text)).toEqual([
			'30s',
		]);
	});
});
