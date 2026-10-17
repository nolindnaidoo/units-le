import { loadIni } from '../parsers/ini';
import type { Field } from './policy';

/** units-le's reading of an INI file: every value, keyed `section.key`. */
export function extractIni(text: string): Field[] {
	const sections = loadIni(text);
	if (typeof sections === 'string') return [];
	return sections.flatMap((section) =>
		section.properties.map(([key, text]) => ({
			key: section.name === null ? key : `${section.name}.${key}`,
			text,
		})),
	);
}

export function iniParseError(text: string): string | undefined {
	const sections = loadIni(text);
	return typeof sections === 'string'
		? `Failed to parse INI: ${sections}`
		: undefined;
}
