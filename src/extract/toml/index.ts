import { collect, type Field, OTHER, type Value } from '../policy';
import { datetimeError } from './datetime';
import {
	buildDocument,
	type DeTable,
	type DeValue,
	type Spanned,
} from './document';
import { type Expected, type Span, TomlParseError } from './errors';
import { lex } from './lexer';
import { parseEvents } from './parser';

/**
 * The crate's `toml.rs`: `text.parse::<toml::Table>()` at toml 1.1.6 with
 * `preserve_order`. Three phases, in the crate's order — toml_parser's
 * syntax (lexer, parser, whitespace validation), the toml crate's table
 * rules and value decoding, then serde's walk into `toml::Value` — and the
 * first error any of them reports is the one rendered, in toml's own words
 * and snippet.
 */

const encoder = new TextEncoder();
const strict = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const DATETIME_FIELD = '$__toml_private_datetime';

class DeError extends Error {
	constructor(
		message: string,
		readonly span: Span,
	) {
		super(message);
	}
}

function renderLiteral(text: string): string {
	if (text === '\n') return 'newline';
	if (text === '`') return "'`'";
	if (
		[...text].every((c) => c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f)
	) {
		return `\`${[...text].map((c) => (c === '\t' ? '\\t' : c === '\r' ? '\\r' : c === '\n' ? '\\n' : `\\u{${c.charCodeAt(0).toString(16)}}`)).join('')}\``;
	}
	return `\`${text}\``;
}

function parseMessage(error: TomlParseError): string {
	let message = error.description;
	if (error.expected !== undefined) {
		message += ', expected ';
		message +=
			error.expected.length === 0
				? 'nothing'
				: error.expected
						.map((item: Expected) =>
							'literal' in item
								? renderLiteral(item.literal)
								: item.description,
						)
						.join(', ');
	}
	return message;
}

/** toml's `translate_position`: a 0-based line, and a column in characters — or bytes where the span starts mid-character. */
function translatePosition(input: Uint8Array, at: number): [number, number] {
	if (input.length === 0) return [0, at];
	const index = Math.min(at, input.length - 1);
	const columnOffset = at - index;
	let lineStart = 0;
	for (let i = index - 1; i >= 0; i--) {
		if (input[i] === 0x0a) {
			lineStart = i + 1;
			break;
		}
	}
	let line = 0;
	for (let i = 0; i < lineStart; i++) if (input[i] === 0x0a) line++;
	let column: number;
	try {
		column =
			[...strict.decode(input.subarray(lineStart, index + 1))].length - 1;
	} catch {
		column = index - lineStart;
	}
	return [line, column + columnOffset];
}

/** toml's `Display for Error`. */
function render(
	text: string,
	bytes: Uint8Array,
	message: string,
	span: Span | undefined,
): string {
	if (span === undefined) return `${message}\n`;
	const [line, column] = translatePosition(bytes, span.start);
	const lineNumber = line + 1;
	const gutter = String(lineNumber).length;
	const content = text.split('\n')[line] as string;
	const contentBytes = encoder.encode(content).length;
	const highlight = Math.min(
		span.end - span.start,
		Math.max(0, contentBytes - column),
	);
	const pad = ' '.repeat(gutter + 1);
	return [
		`TOML parse error at line ${lineNumber}, column ${column + 1}`,
		`${pad}|`,
		`${lineNumber} | ${content}`,
		`${pad}|${' '.repeat(column + 1)}^${'^'.repeat(Math.max(0, highlight - 1))}`,
		message,
		'',
	].join('\n');
}

// ---- serde's walk into toml::Value

/** Rust's `{}` for an f64, which never uses an exponent. */
function rustFloat(value: number): string {
	if (Number.isNaN(value)) return 'NaN';
	if (!Number.isFinite(value)) return value > 0 ? 'inf' : '-inf';
	if (Object.is(value, -0)) return '-0';
	const text = String(value);
	if (!/e/i.test(text)) return text;
	const negative = value < 0;
	const [mantissa = '', exponentText = '0'] = (
		negative ? text.slice(1) : text
	).split(/e/i);
	const exponent = Number(exponentText);
	const [whole = '', fraction = ''] = mantissa.split('.');
	const digits = whole + fraction;
	const point = whole.length + exponent;
	const body =
		point <= 0
			? `0.${'0'.repeat(-point)}${digits}`
			: point >= digits.length
				? digits + '0'.repeat(point - digits.length)
				: `${digits.slice(0, point)}.${digits.slice(point)}`;
	return (negative ? '-' : '') + body;
}

/** `i64`/`u64`/`i128`/`u128::from_str_radix`, as the deserializer tries them in turn. */
function integer(
	text: string,
	radix: number,
): { kind: 'i64' | 'u64' | 'i128' | 'u128'; value: bigint } | undefined {
	const negative = text.startsWith('-');
	const unsigned = text.startsWith('+') || negative ? text.slice(1) : text;
	if (unsigned === '') return undefined;
	let value = 0n;
	for (const digit of unsigned) {
		const d = Number.parseInt(digit, radix);
		if (Number.isNaN(d)) return undefined;
		value = value * BigInt(radix) + BigInt(d);
	}
	const signed = negative ? -value : value;
	const fits = (low: bigint, high: bigint) => signed >= low && signed <= high;
	if (fits(-(2n ** 63n), 2n ** 63n - 1n)) return { kind: 'i64', value: signed };
	if (!negative && fits(0n, 2n ** 64n - 1n))
		return { kind: 'u64', value: signed };
	if (fits(-(2n ** 127n), 2n ** 127n - 1n))
		return { kind: 'i128', value: signed };
	if (!negative && fits(0n, 2n ** 128n - 1n))
		return { kind: 'u128', value: signed };
	return undefined;
}

const VALUE_EXPECTING = 'any valid TOML value';
const DATETIME_EXPECTING = 'string containing a datetime';

/** The value, or serde's `invalid type` for a visitor that does not take it. */
function walk(item: Spanned, expecting: string): Value {
	const { value, span } = item;
	const fail = (message: string): never => {
		throw new DeError(message, span);
	};
	const invalid = (unexpected: string): never =>
		fail(`invalid type: ${unexpected}, expected ${expecting}`);
	switch (value.type) {
		case 'string':
			return { type: 'text', text: value.text };
		case 'integer': {
			const parsed = integer(value.text, value.radix);
			if (parsed === undefined) fail('integer number overflowed');
			const { kind, value: number } = parsed as { kind: string; value: bigint };
			if (kind === 'i128' || kind === 'u128')
				invalid(`integer \`${number}\` as ${kind}`);
			if (expecting === DATETIME_EXPECTING) invalid(`integer \`${number}\``);
			if (kind === 'u64') fail('u64 value was too large');
			return OTHER;
		}
		case 'float': {
			const lower = value.text.toLowerCase();
			const number = Number(value.text);
			if (
				!lower.includes('inf') &&
				!lower.includes('nan') &&
				!Number.isFinite(number)
			)
				fail('floating-point number overflowed');
			if (expecting === DATETIME_EXPECTING) {
				// serde's WithDecimalPoint: a finite value gains `.0` when it has no point; a non-finite one prints as Rust does.
				if (lower.includes('nan')) invalid('floating point `NaN`');
				if (lower.includes('inf'))
					invalid(
						`floating point \`${lower.startsWith('-') ? '-inf' : 'inf'}\``,
					);
				const shown = rustFloat(number);
				invalid(
					`floating point \`${shown.includes('.') ? shown : `${shown}.0`}\``,
				);
			}
			return OTHER;
		}
		case 'boolean':
			if (expecting === DATETIME_EXPECTING)
				invalid(`boolean \`${value.value}\``);
			return OTHER;
		case 'datetime':
			if (expecting === DATETIME_EXPECTING) invalid('map');
			return OTHER;
		case 'array':
			if (expecting === DATETIME_EXPECTING) invalid('sequence');
			return {
				type: 'seq',
				items: value.items.map((element) => walk(element, VALUE_EXPECTING)),
			};
		case 'table':
			if (expecting === DATETIME_EXPECTING) invalid('map');
			return nested(value.table);
	}
}

/** toml::Value's `visit_map`, with toml_datetime's hook on a first key that names its private field. */
function nested(table: DeTable): Value {
	const entries = [...table.entries];
	const first = entries[0];
	if (first !== undefined && first[0] === DATETIME_FIELD) {
		const item = first[1].item;
		if (item.value.type !== 'string') walk(item, DATETIME_EXPECTING);
		else {
			const error = datetimeError((item.value as { text: string }).text);
			if (error !== undefined) throw new DeError(error, item.span);
		}
		return OTHER;
	}
	return {
		type: 'map',
		entries: entries.map(
			([key, entry]) => [key, walk(entry.item, VALUE_EXPECTING)] as const,
		),
	};
}

function root(table: DeTable): Value {
	return {
		type: 'map',
		entries: [...table.entries].map(
			([key, entry]) => [key, walk(entry.item, VALUE_EXPECTING)] as const,
		),
	};
}

function parsed(text: string): Value | string {
	const bytes = encoder.encode(text);
	try {
		return root(buildDocument(parseEvents(lex(bytes), bytes), bytes));
	} catch (error) {
		if (error instanceof TomlParseError)
			return render(text, bytes, parseMessage(error), error.unexpected);
		if (error instanceof DeError)
			return render(text, bytes, error.message, error.span);
		throw error;
	}
}

export function extractToml(text: string): Field[] {
	const value = parsed(text);
	return typeof value === 'string' ? [] : collect(value);
}

export function tomlParseError(text: string): string | undefined {
	const value = parsed(text);
	return typeof value === 'string'
		? `Failed to parse TOML: ${value}`
		: undefined;
}

export type { DeValue };
