import type { Field } from './policy';

/**
 * The crate's `csv.rs`, over csv-core 0.1.13's state machine as csv 1.4.0
 * configures it: no headers, `flexible`, a `"` quote that doubles to escape,
 * no escape byte, no comment byte, and CR, LF or CRLF ending a record.
 *
 * Every special byte is ASCII, so walking UTF-16 units visits them exactly
 * where csv-core visits the bytes, and everything else is copied through.
 *
 * **It cannot fail on a string.** The csv crate's only errors on this
 * configuration are invalid UTF-8 in a field, and a field of a valid string
 * split at ASCII bytes is valid. So, like the crate, a document always reads:
 * an unterminated quote runs to the end of the input, and a stray quote mid
 * field is copied.
 *
 * A leading UTF-8 BOM is dropped, as csv-core drops one on its first read.
 */

type State =
	| 'startRecord'
	| 'startField'
	| 'inField'
	| 'inQuoted'
	| 'afterQuote';

export function rows(document: string, delimiter: string): string[][] {
	const text = document.startsWith('\ufeff') ? document.slice(1) : document;
	const records: string[][] = [];
	let record: string[] = [];
	let field = '';
	let state: State = 'startRecord';
	const endField = () => {
		record.push(field);
		field = '';
	};
	const endRecord = () => {
		endField();
		records.push(record);
		record = [];
		state = 'startRecord';
	};
	for (let index = 0; index < text.length; index++) {
		const character = text.charAt(index);
		const terminator = character === '\r' || character === '\n';
		if (state === 'startRecord') {
			if (terminator) continue;
			state = 'startField';
		}
		if (state === 'inQuoted') {
			if (character === '"') state = 'afterQuote';
			else field += character;
			continue;
		}
		if (state === 'afterQuote' && character === '"') {
			field += '"';
			state = 'inQuoted';
			continue;
		}
		if (state === 'startField' && character === '"') {
			state = 'inQuoted';
			continue;
		}
		if (character === delimiter) {
			endField();
			state = 'startField';
		} else if (terminator) {
			endRecord();
			// A CRLF pair ends one record, not two (a lone CR does too).
			if (character === '\r' && text.charAt(index + 1) === '\n') index++;
		} else {
			field += character;
			state = 'inField';
		}
	}
	if (state !== 'startRecord') endRecord();
	return records;
}

/** Every cell is data, and a cell has no key path: its row and column are in its position. */
export function extractCsv(text: string, delimiter: string): Field[] {
	return rows(text, delimiter).flatMap((row) =>
		row.map((text) => ({ key: null, text })),
	);
}

/** Never anything: see above. Kept so the dispatch names every reader, as the crate's does. */
export function csvParseError(
	_text: string,
	_delimiter: string,
): string | undefined {
	return undefined;
}
