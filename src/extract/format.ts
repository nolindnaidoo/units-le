import { trim } from './text';

/** The crate's `format.rs`: which reader a document goes to. An unresolved format is scanned as text. */

export type Format =
	| 'json'
	| 'jsonc'
	| 'yaml'
	| 'csv'
	| 'tsv'
	| 'toml'
	| 'ini'
	| 'env'
	| 'unknown';

export const SUPPORTED_FORMATS: readonly Format[] = [
	'json',
	'jsonc',
	'yaml',
	'csv',
	'tsv',
	'toml',
	'ini',
	'env',
];

const ALIASES: ReadonlyArray<readonly [string, Format]> = [
	['json', 'json'],
	['jsonc', 'jsonc'],
	['yaml', 'yaml'],
	['yml', 'yaml'],
	['csv', 'csv'],
	['tsv', 'tsv'],
	['toml', 'toml'],
	['ini', 'ini'],
	['properties', 'ini'],
	['env', 'env'],
	['dotenv', 'env'],
	['editorconfig', 'ini'],
	['prometheus', 'yaml'],
];

const normalise = (value: string): string =>
	trim(value).toLowerCase().replace(/^\.+/, '');

const canonical = (format: string): Format =>
	ALIASES.find(([alias]) => alias === format)?.[1] ?? 'unknown';

/** From an explicit format, else a filename, else the fallback. */
export function resolveFormat(
	format: string | undefined,
	filename: string | undefined,
): Format {
	if (format !== undefined) {
		const direct = canonical(normalise(format));
		if (direct !== 'unknown') return direct;
	}
	if (filename === undefined) return 'unknown';
	const whole = canonical(normalise(filename));
	if (whole !== 'unknown') return whole;
	const dot = filename.lastIndexOf('.');
	return dot === -1 ? 'unknown' : canonical(normalise(filename.slice(dot + 1)));
}
