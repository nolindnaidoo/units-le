import type { Field } from './policy';
import { lines, trim } from './text';

/** The crate's `dotenv.rs`: `.env`, line by line — the one format with no library. */
export function extractDotenv(text: string): Field[] {
	return lines(text).flatMap((line) => {
		const field = fieldOf(line);
		return field === undefined ? [] : [field];
	});
}

function fieldOf(rawLine: string): Field | undefined {
	const line = trim(rawLine);
	if (line === '' || line.startsWith('#')) return undefined;
	const content = line.startsWith('export ')
		? trim(line.slice('export '.length))
		: line;
	const equals = content.indexOf('=');
	if (equals === -1) return undefined;
	return {
		key: trim(content.slice(0, equals)),
		text: unquote(stripInlineComment(trim(content.slice(equals + 1)))),
	};
}

/** A `#` inside a quoted value is part of the value. */
function stripInlineComment(value: string): string {
	if (value.startsWith('"') || value.startsWith("'")) return value;
	const hash = value.indexOf('#');
	return hash === -1 ? value : trim(value.slice(0, hash));
}

function unquote(value: string): string {
	for (const quote of ['"', "'"]) {
		if (value.length > 1 && value.startsWith(quote) && value.endsWith(quote))
			return value.slice(1, -1);
	}
	return value;
}
