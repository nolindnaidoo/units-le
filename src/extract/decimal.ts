/**
 * The crate's `decimal.rs`: a sign, an integer mantissa and a power-of-ten
 * scale, so a base value is exact or refused. `u128` is a `bigint` held to
 * 128 bits, and every operation that the crate checks is checked here.
 */

const U128_MAX = (1n << 128n) - 1n;
/** u128 holds 38 decimal digits; a longer literal is refused, never truncated. */
const MAX_DIGITS = 38;

export interface Factor {
	readonly multiplier: bigint;
	readonly shift: number;
}

export interface Decimal {
	readonly negative: boolean;
	readonly mantissa: bigint;
	readonly scale: number;
}

const checked = (value: bigint): bigint | undefined =>
	value > U128_MAX ? undefined : value;

function pow10(places: number): bigint | undefined {
	return checked(10n ** BigInt(places));
}

/** A literal the lexer already shaped. `undefined` means it does not fit, not that it was malformed. */
export function parseDecimal(literal: string): Decimal | undefined {
	const signed = literal.startsWith('-') || literal.startsWith('+');
	const negative = literal.startsWith('-');
	const digits = signed ? literal.slice(1) : literal;
	const point = digits.indexOf('.');
	const whole = point === -1 ? digits : digits.slice(0, point);
	const fraction = point === -1 ? '' : digits.slice(point + 1);
	if (whole.length + fraction.length > MAX_DIGITS) return undefined;
	// `u128::from_str`: one optional leading `+`, then ASCII digits only.
	const joined = `${whole}${fraction}`;
	const body = joined.startsWith('+') ? joined.slice(1) : joined;
	if (!/^[0-9]+$/.test(body)) return undefined;
	const mantissa = checked(BigInt(body));
	if (mantissa === undefined) return undefined;
	return { negative, mantissa, scale: fraction.length };
}

export function isFractional(value: Decimal): boolean {
	const divisor = pow10(value.scale);
	if (divisor === undefined) return true;
	return value.mantissa % divisor !== 0n;
}

export function apply(value: Decimal, factor: Factor): Decimal | undefined {
	const mantissa = checked(value.mantissa * factor.multiplier);
	if (mantissa === undefined) return undefined;
	return {
		negative: value.negative,
		mantissa,
		scale: value.scale + factor.shift,
	};
}

export function checkedAdd(left: Decimal, right: Decimal): Decimal | undefined {
	const scale = Math.max(left.scale, right.scale);
	const a = aligned(left, scale);
	const b = aligned(right, scale);
	if (a === undefined || b === undefined) return undefined;
	const mantissa = checked(a + b);
	if (mantissa === undefined) return undefined;
	return { negative: left.negative, mantissa, scale };
}

function aligned(value: Decimal, scale: number): bigint | undefined {
	const multiplier = pow10(scale - value.scale);
	return multiplier === undefined
		? undefined
		: checked(value.mantissa * multiplier);
}

/** In full, no trailing zeros, never exponential, never `-0`. */
export function render(value: Decimal): string {
	const sign = value.negative && value.mantissa !== 0n ? '-' : '';
	const digits = value.mantissa.toString();
	if (value.scale === 0) return `${sign}${digits}`;
	const padded = digits.padStart(value.scale + 1, '0');
	const whole = padded.slice(0, padded.length - value.scale);
	const fraction = padded.slice(padded.length - value.scale).replace(/0+$/, '');
	return fraction === '' ? `${sign}${whole}` : `${sign}${whole}.${fraction}`;
}
