/**
 * toml_parser's `ParseError`, and the rule that only the first one counts:
 * the toml crate's `TomlSink<Option<_>>` keeps the first error reported and
 * drops the rest. So a report here throws, and nothing after the first error
 * can change the answer — which is why the parser's recovery paths are not
 * transcribed past the point where they report.
 *
 * Every span is a UTF-8 byte range over the document.
 */

export type Expected =
	| { readonly literal: string }
	| { readonly description: string };

export interface Span {
	readonly start: number;
	readonly end: number;
}

export const span = (start: number, end: number): Span => ({ start, end });
export const before = (s: Span): Span => span(s.start, s.start);
export const after = (s: Span): Span => span(s.end, s.end);
export const append = (s: Span, next: Span): Span => span(s.start, next.end);

export class TomlParseError extends Error {
	constructor(
		readonly description: string,
		/** Absent is "no expected list"; empty renders as "expected nothing". */
		readonly expected: readonly Expected[] | undefined,
		readonly unexpected: Span | undefined,
	) {
		super(description);
	}
}

export const literal = (text: string): Expected => ({ literal: text });
export const described = (text: string): Expected => ({ description: text });

export function report(
	description: string,
	expected?: readonly Expected[],
	unexpected?: Span,
): never {
	throw new TomlParseError(description, expected, unexpected);
}

/** The same error as a value, for a `throw` that ends a switch case. */
export function failure(
	description: string,
	expected?: readonly Expected[],
	unexpected?: Span,
): TomlParseError {
	return new TomlParseError(description, expected, unexpected);
}
