import { loadToml, type TomlValue } from '../parsers/toml/load';
import { collect, type Field, OTHER, type Value } from './policy';

/** units-le's reading of the TOML tree: string leaves, and key paths. */
function convert(value: TomlValue): Value {
	if (value.type === 'string') return { type: 'text', text: value.text };
	if (value.type === 'array')
		return { type: 'seq', items: value.items.map(convert) };
	if (value.type === 'table')
		return {
			type: 'map',
			entries: value.entries.map(
				([key, item]) => [key, convert(item)] as const,
			),
		};
	return OTHER;
}

export function extractToml(text: string): Field[] {
	const value = loadToml(text);
	return typeof value === 'string' ? [] : collect(convert(value));
}

export function tomlParseError(text: string): string | undefined {
	const value = loadToml(text);
	return typeof value === 'string'
		? `Failed to parse TOML: ${value}`
		: undefined;
}
