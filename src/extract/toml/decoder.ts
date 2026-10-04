import { described, type Expected, literal, report, span } from './errors';
import type { Encoding } from './parser';

/**
 * toml_parser 1.1.3's `decoder/string.rs` and `decoder/scalar.rs`, over the
 * bytes of one key or value. Decoded text is collected as bytes and turned
 * into a string once. Positions inside a raw value are rebased onto the
 * document, as `Raw::decode_*` rebases them.
 */

export type ScalarKind =
	| { readonly kind: 'string' }
	| { readonly kind: 'boolean' }
	| { readonly kind: 'datetime' }
	| { readonly kind: 'float' }
	| { readonly kind: 'integer'; readonly radix: 2 | 8 | 10 | 16 };

const utf8 = new TextDecoder('utf-8', { ignoreBOM: true });

class Raw {
	readonly out: number[] = [];

	constructor(
		readonly bytes: Uint8Array,
		/** Where this value starts in the document. */
		readonly base: number,
	) {}

	get length(): number {
		return this.bytes.length;
	}

	fail(
		description: string,
		expected: readonly Expected[] | undefined,
		start: number,
		end = start,
	): never {
		report(description, expected, span(this.base + start, this.base + end));
	}

	pushRange(start: number, end: number): void {
		for (let i = start; i < end; i++) this.out.push(this.bytes[i] as number);
	}

	pushChar(code: number): void {
		const text = new TextEncoder().encode(String.fromCodePoint(code));
		for (const b of text) this.out.push(b);
	}

	text(): string {
		return utf8.decode(new Uint8Array(this.out));
	}
}

const isLiteralChar = (b: number) =>
	b === 0x09 ||
	(b >= 0x20 && b <= 0x26) ||
	(b >= 0x28 && b <= 0x7e) ||
	b >= 0x80;
const isBasicUnescaped = (b: number) =>
	b === 0x20 ||
	b === 0x09 ||
	b === 0x21 ||
	(b >= 0x23 && b <= 0x5b) ||
	(b >= 0x5d && b <= 0x7e) ||
	b >= 0x80;
const isHex = (b: number) =>
	(b >= 0x30 && b <= 0x39) ||
	(b >= 0x41 && b <= 0x46) ||
	(b >= 0x61 && b <= 0x66);
const isDigit = (b: number | undefined) =>
	b !== undefined && b >= 0x30 && b <= 0x39;

const startsWithBytes = (bytes: Uint8Array, at: number, text: string) => {
	for (let i = 0; i < text.length; i++)
		if (bytes[at + i] !== text.charCodeAt(i)) return false;
	return true;
};

/** Leading `\n` or `\r\n` after a multi-line opener. */
function stripStartNewline(raw: Raw, from: number): number {
	if (raw.bytes[from] === 0x0a) return from + 1;
	if (raw.bytes[from] === 0x0d && raw.bytes[from + 1] === 0x0a) return from + 2;
	return from;
}

function literalString(raw: Raw): void {
	const INVALID = 'invalid literal string';
	let start = 0;
	let end = raw.length;
	if (raw.bytes[0] === 0x27) start = 1;
	else raw.fail(INVALID, [literal("'")], 0);
	if (end > start && raw.bytes[end - 1] === 0x27) end--;
	else raw.fail(INVALID, [literal("'")], raw.length);
	for (let i = start; i < end; i++) {
		if (!isLiteralChar(raw.bytes[i] as number))
			raw.fail(INVALID, [described('non-single-quote visible characters')], i);
	}
	raw.pushRange(start, end);
}

function mlLiteralString(raw: Raw): void {
	const INVALID = 'invalid multi-line literal string';
	let start = 0;
	if (startsWithBytes(raw.bytes, 0, "'''")) start = 3;
	else raw.fail(INVALID, [literal("'")], 0);
	start = stripStartNewline(raw, start);
	let end = raw.length;
	if (end - start >= 3 && startsWithBytes(raw.bytes, end - 3, "'''")) end -= 3;
	else raw.fail(INVALID, [literal("'")], raw.length);
	for (let i = start; i < end; i++) {
		const b = raw.bytes[i] as number;
		if (b === 0x27 || b === 0x0a) continue;
		if (b === 0x0d) {
			if (raw.bytes[i + 1] !== 0x0a || i + 1 >= end)
				raw.fail(
					'carriage return must be followed by newline',
					[literal('\n')],
					i + 1,
				);
		} else if (!isLiteralChar(b)) {
			raw.fail(INVALID, [described('non-single-quote characters')], i);
		}
	}
	raw.pushRange(start, end);
}

const EXPECTED_ESCAPES = [
	'b',
	'e',
	'f',
	'n',
	'r',
	'\\',
	'"',
	'x',
	'u',
	'U',
].map(literal);

/** After a backslash, at `at`: the escaped character and where reading resumes. */
function escapeSeqChar(raw: Raw, at: number, end: number): [number, number] {
	if (at >= end) raw.fail('missing escaped value', EXPECTED_ESCAPES, at);
	const id = raw.bytes[at] as number;
	const simple: Record<number, number> = {
		98: 0x08,
		101: 0x1b,
		102: 0x0c,
		110: 0x0a,
		114: 0x0d,
		116: 0x09,
		92: 0x5c,
		34: 0x22,
	};
	if (simple[id] !== undefined) return [simple[id] as number, at + 1];
	const digits = id === 0x78 ? 2 : id === 0x75 ? 4 : id === 0x55 ? 8 : 0;
	if (digits === 0) raw.fail('missing escaped value', EXPECTED_ESCAPES, at);
	let i = at + 1;
	while (i < end && i - (at + 1) < digits && isHex(raw.bytes[i] as number)) i++;
	if (i - (at + 1) !== digits)
		raw.fail(
			'too few unicode value digits',
			[described('unicode hexadecimal value')],
			i,
		);
	const value = Number.parseInt(
		String.fromCharCode(...raw.bytes.subarray(at + 1, i)),
		16,
	);
	if (value > 0x10ffff || (value >= 0xd800 && value <= 0xdfff)) {
		raw.fail('invalid value', [described('unicode hexadecimal value')], at + 1);
	}
	return [value, i];
}

function basicString(raw: Raw): void {
	const INVALID = 'invalid basic string';
	let start = 0;
	let end = raw.length;
	if (raw.bytes[0] === 0x22) start = 1;
	else raw.fail(INVALID, [literal('"')], 0);
	if (end > start && raw.bytes[end - 1] === 0x22) end--;
	else raw.fail(INVALID, [literal('"')], raw.length);
	let at = start;
	while (at < end) {
		const b = raw.bytes[at] as number;
		if (isBasicUnescaped(b)) {
			raw.out.push(b);
			at++;
		} else if (b === 0x5c) {
			const [code, next] = escapeSeqChar(raw, at + 1, end);
			raw.pushChar(code);
			at = next;
		} else {
			let stop = at;
			while (
				stop < end &&
				!(
					isBasicUnescaped(raw.bytes[stop] as number) ||
					raw.bytes[stop] === 0x5c
				)
			)
				stop++;
			raw.fail(
				INVALID,
				[described('non-double-quote visible characters'), literal('\\')],
				at,
				stop,
			);
		}
	}
}

function mlBasicString(raw: Raw): void {
	const INVALID = 'invalid multi-line basic string';
	let start = 0;
	if (startsWithBytes(raw.bytes, 0, '"""')) start = 3;
	else raw.fail(INVALID, [literal('"')], 0);
	start = stripStartNewline(raw, start);
	let end = raw.length;
	if (end - start >= 3 && startsWithBytes(raw.bytes, end - 3, '"""')) end -= 3;
	else raw.fail(INVALID, [literal('"')], raw.length);
	const unescaped = (b: number) =>
		isBasicUnescaped(b) || b === 0x22 || b === 0x0a;
	let at = start;
	while (at < end) {
		const b = raw.bytes[at] as number;
		if (unescaped(b)) {
			raw.out.push(b);
			at++;
		} else if (b === 0x5c) {
			at++;
			const next = raw.bytes[at];
			if (
				at < end &&
				(next === 0x20 || next === 0x09 || next === 0x0d || next === 0x0a)
			) {
				at = escapedNewline(raw, at, end);
			} else {
				const [code, resume] = escapeSeqChar(raw, at, end);
				raw.pushChar(code);
				at = resume;
			}
		} else if (b === 0x0d) {
			if (at + 1 < end && raw.bytes[at + 1] === 0x0a) {
				raw.pushRange(at, at + 2);
				at += 2;
			} else {
				raw.fail(
					'carriage return must be followed by newline',
					[literal('\n')],
					at + 1,
				);
			}
		} else {
			let stop = at;
			while (
				stop < end &&
				!(
					unescaped(raw.bytes[stop] as number) ||
					raw.bytes[stop] === 0x5c ||
					raw.bytes[stop] === 0x0d
				)
			)
				stop++;
			raw.fail(INVALID, [literal('\\'), described('characters')], at, stop);
		}
	}
}

/** `mlb_escaped_nl`: a line-ending backslash swallows the newline and every blank after it. */
function escapedNewline(raw: Raw, from: number, end: number): number {
	let at = from;
	while (at < end && (raw.bytes[at] === 0x20 || raw.bytes[at] === 0x09)) at++;
	const b = at < end ? raw.bytes[at] : undefined;
	if (b === 0x0a) {
		at++;
	} else if (b === 0x0d) {
		at++;
		if (at < end && raw.bytes[at] === 0x0a) at++;
		else
			raw.fail(
				'carriage return must be followed by newline',
				[literal('\n')],
				at,
			);
	} else {
		raw.fail('invalid multi-line basic string', [literal('\n')], at);
	}
	for (;;) {
		const startOffset = at;
		while (
			at < end &&
			(raw.bytes[at] === 0x20 ||
				raw.bytes[at] === 0x09 ||
				raw.bytes[at] === 0x0a)
		)
			at++;
		if (at < end && raw.bytes[at] === 0x0d) {
			if (at + 1 < end && raw.bytes[at + 1] === 0x0a) at += 2;
			else
				raw.fail(
					'carriage return must be followed by newline',
					[literal('\n')],
					at + 1,
				);
		}
		if (startOffset === at) break;
	}
	return at;
}

const KEY_EXPECTED = [
	described('letters'),
	described('numbers'),
	literal('-'),
	literal('_'),
];
const isUnquoted = (b: number) =>
	(b >= 0x41 && b <= 0x5a) ||
	(b >= 0x61 && b <= 0x7a) ||
	isDigit(b) ||
	b === 0x2d ||
	b === 0x5f;

function unquotedKey(raw: Raw): void {
	if (raw.length === 0)
		raw.fail('unquoted keys cannot be empty', KEY_EXPECTED, 0, 0);
	// The first run of invalid bytes is the first one reported.
	for (let i = 0; i < raw.length; i++) {
		if (isUnquoted(raw.bytes[i] as number)) continue;
		let end = i + 1;
		while (end < raw.length && !isUnquoted(raw.bytes[end] as number)) end++;
		raw.fail('invalid unquoted key', KEY_EXPECTED, i, end);
	}
	raw.pushRange(0, raw.length);
}

function decodeString(raw: Raw, encoding: Encoding): void {
	if (encoding === 'literal') literalString(raw);
	else if (encoding === 'basic') basicString(raw);
	else if (encoding === 'mlLiteral') mlLiteralString(raw);
	else mlBasicString(raw);
}

/** `Raw::decode_key`. */
export function decodeKey(
	bytes: Uint8Array,
	base: number,
	encoding: Encoding | undefined,
): string {
	const raw = new Raw(bytes, base);
	if (encoding === 'mlLiteral' || encoding === 'mlBasic') {
		const what =
			encoding === 'mlLiteral'
				? 'keys cannot be multi-line literal strings'
				: 'keys cannot be multi-line basic strings';
		raw.fail(
			what,
			[described('basic string'), described('literal string')],
			0,
			raw.length,
		);
	}
	if (encoding === undefined) unquotedKey(raw);
	else decodeString(raw, encoding);
	return raw.text();
}

/** `Raw::decode_scalar`: the decoded text and what kind of value it is. */
export function decodeScalar(
	bytes: Uint8Array,
	base: number,
	encoding: Encoding | undefined,
): [string, ScalarKind] {
	const raw = new Raw(bytes, base);
	if (encoding !== undefined) {
		decodeString(raw, encoding);
		return [raw.text(), { kind: 'string' }];
	}
	const kind = new Scalar(raw).decode();
	return [raw.text(), kind];
}

const INTEGER: Record<
	2 | 8 | 10 | 16,
	{ description: string; valid: (b: number) => boolean }
> = {
	10: { description: 'invalid integer number', valid: (b) => isDigit(b) },
	16: { description: 'invalid hexadecimal number', valid: isHex },
	8: {
		description: 'invalid octal number',
		valid: (b) => b >= 0x30 && b <= 0x37,
	},
	2: {
		description: 'invalid binary number',
		valid: (b) => b === 0x30 || b === 0x31,
	},
};

const contains = (bytes: Uint8Array, from: number, b: number) =>
	bytes.subarray(from).includes(b);

/** `decode_unquoted_scalar` and its helpers, with offsets into the raw value. */
class Scalar {
	constructor(private readonly raw: Raw) {}

	private get bytes(): Uint8Array {
		return this.raw.bytes;
	}

	decode(): ScalarKind {
		const bytes = this.bytes;
		const first = bytes[0];
		if (first === undefined) return this.invalid();
		if (!isDigit(first) && contains(bytes, 0, 0x20)) return this.invalid();
		switch (first) {
			case 0x2b:
			case 0x2d:
				return this.signPrefix(1);
			case 0x5f:
				return this.datetimeOrNumber(0);
			case 0x30:
				return this.zeroPrefix(0, false);
			case 0x2e:
				return this.ensureFloat(0)
					? this.floatOrInteger(0, { kind: 'float' })
					: { kind: 'float' };
			case 0x74:
			case 0x54:
				return this.symbol('true', { kind: 'boolean' });
			case 0x66:
			case 0x46:
				return this.symbol('false', { kind: 'boolean' });
			case 0x69:
			case 0x49:
				return this.symbol('inf', { kind: 'float' });
			case 0x6e:
			case 0x4e:
				return this.symbol('nan', { kind: 'float' });
			default:
				return isDigit(first) ? this.datetimeOrNumber(0) : this.invalid();
		}
	}

	private signPrefix(from: number): ScalarKind {
		const at = from;
		for (;;) {
			const b = this.bytes[at];
			if (b === undefined) return this.invalid();
			if (b !== 0x2b && b !== 0x2d) break;
			this.raw.fail('redundant numeric sign', [], at, at + 1);
		}
		const first = this.bytes[at] as number;
		if (first === 0x5f || (first >= 0x31 && first <= 0x39))
			return this.datetimeOrNumber(at);
		if (first === 0x30) return this.zeroPrefix(at, true);
		if (first === 0x2e)
			return this.ensureFloat(0)
				? this.floatOrInteger(0, { kind: 'float' })
				: { kind: 'float' };
		if (first === 0x69 || first === 0x49 || first === 0x6e || first === 0x4e) {
			const symbol = first === 0x69 || first === 0x49 ? 'inf' : 'nan';
			const value = utf8.decode(this.bytes.subarray(at));
			if (value !== symbol)
				this.raw.fail('invalid float', [literal(symbol)], at, this.raw.length);
			this.raw.pushRange(0, this.raw.length);
			return { kind: 'float' };
		}
		return this.invalid();
	}

	private zeroPrefix(at: number, signed: boolean): ScalarKind {
		const bytes = this.bytes;
		if (bytes.length - at === 1)
			return this.floatOrInteger(0, { kind: 'integer', radix: 10 });
		const radix = bytes[at + 1] as number;
		const lower = radix | 0x20;
		const radixes: Record<number, 2 | 8 | 16> = { 120: 16, 111: 8, 98: 2 };
		if (radixes[lower] !== undefined || lower === 0x64) {
			if (contains(bytes, at, 0x20)) return this.invalid();
			if (signed)
				this.raw.fail('integers with a radix cannot be signed', [], 0, 1);
			if (lower === 0x64) {
				this.raw.fail('redundant integer number prefix', [], 0, 2);
			}
			const value = radixes[lower] as 2 | 8 | 16;
			if (radix !== lower) {
				const prefix = value === 16 ? '0x' : value === 8 ? '0o' : '0b';
				this.raw.fail('radix must be lowercase', [literal(prefix)], at, at + 2);
			}
			const kind: ScalarKind = { kind: 'integer', radix: value };
			return this.ensureRadixed(at + 2, value)
				? this.floatOrInteger(at + 2, kind)
				: kind;
		}
		return this.datetimeOrNumber(at);
	}

	private datetimeOrNumber(at: number): ScalarKind {
		const bytes = this.bytes;
		let digitEnd = at;
		while (digitEnd < bytes.length && isDigit(bytes[digitEnd])) digitEnd++;
		if (digitEnd === bytes.length) {
			return this.noLeadingZero(at)
				? this.floatOrInteger(0, { kind: 'integer', radix: 10 })
				: { kind: 'integer', radix: 10 };
		}
		const rest = bytes[digitEnd];
		if (rest === 0x2d || rest === 0x3a) {
			this.raw.pushRange(0, this.raw.length);
			return { kind: 'datetime' };
		}
		if (contains(bytes, digitEnd, 0x20)) return this.invalid();
		const tail = bytes.subarray(digitEnd);
		if (tail.includes(0x2e) || tail.includes(0x65) || tail.includes(0x45)) {
			return this.ensureFloat(at)
				? this.floatOrInteger(0, { kind: 'float' })
				: { kind: 'float' };
		}
		if (rest === 0x5f) {
			return this.noLeadingZero(at)
				? this.floatOrInteger(0, { kind: 'integer', radix: 10 })
				: { kind: 'integer', radix: 10 };
		}
		return this.invalid();
	}

	private ensureFloat(from: number): boolean {
		let at = from;
		let valid = true;
		[at, valid] = this.ensureDecUint(at, false, 'invalid mantissa', valid);
		if (this.bytes[at] === 0x2e)
			[at, valid] = this.ensureDecUint(at + 1, true, 'invalid fraction', valid);
		if (this.bytes[at] === 0x65 || this.bytes[at] === 0x45) {
			at++;
			if (this.bytes[at] === 0x2b || this.bytes[at] === 0x2d) at++;
			[at, valid] = this.ensureDecUint(at, true, 'invalid exponent', valid);
		}
		if (at < this.bytes.length)
			this.raw.fail('invalid float', [], at, this.raw.length);
		return valid;
	}

	private ensureDecUint(
		from: number,
		zeroPrefix: boolean,
		invalid: string,
		valid: boolean,
	): [number, boolean] {
		let at = from;
		let digits = 0;
		while (at < this.bytes.length) {
			const b = this.bytes[at] as number;
			if (isDigit(b)) digits++;
			else if (b !== 0x5f) break;
			at++;
		}
		if (digits === 0) this.raw.fail(invalid, [described('digits')], from);
		if (digits > 1 && this.bytes[from] === 0x30 && !zeroPrefix)
			this.raw.fail('unexpected leading zero', [], from, from + 1);
		return [at, valid];
	}

	private noLeadingZero(at: number): boolean {
		if (this.bytes[at] === 0x30)
			this.raw.fail('unexpected leading zero', [], at, at + 1);
		return true;
	}

	private ensureRadixed(from: number, radix: 2 | 8 | 16): boolean {
		let at = from;
		const b = this.bytes[at];
		if (b === 0x2b || b === 0x2d) {
			const position = this.bytes.findIndex((x) => x === 0x2b || x === 0x2d);
			this.raw.fail('unexpected sign', [], position, position + 1);
		}
		const { description, valid } = INTEGER[radix];
		for (; at < this.bytes.length; at++) {
			const c = this.bytes[at] as number;
			if (!valid(c) && c !== 0x5f) this.raw.fail(description, undefined, at);
		}
		return true;
	}

	private floatOrInteger(from: number, kind: ScalarKind): ScalarKind {
		const bytes = this.bytes;
		const digit = (b: number) =>
			kind.kind === 'float' ? isDigit(b) : isHex(b);
		let at = from;
		while (at < bytes.length) {
			let sep = at;
			while (sep < bytes.length && bytes[sep] !== 0x5f) sep++;
			const partStart = at;
			this.raw.pushRange(at, sep);
			at = sep;
			if (sep < bytes.length) {
				at++;
				let invalid = false;
				if (sep > partStart) {
					if (!digit(bytes[sep - 1] as number)) invalid = true;
				} else if (partStart === from) {
					invalid = true;
				}
				if (at < bytes.length) {
					if (!digit(bytes[at] as number)) invalid = true;
				} else {
					invalid = true;
				}
				if (invalid)
					this.raw.fail('`_` may only go between digits', [], sep, sep + 1);
			}
		}
		return kind;
	}

	private symbol(symbol: string, kind: ScalarKind): ScalarKind {
		const text = utf8.decode(this.bytes);
		if (text !== symbol) {
			if (contains(this.bytes, 0, 0x20)) return this.invalid();
			this.raw.fail(
				kind.kind === 'boolean' ? 'invalid boolean' : 'invalid float',
				[literal(symbol)],
				0,
				this.raw.length,
			);
		}
		for (let i = 0; i < symbol.length; i++)
			this.raw.out.push(symbol.charCodeAt(i));
		return kind;
	}

	private invalid(): ScalarKind {
		const text = utf8.decode(this.bytes);
		if (text.endsWith("'''"))
			this.raw.fail('missing opening quote', [literal("'''")], 0);
		if (text.endsWith('"""'))
			this.raw.fail('missing opening quote', [literal('"""')], 0);
		if (text.endsWith("'"))
			this.raw.fail('missing opening quote', [literal("'")], 0);
		if (text.endsWith('"'))
			this.raw.fail('missing opening quote', [literal('"')], 0);
		this.raw.fail(
			'string values must be quoted',
			[described('literal string')],
			0,
			this.raw.length,
		);
	}
}
