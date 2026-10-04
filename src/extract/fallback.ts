import {
	numberPrefix,
	type Quantity,
	readValue,
	symbolPrefix,
} from './grammar';
import { charAt, charBefore, isAlphanumeric, isAsciiDigit } from './text';

/**
 * The crate's `fallback.rs`: quantities in free-form text, for a format
 * nothing here parses. A run never begins inside a word, and an operator
 * joins runs into one finding. Offsets are UTF-16 indices.
 */
export function scan(text: string): Array<[Quantity, number]> {
	const found: Array<[Quantity, number]> = [];
	let index = 0;
	while (index < text.length) {
		const character = charAt(text, index);
		if (character === undefined) break;
		if (!canStart(text, index)) {
			index += character.length;
			continue;
		}
		const hit = candidate(text, index);
		if (hit === undefined) {
			index += character.length;
			continue;
		}
		found.push([hit[0], index]);
		index = hit[1];
	}
	return found;
}

function candidate(
	text: string,
	index: number,
): [Quantity, number] | undefined {
	const run = runEnd(text, index);
	const first = run ?? numberEnd(text, index);
	if (first === undefined) return undefined;
	const reach = expressionEnd(text, first);
	if (reach !== undefined) {
		const quantity = readValue(text.slice(index, reach));
		if (quantity !== undefined) return [quantity, reach];
	}
	if (run === undefined) return undefined;
	const quantity = readValue(text.slice(index, run));
	return quantity === undefined ? undefined : [quantity, run];
}

function canStart(text: string, index: number): boolean {
	if (!boundaryBefore(text, index)) return false;
	const character = charAt(text, index);
	if (character === undefined) return false;
	const next = charAt(text, index + character.length);
	if (isAsciiDigit(character)) return true;
	if (character === '+' || character === '-' || character === '.')
		return isAsciiDigit(next);
	// An ISO-8601 duration is the one shape that opens with a letter.
	return character === 'P' && (isAsciiDigit(next) || next === 'T');
}

const wordCharacter = (character: string): boolean =>
	isAlphanumeric(character) || character === '_';

function boundaryBefore(text: string, index: number): boolean {
	const character = charBefore(text, index);
	return (
		character === undefined ||
		(!wordCharacter(character) && character !== '.' && character !== ',')
	);
}

function boundaryAfter(text: string, index: number): boolean {
	const character = charAt(text, index);
	return character === undefined || !wordCharacter(character);
}

function runEnd(text: string, start: number): number | undefined {
	const rest = text.slice(start);
	const length = rest.startsWith('P') ? isoRun(rest) : plainRun(rest);
	if (length === undefined) return undefined;
	const end = start + length;
	return boundaryAfter(text, end) ? end : undefined;
}

function plainRun(rest: string): number | undefined {
	let length = 0;
	let pairs = 0;
	for (;;) {
		const number = numberPrefix(rest.slice(length), length === 0);
		if (number === 0) break;
		const symbol = symbolPrefix(rest.slice(length + number));
		if (symbol === 0) break;
		length += number + symbol;
		pairs++;
	}
	return pairs > 0 ? length : undefined;
}

function isoRun(rest: string): number | undefined {
	let length = 0;
	for (const character of rest) {
		if (!(isAlphanumeric(character) || character === '.' || character === ','))
			break;
		length += character.length;
	}
	return length === 0 ? undefined : length;
}

function expressionEnd(text: string, end: number): number | undefined {
	let reach: number | undefined;
	let cursor = end;
	for (;;) {
		const after = skipSpaces(text, cursor);
		const operator = charAt(text, after);
		if (operator === undefined || !'+-*/'.includes(operator)) break;
		const nextStart = skipSpaces(text, after + operator.length);
		const nextEnd = operandEnd(text, nextStart);
		if (nextEnd === undefined) break;
		cursor = nextEnd;
		reach = nextEnd;
	}
	return reach;
}

function operandEnd(text: string, start: number): number | undefined {
	return runEnd(text, start) ?? numberEnd(text, start);
}

function numberEnd(text: string, start: number): number | undefined {
	const length = numberPrefix(text.slice(start), false);
	if (length === 0) return undefined;
	const end = start + length;
	return boundaryAfter(text, end) ? end : undefined;
}

function skipSpaces(text: string, from: number): number {
	let index = from;
	while (
		index < text.length &&
		(text.charAt(index) === ' ' || text.charAt(index) === '\t')
	)
		index++;
	return index;
}
