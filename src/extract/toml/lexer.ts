import { type Span, span } from './errors';

/** toml_parser 1.1.3's lexer, over UTF-8 bytes. Every token is a byte span. */

export type TokenKind =
	| '.'
	| '='
	| ','
	| '['
	| ']'
	| '{'
	| '}'
	| 'whitespace'
	| 'comment'
	| 'newline'
	| 'literal'
	| 'basic'
	| 'mlLiteral'
	| 'mlBasic'
	| 'atom'
	| 'eof';

export interface Token {
	readonly kind: TokenKind;
	readonly span: Span;
}

const BOM = [0xef, 0xbb, 0xbf];
const TOKEN_START = new Set([
	0x2e, 0x3d, 0x2c, 0x5b, 0x5d, 0x7b, 0x7d, 0x20, 0x09, 0x23, 0x0d, 0x0a,
]);
const QUOTE = 0x22;
const APOSTROPHE = 0x27;
const ESCAPE = 0x5c;
const NEWLINE = 0x0a;

export function lex(bytes: Uint8Array): Token[] {
	const tokens: Token[] = [];
	let at =
		bytes[0] === BOM[0] && bytes[1] === BOM[1] && bytes[2] === BOM[2] ? 3 : 0;
	const push = (kind: TokenKind, start: number) =>
		tokens.push({ kind, span: span(start, at) });
	const startsWith = (offset: number, ...sequence: number[]) =>
		sequence.every((b, i) => bytes[offset + i] === b);
	while (at < bytes.length) {
		const start = at;
		const b = bytes[at] as number;
		switch (b) {
			case 0x2e:
			case 0x3d:
			case 0x2c:
			case 0x5b:
			case 0x5d:
			case 0x7b:
			case 0x7d:
				at++;
				push(String.fromCharCode(b) as TokenKind, start);
				break;
			case 0x20:
			case 0x09:
				while (at < bytes.length && (bytes[at] === 0x20 || bytes[at] === 0x09))
					at++;
				push('whitespace', start);
				break;
			case 0x23:
				while (at < bytes.length && bytes[at] !== 0x0d && bytes[at] !== NEWLINE)
					at++;
				push('comment', start);
				break;
			case 0x0d:
				at += bytes[at + 1] === NEWLINE ? 2 : 1;
				push('newline', start);
				break;
			case NEWLINE:
				at++;
				push('newline', start);
				break;
			case APOSTROPHE:
				if (startsWith(at, APOSTROPHE, APOSTROPHE, APOSTROPHE)) {
					at += 3;
					let found = -1;
					for (let i = at; i + 2 < bytes.length + 0; i++) {
						if (
							bytes[i] === APOSTROPHE &&
							bytes[i + 1] === APOSTROPHE &&
							bytes[i + 2] === APOSTROPHE
						) {
							found = i;
							break;
						}
					}
					at = found === -1 ? bytes.length : found + 3;
					if (bytes[at] === APOSTROPHE) {
						at++;
						if (bytes[at] === APOSTROPHE) at++;
					}
					push('mlLiteral', start);
				} else {
					at++;
					while (
						at < bytes.length &&
						bytes[at] !== APOSTROPHE &&
						bytes[at] !== NEWLINE
					)
						at++;
					if (bytes[at] === APOSTROPHE) at++;
					push('literal', start);
				}
				break;
			case QUOTE:
				if (startsWith(at, QUOTE, QUOTE, QUOTE)) {
					at += 3;
					for (;;) {
						let i = at;
						while (
							i < bytes.length &&
							bytes[i] !== ESCAPE &&
							!(
								bytes[i] === QUOTE &&
								bytes[i + 1] === QUOTE &&
								bytes[i + 2] === QUOTE
							)
						)
							i++;
						if (i >= bytes.length) {
							at = bytes.length;
							break;
						}
						if (bytes[i] === QUOTE) {
							at = i + 3;
							break;
						}
						at = i + 1;
						if (bytes[at] === ESCAPE || bytes[at] === QUOTE) at++;
					}
					if (bytes[at] === QUOTE) {
						at++;
						if (bytes[at] === QUOTE) at++;
					}
					push('mlBasic', start);
				} else {
					at++;
					for (;;) {
						let i = at;
						while (
							i < bytes.length &&
							bytes[i] !== QUOTE &&
							bytes[i] !== ESCAPE &&
							bytes[i] !== NEWLINE
						)
							i++;
						if (i >= bytes.length) {
							at = bytes.length;
							break;
						}
						if (bytes[i] === QUOTE) {
							at = i + 1;
							break;
						}
						if (bytes[i] === NEWLINE) {
							at = i;
							break;
						}
						at = i + 1;
						if (bytes[at] === ESCAPE || bytes[at] === QUOTE) at++;
					}
					push('basic', start);
				}
				break;
			default:
				while (at < bytes.length && !TOKEN_START.has(bytes[at] as number)) at++;
				push('atom', start);
		}
	}
	tokens.push({ kind: 'eof', span: span(at, at) });
	return tokens;
}

export function kindDescription(kind: TokenKind): string {
	switch (kind) {
		case 'literal':
			return 'literal string';
		case 'basic':
			return 'basic string';
		case 'mlLiteral':
			return 'multi-line literal string';
		case 'mlBasic':
			return 'multi-line basic string';
		default:
			return kind;
	}
}
