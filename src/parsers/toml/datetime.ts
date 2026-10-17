/**
 * toml_datetime 1.1.1's `Datetime::from_str`. Only acceptance and the error
 * text matter here — a datetime is never a quantity — so this answers with
 * the error message, or nothing when the text is a datetime.
 */

type Kind =
	| 'digits'
	| 'dash'
	| 'colon'
	| 'dot'
	| 't'
	| 'space'
	| 'z'
	| 'plus'
	| 'unknown';

interface Token {
	readonly kind: Kind;
	readonly raw: string;
}

class Lexer {
	constructor(private stream: string) {}

	clone(): Lexer {
		return new Lexer(this.stream);
	}

	next(): Token | undefined {
		const first = this.stream.charAt(0);
		if (first === '') return undefined;
		let kind: Kind;
		let end = 1;
		if (first >= '0' && first <= '9') {
			kind = 'digits';
			end = this.stream.search(/[^0-9]/);
			if (end === -1) end = this.stream.length;
		} else if (first === '-') kind = 'dash';
		else if (first === ':') kind = 'colon';
		else if (first === 'T' || first === 't') kind = 't';
		else if (first === ' ') kind = 'space';
		else if (first === 'Z' || first === 'z') kind = 'z';
		else if (first === '+') kind = 'plus';
		else if (first === '.') kind = 'dot';
		else {
			kind = 'unknown';
			end = this.stream.length;
		}
		const raw = this.stream.slice(0, end);
		this.stream = this.stream.slice(end);
		return { kind, raw };
	}

	remaining(): boolean {
		return this.stream !== '';
	}
}

class Invalid extends Error {}

function fail(what?: string, expected?: string): never {
	throw new Invalid(
		`${what === undefined ? 'invalid datetime' : `invalid ${what}`}${expected === undefined ? '' : `, expected ${expected}`}`,
	);
}

function expect(
	token: Token | undefined,
	kind: Kind,
	what: string | undefined,
	expected: string | undefined,
): Token {
	if (token === undefined || token.kind !== kind) fail(what, expected);
	return token;
}

/** The error toml_datetime reports for this text, or undefined when it is a datetime. */
export function datetimeError(text: string): string | undefined {
	try {
		parse(text);
		return undefined;
	} catch (error) {
		if (error instanceof Invalid) return error.message;
		throw error;
	}
}

function parse(date: string): void {
	let lexer = new Lexer(date);
	let hasDate = false;
	const digits = lexer.next();
	if (digits === undefined) fail(undefined, 'year or hour');
	if (digits.kind !== 'digits') fail(undefined, 'year or hour');
	const sep = lexer.next();
	if (sep === undefined) fail(undefined, '`-` (YYYY-MM) or `:` (HH:MM)');
	if (sep.kind === 'dash') {
		const month = expect(lexer.next(), 'digits', 'date', 'month');
		expect(lexer.next(), 'dash', 'date', '`-` (MM-DD)');
		const day = expect(lexer.next(), 'digits', 'date', 'day');
		if (digits.raw.length !== 4) fail('date', 'a four-digit year (YYYY)');
		if (month.raw.length !== 2) fail('date', 'a two-digit month (MM)');
		if (day.raw.length !== 2) fail('date', 'a two-digit day (DD)');
		const year = Number(digits.raw);
		const m = Number(month.raw);
		const d = Number(day.raw);
		if (m < 1 || m > 12) fail('date', 'month between 01 and 12');
		const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
		const [max, expected] =
			m === 2 && leap
				? [29, 'day between 01 and 29']
				: m === 2
					? [28, 'day between 01 and 28']
					: [4, 6, 9, 11].includes(m)
						? [30, 'day between 01 and 30']
						: [31, 'day between 01 and 31'];
		if (d < 1 || d > max) fail('date', expected);
		hasDate = true;
	} else if (sep.kind === 'colon') {
		lexer = new Lexer(date);
	} else {
		fail(undefined, '`-` (YYYY-MM) or `:` (HH:MM)');
	}

	let partialTime = !hasDate;
	if (hasDate) {
		const separator = lexer.next();
		if (separator !== undefined) {
			if (separator.kind !== 't' && separator.kind !== 'space')
				fail('date-time', '`T` between date and time');
			partialTime = true;
		}
	}
	let hasTime = false;
	if (partialTime) {
		const hour = expect(lexer.next(), 'digits', 'time', 'hour');
		expect(lexer.next(), 'colon', 'time', '`:` (HH:MM)');
		const minute = expect(lexer.next(), 'digits', 'time', 'minute');
		let second: Token | undefined;
		if (lexer.clone().next()?.kind === 'colon') {
			lexer.next();
			second = expect(lexer.next(), 'digits', 'time', 'second');
		}
		if (second !== undefined && lexer.clone().next()?.kind === 'dot') {
			lexer.next();
			expect(lexer.next(), 'digits', 'time', 'nanosecond');
		}
		if (hour.raw.length !== 2) fail('time', 'a two-digit hour (HH)');
		if (minute.raw.length !== 2) fail('time', 'a two-digit minute (MM)');
		if (second !== undefined && second.raw.length !== 2)
			fail('time', 'a two-digit second (SS)');
		if (Number(hour.raw) > 23) fail('time', 'hour between 00 and 23');
		if (Number(minute.raw) > 59) fail('time', 'minute between 00 and 59');
		if (second !== undefined && Number(second.raw) > 60)
			fail('time', 'second between 00 and 60');
		hasTime = true;
	}

	if (hasDate && hasTime) {
		const token = lexer.next();
		if (token !== undefined) {
			if (token.kind === 'plus' || token.kind === 'dash') {
				const hours = expect(lexer.next(), 'digits', 'offset', 'hour');
				expect(lexer.next(), 'colon', 'offset', '`:` (HH:MM)');
				const minutes = expect(lexer.next(), 'digits', 'offset', 'minute');
				if (hours.raw.length !== 2) fail('offset', 'a two-digit hour (HH)');
				if (minutes.raw.length !== 2) fail('offset', 'a two-digit minute (MM)');
				if (Number(hours.raw) > 23) fail('offset', 'hours between 00 and 23');
				if (Number(minutes.raw) > 59)
					fail('offset', 'minutes between 00 and 59');
			} else if (token.kind !== 'z') {
				fail('offset', '`Z`, +OFFSET, -OFFSET');
			}
		}
	}
	if (lexer.remaining()) fail();
}
