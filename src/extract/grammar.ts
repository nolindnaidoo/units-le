import {
	apply,
	checkedAdd,
	type Decimal,
	type Factor,
	isFractional,
	parseDecimal,
	render,
} from './decimal';
import { isAlphabetic, isAsciiDigit, trim } from './text';

/**
 * The crate's `grammar.rs`: the unit grammar and the refusals, symbol for
 * symbol. A refusal is a finding with a named reason and a sentence a person
 * can act on; a bare number is not a finding at all.
 */

export type Dimension = 'duration' | 'bytes' | 'percent' | 'frequency';
export const DIMENSIONS: readonly Dimension[] = [
	'duration',
	'bytes',
	'percent',
	'frequency',
];
export type BaseUnit = 'milliseconds' | 'bytes' | 'ratio' | 'hertz';
export type Reason =
	| 'ambiguous_unit'
	| 'fractional_bytes'
	| 'locale_separator'
	| 'compound_arithmetic'
	| 'si_iec_hazard'
	| 'out_of_range';

const BASE_UNIT: Record<Dimension, BaseUnit> = {
	duration: 'milliseconds',
	bytes: 'bytes',
	percent: 'ratio',
	frequency: 'hertz',
};

/** One quantity, as found. `reason` and `detail` are absent, not null, when there is none. */
export interface Quantity {
	readonly value: string;
	readonly dimension: Dimension | null;
	readonly baseUnit: BaseUnit | null;
	readonly base: string | null;
	readonly reason?: Reason;
	readonly detail?: string;
}

const HAZARD_DETAIL =
	'reported as SI — 10^6 bytes to the megabyte — because that is what the symbol says. The writer may have meant 2^20; the IEC spelling (KiB, MiB, GiB) is the one that cannot be read two ways.';

function refused(
	value: string,
	dimension: Dimension | null,
	reason: Reason,
	detail: string,
): Quantity {
	return {
		value,
		dimension,
		baseUnit: dimension === null ? null : BASE_UNIT[dimension],
		base: null,
		reason,
		detail,
	};
}

function resolved(
	value: string,
	dimension: Dimension,
	base: Decimal,
	hazard: boolean,
): Quantity {
	return {
		value,
		dimension,
		baseUnit: BASE_UNIT[dimension],
		base: render(base),
		...(hazard
			? { reason: 'si_iec_hazard' as const, detail: HAZARD_DETAIL }
			: {}),
	};
}

interface Unit {
	readonly symbol: string;
	readonly dimension: Dimension;
	readonly factor: Factor;
	readonly hazard: boolean;
}

/** Every duration shares one scale, a nanosecond, so the compound rule can compare magnitudes. */
const NS = 6;
const duration = (symbol: string, nanoseconds: bigint): Unit => ({
	symbol,
	dimension: 'duration',
	factor: { multiplier: nanoseconds, shift: NS },
	hazard: false,
});
const size = (symbol: string, bytes: bigint, hazard: boolean): Unit => ({
	symbol,
	dimension: 'bytes',
	factor: { multiplier: bytes, shift: 0 },
	hazard,
});
const hertz = (symbol: string, cycles: bigint): Unit => ({
	symbol,
	dimension: 'frequency',
	factor: { multiplier: cycles, shift: 0 },
	hazard: false,
});

const MICROSECOND = 1_000n;
const MILLISECOND = 1_000_000n;
const SECOND = 1_000n * MILLISECOND;
const MINUTE = 60n * SECOND;
const HOUR = 60n * MINUTE;
const DAY = 24n * HOUR;
const WEEK = 7n * DAY;
const KIB = 1024n;
const MIB = 1024n * KIB;
const GIB = 1024n * MIB;
const TIB = 1024n * GIB;
const PIB = 1024n * TIB;

const UNITS: readonly Unit[] = [
	duration('ns', 1n),
	duration('us', MICROSECOND),
	duration('µs', MICROSECOND),
	duration('μs', MICROSECOND),
	duration('ms', MILLISECOND),
	duration('s', SECOND),
	duration('sec', SECOND),
	duration('secs', SECOND),
	duration('min', MINUTE),
	duration('mins', MINUTE),
	duration('h', HOUR),
	duration('hr', HOUR),
	duration('hrs', HOUR),
	duration('d', DAY),
	duration('day', DAY),
	duration('days', DAY),
	duration('w', WEEK),
	size('B', 1n, false),
	size('kB', 1_000n, true),
	size('KB', 1_000n, true),
	size('MB', 1_000_000n, true),
	size('GB', 1_000_000_000n, true),
	size('TB', 1_000_000_000_000n, true),
	size('PB', 1_000_000_000_000_000n, true),
	size('KiB', KIB, false),
	size('MiB', MIB, false),
	size('GiB', GIB, false),
	size('TiB', TIB, false),
	size('PiB', PIB, false),
	size('Ki', KIB, false),
	size('Mi', MIB, false),
	size('Gi', GIB, false),
	size('Ti', TIB, false),
	size('Pi', PIB, false),
	hertz('Hz', 1n),
	hertz('kHz', 1_000n),
	hertz('KHz', 1_000n),
	hertz('MHz', 1_000_000n),
	hertz('GHz', 1_000_000_000n),
	hertz('THz', 1_000_000_000_000n),
	{
		symbol: '%',
		dimension: 'percent',
		factor: { multiplier: 1n, shift: 2 },
		hazard: false,
	},
];

const BITS_OR_BYTES =
	'a lowercase `b` is bits by the standard and bytes in most of the software that writes it, and the two differ by eight. Write `MB` for bytes or `Mbit` for bits.';

const AMBIGUOUS: ReadonlyArray<readonly [string, string]> = [
	[
		'm',
		'`m` is minutes in one config format, milliseconds in another and millicores in Kubernetes. Write `min`, `ms`, or spell out the core count.',
	],
	[
		'M',
		'`M` is mega- in one config format and minutes in another. Write `MB`, `Mi` or `min`.',
	],
	[
		'k',
		'`k` is a prefix with no unit after it: a thousand of what? Write `kB`, `Ki` or `kHz`.',
	],
	[
		'K',
		'`K` is a prefix with no unit after it: a thousand of what? Write `KB`, `Ki` or `KHz`.',
	],
	['G', '`G` is a prefix with no unit after it. Write `GB`, `Gi` or `GHz`.'],
	['T', '`T` is a prefix with no unit after it. Write `TB`, `Ti` or `THz`.'],
	['P', '`P` is a prefix with no unit after it. Write `PB` or `Pi`.'],
	['y', 'a calendar year has no fixed length. Write the number of days.'],
	['Y', 'a calendar year has no fixed length. Write the number of days.'],
	['b', BITS_OR_BYTES],
	['kb', BITS_OR_BYTES],
	['Kb', BITS_OR_BYTES],
	['mb', BITS_OR_BYTES],
	['Mb', BITS_OR_BYTES],
	['gb', BITS_OR_BYTES],
	['Gb', BITS_OR_BYTES],
	['tb', BITS_OR_BYTES],
	['Tb', BITS_OR_BYTES],
];

type Symbol =
	| { kind: 'known'; unit: Unit }
	| { kind: 'ambiguous'; detail: string }
	| { kind: 'unknown' };

function resolve(symbol: string): Symbol {
	const unit = UNITS.find((candidate) => candidate.symbol === symbol);
	if (unit !== undefined) return { kind: 'known', unit };
	const ambiguous = AMBIGUOUS.find(([candidate]) => candidate === symbol);
	return ambiguous === undefined
		? { kind: 'unknown' }
		: { kind: 'ambiguous', detail: ambiguous[1] };
}

interface Part {
	readonly number: string;
	readonly symbol: string;
}

/** One whole value — a config value, a CSV cell. `undefined` is "no unit here". */
export function readValue(text: string): Quantity | undefined {
	const token = trim(text);
	if (token === '') return undefined;
	return expression(token) ?? read(token);
}

/** One token: no whitespace, no operators. */
export function read(token: string): Quantity | undefined {
	if (token.startsWith('P')) return iso8601(token, token.slice(1));
	const parts = lex(token);
	const first = parts?.[0];
	if (parts === undefined || first === undefined) return undefined;
	if (parts.length === 1) return simple(token, first);
	return compound(token, parts);
}

const COMPOUND_DETAIL =
	'this is arithmetic, not a quantity, and this tool does not evaluate it. `1h30m` is one duration written in two parts and is read; `1h + 30m` is a sum.';

function expression(token: string): Quantity | undefined {
	const operands = token.split(/[+\-*/]/).map(trim);
	if (operands.length < 2) return undefined;
	if (operands.some((operand) => operand === '')) return undefined;
	const quantities = operands.map((operand) => read(operand) !== undefined);
	if (!quantities.includes(true)) return undefined;
	const everyOperandReads = operands.every(
		(operand, index) => quantities[index] || isBareNumber(operand),
	);
	if (!everyOperandReads) return undefined;
	return refused(token, null, 'compound_arithmetic', COMPOUND_DETAIL);
}

export function isBareNumber(text: string): boolean {
	return text !== '' && numberPrefix(text, false) === text.length;
}

function lex(token: string): Part[] | undefined {
	const parts: Part[] = [];
	let rest = token;
	while (rest !== '') {
		const numberEnd = numberPrefix(rest, parts.length === 0);
		if (numberEnd === 0) return undefined;
		const number = rest.slice(0, numberEnd);
		const tail = rest.slice(numberEnd);
		const symbolEnd = symbolPrefix(tail);
		if (symbolEnd === 0) return undefined;
		parts.push({ number, symbol: tail.slice(0, symbolEnd) });
		rest = tail.slice(symbolEnd);
	}
	return parts.length === 0 ? undefined : parts;
}

/** The number at the head of `text`, in UTF-16 units; a comma is taken in, to be refused by name. */
export function numberPrefix(text: string, allowSign: boolean): number {
	let length = 0;
	let digits = 0;
	for (let index = 0; index < text.length; index++) {
		const character = text.charAt(index);
		const signed =
			index === 0 && allowSign && (character === '+' || character === '-');
		if (
			!signed &&
			!(isAsciiDigit(character) || character === '.' || character === ',')
		)
			break;
		if (isAsciiDigit(character)) digits++;
		length = index + 1;
	}
	return digits === 0 ? 0 : length;
}

/** The unit symbol at the head of `text`: a run of letters, or a single `%`. */
export function symbolPrefix(text: string): number {
	if (text.startsWith('%')) return 1;
	let length = 0;
	for (const character of text) {
		if (!isAlphabetic(character)) break;
		length += character.length;
	}
	return length;
}

const FRACTIONAL_DETAIL =
	'a byte count cannot have a fractional part, and whether the arithmetic is even right depends on whether the multiple is 1000 or 1024. Write the whole number of bytes.';

function simple(token: string, part: Part): Quantity | undefined {
	const symbol = resolve(part.symbol);
	if (symbol.kind === 'unknown') return undefined;
	if (symbol.kind === 'ambiguous')
		return refused(token, null, 'ambiguous_unit', symbol.detail);
	const { unit } = symbol;
	const hazard = separatorHazard(part.number);
	if (hazard !== undefined)
		return refused(token, unit.dimension, 'locale_separator', hazard);
	const number = parseDecimal(part.number);
	if (number === undefined) return outOfRange(token, unit.dimension);
	if (unit.dimension === 'bytes' && isFractional(number))
		return refused(token, 'bytes', 'fractional_bytes', FRACTIONAL_DETAIL);
	const base = apply(number, unit.factor);
	if (base === undefined) return outOfRange(token, unit.dimension);
	return resolved(token, unit.dimension, base, unit.hazard);
}

function compound(token: string, parts: readonly Part[]): Quantity | undefined {
	let total: Decimal | undefined;
	let previous: bigint | undefined;
	for (const part of parts) {
		const unit = compoundUnit(part.symbol);
		if (unit === undefined) return undefined;
		if (previous !== undefined && unit.factor.multiplier >= previous)
			return undefined;
		previous = unit.factor.multiplier;
		const hazard = separatorHazard(part.number);
		if (hazard !== undefined)
			return refused(token, 'duration', 'locale_separator', hazard);
		const number = parseDecimal(part.number);
		const scaled =
			number === undefined ? undefined : apply(number, unit.factor);
		const summed =
			scaled === undefined
				? undefined
				: total === undefined
					? scaled
					: checkedAdd(total, scaled);
		if (summed === undefined) return outOfRange(token, 'duration');
		total = summed;
	}
	return total === undefined
		? undefined
		: resolved(token, 'duration', total, false);
}

/** Inside a compound, `m` can only be minutes. */
function compoundUnit(symbol: string): Unit | undefined {
	const found = resolve(symbol === 'm' ? 'min' : symbol);
	return found.kind === 'known' && found.unit.dimension === 'duration'
		? found.unit
		: undefined;
}

const CALENDAR_DETAIL =
	'a calendar year or month has no fixed length, and `P1M` is a month where `PT1M` is a minute. Write the number of days, or move the component after the `T`.';

function iso8601(token: string, rest: string): Quantity | undefined {
	let total: Decimal | undefined;
	let components = 0;
	let inTime = false;
	let cursor = rest;
	while (cursor !== '') {
		if (cursor.startsWith('T')) {
			inTime = true;
			cursor = cursor.slice(1);
			continue;
		}
		const numberEnd = numberPrefix(cursor, false);
		if (numberEnd === 0) return undefined;
		const tail = cursor.slice(numberEnd);
		const code = tail.codePointAt(0);
		if (code === undefined) return undefined;
		const designator = String.fromCodePoint(code);
		const factor = isoFactor(designator, inTime);
		if (factor === undefined) {
			if (designator !== 'Y' && designator !== 'M') return undefined;
			return refused(token, 'duration', 'ambiguous_unit', CALENDAR_DETAIL);
		}
		// The standard makes a comma its own decimal separator.
		const number = cursor.slice(0, numberEnd).replaceAll(',', '.');
		if (number.split('.').length - 1 > 1) return undefined;
		const parsed = parseDecimal(number);
		const scaled = parsed === undefined ? undefined : apply(parsed, factor);
		const summed =
			scaled === undefined
				? undefined
				: total === undefined
					? scaled
					: checkedAdd(total, scaled);
		if (summed === undefined) return outOfRange(token, 'duration');
		total = summed;
		components++;
		cursor = tail.slice(designator.length);
	}
	if (components === 0 || total === undefined) return undefined;
	return resolved(token, 'duration', total, false);
}

function isoFactor(designator: string, inTime: boolean): Factor | undefined {
	const nanoseconds =
		!inTime && designator === 'W'
			? WEEK
			: !inTime && designator === 'D'
				? DAY
				: inTime && designator === 'H'
					? HOUR
					: inTime && designator === 'M'
						? MINUTE
						: inTime && designator === 'S'
							? SECOND
							: undefined;
	return nanoseconds === undefined
		? undefined
		: { multiplier: nanoseconds, shift: NS };
}

function separatorHazard(number: string): string | undefined {
	if (number.includes(',')) {
		return '`1,5` is one and a half where a comma is the decimal point, and fifteen hundred where it groups thousands. This tool does not infer a locale.';
	}
	if (number.split('.').length - 1 > 1) {
		return 'more than one decimal point, so the separators are grouping something rather than marking a fraction. This tool does not infer a locale.';
	}
	const point = number.indexOf('.');
	if (point === -1) return undefined;
	const whole = number.slice(0, point).replace(/^[+-]+/, '');
	const fraction = number.slice(point + 1);
	const grouped =
		whole.length >= 1 &&
		whole.length <= 3 &&
		!whole.startsWith('0') &&
		fraction.length === 3;
	return grouped
		? '`1.000` is one where a point is the decimal separator, and a thousand where it groups thousands. This tool does not infer a locale.'
		: undefined;
}

const OUT_OF_RANGE_DETAIL =
	'the base value does not fit in 128 bits. Refused rather than wrapped, because a wrapped count is a confident wrong answer.';

function outOfRange(token: string, dimension: Dimension): Quantity {
	return refused(token, dimension, 'out_of_range', OUT_OF_RANGE_DETAIL);
}
