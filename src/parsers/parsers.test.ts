/**
 * The transcriptions held to the originals: every document in
 * `reference/answers.json` read by each TypeScript loader and compared,
 * error text included, with what the pinned crate made of it.
 * `reference/generate.ts` records the answers.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { csvRows, trimAroundQuotes } from './csv';
import { loadIni } from './ini';
import { JsoncError, type JsonValue, parseJsonc } from './jsonc';
import { loadToml, type TomlValue } from './toml/load';
import { loadYaml, type YamlNode } from './yaml/load';

type Recorded = {
	readonly format: string;
	readonly text: string;
	readonly answer: unknown;
};

const recorded: Recorded[] = JSON.parse(
	readFileSync(join(import.meta.dirname, 'reference', 'answers.json'), 'utf8'),
);

const bits = (value: number): string => {
	const view = new DataView(new ArrayBuffer(8));
	view.setFloat64(0, value);
	return view.getBigUint64(0).toString(16).padStart(16, '0');
};

function yaml(node: YamlNode): unknown {
	switch (node.k) {
		case 'null':
			return ['n'];
		case 'bool':
			return ['b', node.v];
		case 'int':
			return ['i', node.v.toString()];
		case 'float':
			return ['f', bits(node.v)];
		case 'str':
			return ['s', node.v];
		case 'seq':
			return ['q', node.items.map(yaml)];
		case 'map':
			return [
				'm',
				[...node.entries.values()].map(({ key, value }) => [
					yaml(key),
					yaml(value),
				]),
			];
		case 'tagged':
			return ['t', node.tag.handle, node.tag.suffix, yaml(node.node)];
		case 'bad':
			return ['x'];
	}
}

function toml(value: TomlValue): unknown {
	switch (value.type) {
		case 'string':
			return ['s', value.text];
		case 'integer':
			return ['i', value.value.toString()];
		case 'float':
			return ['f', bits(value.value)];
		case 'boolean':
			return ['b', value.value];
		case 'datetime':
			return ['d'];
		case 'array':
			return ['q', value.items.map(toml)];
		case 'table':
			return ['m', value.entries.map(([key, item]) => [key, toml(item)])];
	}
}

function json(node: JsonValue): unknown {
	switch (node.type) {
		case 'string':
			return ['s', node.value, node.start];
		case 'number':
			return ['n', node.text, node.start];
		case 'array':
			return ['q', node.elements.map(json)];
		case 'object':
			return ['m', node.properties.map((p) => [p.name, json(p.value)])];
		case 'other':
			return ['o'];
	}
}

const outcome = <T>(value: T | string, form: (ok: T) => unknown) =>
	typeof value === 'string' ? { error: value } : { ok: form(value) };

function answer(format: string, text: string): unknown {
	switch (format) {
		case 'yaml':
			return outcome(loadYaml(text), (docs) => docs.map(yaml));
		case 'toml':
			return outcome(loadToml(text), toml);
		case 'json':
		case 'jsonc':
			try {
				const root = parseJsonc(text, format === 'jsonc');
				return { ok: root === undefined ? null : json(root) };
			} catch (error) {
				if (error instanceof JsoncError) return { error: error.message };
				throw error;
			}
		case 'ini':
			return outcome(loadIni(text), (sections) =>
				sections.map((section) => [section.name, section.properties]),
			);
		case 'csv':
			return { ok: csvRows(text, ',') };
		case 'tsv':
			return { ok: csvRows(text, '\t') };
		case 'csvtrim': {
			const trimmed = trimAroundQuotes(text);
			return trimmed === undefined
				? { error: 'Failed to parse CSV: quoted field is never closed' }
				: { ok: csvRows(trimmed, ',') };
		}
		default:
			throw new Error(`no format ${format}`);
	}
}

describe('the transcribed parsers', () => {
	it('records documents of every format', () => {
		const formats = new Set(recorded.map((one) => one.format));
		expect([...formats].sort()).toEqual([
			'csv',
			'csvtrim',
			'ini',
			'json',
			'jsonc',
			'toml',
			'tsv',
			'yaml',
		]);
	});

	for (const format of [
		'yaml',
		'toml',
		'json',
		'jsonc',
		'ini',
		'csv',
		'tsv',
		'csvtrim',
	]) {
		it(`answers as the crate does for every recorded ${format} document`, () => {
			const wrong = recorded
				.filter((one) => one.format === format)
				.filter(
					(one) =>
						JSON.stringify(answer(format, one.text)) !==
						JSON.stringify(one.answer),
				)
				.map((one) => ({
					text: one.text,
					crate: one.answer,
					ours: answer(format, one.text),
				}));
			expect(wrong.slice(0, 3)).toEqual([]);
		});
	}
});
