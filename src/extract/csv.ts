import { csvRows } from '../parsers/csv';
import type { Field } from './policy';

/** units-le's reading of a CSV file: every cell, with no key. */
export function extractCsv(text: string, delimiter: string): Field[] {
	return csvRows(text, delimiter).flatMap((row) =>
		row.map((text) => ({ key: null, text })),
	);
}

/** The csv crate, flexible and without `trim_around_quotes`, refuses nothing. */
export function csvParseError(
	_text: string,
	_delimiter: string,
): string | undefined {
	return undefined;
}
