/**
 * Rust's `char` and `str` predicates, which the crate's grammar and readers
 * are written in. JavaScript's `\s` and `trim()` are a different whitespace
 * set, so every one of these goes through the Unicode property instead.
 */

const WHITE_SPACE = /^\p{White_Space}$/u;
const ALPHABETIC = /^\p{Alphabetic}$/u;
const ALPHANUMERIC = /^[\p{Alphabetic}\p{N}]$/u;
const LEADING = /^\p{White_Space}+/u;
const TRAILING = /\p{White_Space}+$/u;

/** `char::is_whitespace`, for one code point. */
export const isWhitespace = (character: string): boolean =>
	WHITE_SPACE.test(character);
/** `char::is_alphabetic`. */
export const isAlphabetic = (character: string): boolean =>
	ALPHABETIC.test(character);
/** `char::is_alphanumeric`: Alphabetic, or a general category of N. */
export const isAlphanumeric = (character: string): boolean =>
	ALPHANUMERIC.test(character);
export const isAsciiDigit = (character: string | undefined): boolean =>
	character !== undefined && character >= '0' && character <= '9';

/** `str::trim`. */
export const trim = (text: string): string =>
	text.replace(LEADING, '').replace(TRAILING, '');
export const trimStart = (text: string): string => text.replace(LEADING, '');
export const trimEnd = (text: string): string => text.replace(TRAILING, '');

/** `str::lines`: split on `\n`, drop one trailing `\r` per line, and no empty last line. */
export function lines(text: string): string[] {
	if (text === '') return [];
	const out = text.split('\n');
	if (out.at(-1) === '') out.pop();
	return out.map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line));
}

/** The code point starting at a UTF-16 index, or undefined at the end. */
export function charAt(text: string, index: number): string | undefined {
	const code = text.codePointAt(index);
	return code === undefined ? undefined : String.fromCodePoint(code);
}

/** The code point ending just before a UTF-16 index, or undefined at the start. */
export function charBefore(text: string, index: number): string | undefined {
	if (index <= 0) return undefined;
	const low = text.charCodeAt(index - 1);
	if (low >= 0xdc00 && low <= 0xdfff && index >= 2) {
		const high = text.charCodeAt(index - 2);
		if (high >= 0xd800 && high <= 0xdbff) return text.slice(index - 2, index);
	}
	return text.charAt(index - 1);
}
