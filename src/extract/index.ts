import { csvParseError, extractCsv } from './csv';
import { extractDotenv } from './dotenv';
import { scan } from './fallback';
import type { Format } from './format';
import { type Dimension, readValue } from './grammar';
import { extractIni, iniParseError } from './ini';
import { extractJson, jsonParseError } from './json';
import { type Found, type Harvest, locate } from './locate';
import type { Field } from './policy';
import { extractToml, tomlParseError } from './toml';
import { extractYaml, yamlParseError } from './yaml';

export type { Format } from './format';
export { resolveFormat, SUPPORTED_FORMATS } from './format';
export type { Dimension, Quantity, Reason } from './grammar';
export { DIMENSIONS } from './grammar';
export type { Found } from './locate';

/**
 * The crate's `extract/mod.rs`: every quantity in a document, in document
 * order, with its key path and its position. A refusal that names no
 * dimension survives every filter — it could have been the one asked for.
 */
export function extract(
	text: string,
	format: Format,
	dimension?: Dimension,
): Found[] {
	const found = locate(text, harvest(text, format));
	if (dimension === undefined) return found;
	return found.filter(
		(one) => one.dimension === null || one.dimension === dimension,
	);
}

function fields(text: string, format: Exclude<Format, 'unknown'>): Field[] {
	switch (format) {
		case 'json':
			return extractJson(text, false);
		case 'jsonc':
			return extractJson(text, true);
		case 'yaml':
			return extractYaml(text);
		case 'toml':
			return extractToml(text);
		case 'ini':
			return extractIni(text);
		case 'env':
			return extractDotenv(text);
		case 'csv':
			return extractCsv(text, ',');
		case 'tsv':
			return extractCsv(text, '\t');
	}
}

function harvest(text: string, format: Format): Harvest {
	if (format === 'unknown') return { kind: 'runs', runs: scan(text) };
	return {
		kind: 'fields',
		fields: fields(text, format).flatMap((field) => {
			const quantity = readValue(field.text);
			return quantity === undefined ? [] : [[quantity, field.key] as const];
		}),
	};
}

/** Why a document yielded nothing, when the reason is a parse failure. */
export function parseError(text: string, format: Format): string | undefined {
	switch (format) {
		case 'json':
			return jsonParseError(text, false);
		case 'jsonc':
			return jsonParseError(text, true);
		case 'yaml':
			return yamlParseError(text);
		case 'toml':
			return tomlParseError(text);
		case 'ini':
			return iniParseError(text);
		case 'csv':
			return csvParseError(text, ',');
		case 'tsv':
			return csvParseError(text, '\t');
		case 'env':
		case 'unknown':
			return undefined;
	}
}
