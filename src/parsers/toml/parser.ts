import {
	after,
	append,
	before,
	described,
	failure,
	literal,
	type Span,
} from './errors';
import type { Token, TokenKind } from './lexer';

/**
 * toml_parser 1.1.3's `parser/document.rs`: tokens in, events out, with the
 * crate's `ValidateWhitespace` and `RecursionGuard` (limit 80) applied as
 * each event passes. The first reported error throws.
 *
 * Recovery that follows an error is not transcribed, because it cannot
 * change the answer. What is transcribed exactly is every event a
 * document with no syntax error produces — placeholder keys and scalars
 * included, since the toml crate's own layer is what rejects those.
 */

export type Encoding = 'literal' | 'basic' | 'mlLiteral' | 'mlBasic';

export type EventKind =
	| 'stdTableOpen'
	| 'stdTableClose'
	| 'arrayTableOpen'
	| 'arrayTableClose'
	| 'inlineTableOpen'
	| 'inlineTableClose'
	| 'arrayOpen'
	| 'arrayClose'
	| 'simpleKey'
	| 'keySep'
	| 'keyValSep'
	| 'scalar'
	| 'valueSep'
	| 'whitespace'
	| 'comment'
	| 'newline'
	| 'error';

export interface Event {
	readonly kind: EventKind;
	readonly encoding: Encoding | undefined;
	readonly span: Span;
}

const LIMIT = 80;

const encodingOf = (kind: TokenKind): Encoding | undefined =>
	kind === 'literal' ||
	kind === 'basic' ||
	kind === 'mlLiteral' ||
	kind === 'mlBasic'
		? kind
		: undefined;

const ENCODING_DESCRIPTION: Record<Encoding, string> = {
	literal: 'literal string',
	basic: 'basic string',
	mlLiteral: 'multi-line literal string',
	mlBasic: 'multi-line basic string',
};

export function encodingDescription(encoding: Encoding): string {
	return ENCODING_DESCRIPTION[encoding];
}

class Parser {
	private offset = 0;
	readonly events: Event[] = [];
	private depth = 0;

	constructor(
		private readonly tokens: readonly Token[],
		private readonly bytes: Uint8Array,
	) {}

	// ---- the token stream (winnow's TokenSlice)
	private next(): Token | undefined {
		const token = this.tokens[this.offset];
		if (token !== undefined) this.offset++;
		return token;
	}
	private first(): Token | undefined {
		return this.tokens[this.offset];
	}
	private get(index: number): Token | undefined {
		return this.tokens[this.offset + index];
	}
	private nextIf(predicate: (kind: TokenKind) => boolean): Token | undefined {
		const next = this.first();
		return next !== undefined && predicate(next.kind) ? this.next() : undefined;
	}
	private seekBack(): void {
		this.offset = Math.max(0, this.offset - 1);
	}
	/** The last token before the cursor that is not whitespace, a comment, a newline or the end. */
	private previousSpan(): Span {
		for (let i = this.offset - 1; i >= 0; i--) {
			const token = this.tokens[i] as Token;
			if (!['whitespace', 'comment', 'newline', 'eof'].includes(token.kind))
				return token.span;
		}
		return { start: 0, end: 0 };
	}

	// ---- the receiver chain: RecursionGuard -> ValidateWhitespace -> Vec<Event>
	private emit(kind: EventKind, s: Span, encoding?: Encoding): void {
		this.events.push({ kind, encoding, span: s });
	}
	private whitespace(s: Span): void {
		this.emit('whitespace', s);
	}
	private comment(s: Span): void {
		const raw = this.bytes.subarray(s.start, s.end);
		if (raw[0] !== 0x23)
			throw failure('missing comment start', [literal('#')], {
				start: s.start,
				end: s.start,
			});
		raw.forEach((b, i) => {
			if (!(b === 0x09 || (b >= 0x20 && b <= 0x7e) || b >= 0x80)) {
				throw failure(
					'invalid comment character',
					[described('printable characters')],
					{ start: s.start + i, end: s.start + i },
				);
			}
		});
		this.emit('comment', s);
	}
	private newline(s: Span): void {
		if (s.end - s.start === 1 && this.bytes[s.start] === 0x0d) {
			throw failure(
				'carriage return must be followed by newline',
				[literal('\n')],
				{
					start: s.end,
					end: s.end,
				},
			);
		}
		this.emit('newline', s);
	}
	private open(kind: 'inlineTableOpen' | 'arrayOpen', s: Span): void {
		this.emit(kind, s);
		this.depth++;
		if (this.depth > LIMIT)
			throw failure(
				'cannot recurse further; max recursion depth met',
				undefined,
				s,
			);
	}
	private close(kind: 'inlineTableClose' | 'arrayClose', s: Span): void {
		this.depth--;
		this.emit(kind, s);
	}

	// ---- the grammar
	document(): void {
		for (let token = this.next(); token !== undefined; token = this.next()) {
			switch (token.kind) {
				case '[':
					this.onTable(token);
					break;
				case ']':
					throw failure(
						'missing table open',
						[literal('[')],
						before(token.span),
					);
				case 'literal':
				case 'basic':
				case 'mlLiteral':
				case 'mlBasic':
				case 'atom':
					this.onExpressionKey(token, encodingOf(token.kind));
					break;
				case '=':
					this.emit('simpleKey', before(token.span));
					this.onKeyValSep(token);
					break;
				case '.':
					this.onExpressionDot(token);
					break;
				case ',':
				case '}':
				case '{':
					throw failure(
						'invalid key-value pair',
						[described('key')],
						before(token.span),
					);
				case 'whitespace':
					this.whitespace(token.span);
					break;
				case 'newline':
					this.newline(token.span);
					break;
				case 'comment':
					this.onComment(token);
					break;
				case 'eof':
					this.eof();
					return;
			}
		}
		this.eof();
	}

	private eof(): void {
		const token = this.next();
		if (token === undefined || token.kind === 'eof') return;
		throw failure('unexpected content', [], before(token.span));
	}

	private onTable(open: Token): void {
		const second = this.nextIf((k) => k === '[');
		const isArray = second !== undefined;
		if (second !== undefined)
			this.emit('arrayTableOpen', append(open.span, second.span));
		else this.emit('stdTableOpen', open.span);
		this.optWhitespace();
		const validKey = this.key('invalid table');
		this.optWhitespace();
		const close = this.nextIf((k) => k === ']');
		if (close !== undefined) {
			if (isArray) {
				const secondClose = this.nextIf((k) => k === ']');
				if (secondClose === undefined)
					throw failure(
						'unclosed array table',
						[literal(']')],
						after(close.span),
					);
				this.emit('arrayTableClose', append(close.span, secondClose.span));
			} else {
				this.emit('stdTableClose', close.span);
			}
			this.wsCommentNewline();
			return;
		}
		if (validKey) {
			let last = open;
			for (let i = this.offset - 1; i >= 0; i--) {
				const token = this.tokens[i] as Token;
				if (token.kind !== 'whitespace') {
					last = token;
					break;
				}
			}
			if (isArray)
				throw failure(
					'unclosed array table',
					[literal(']]')],
					after(last.span),
				);
			throw failure('unclosed table', [literal(']')], after(last.span));
		}
		// An invalid key already reported, or returned at a terminator: rust ignores to the newline.
		this.ignoreToNewline();
	}

	private key(invalid: string): boolean {
		for (let token = this.next(); token !== undefined; token = this.next()) {
			switch (token.kind) {
				case ']':
				case 'comment':
				case '=':
				case ',':
				case '[':
				case '{':
				case '}':
				case 'newline':
				case 'eof':
					this.emit('simpleKey', before(token.span));
					this.seekBack();
					return false;
				case 'whitespace':
					this.whitespace(token.span);
					continue;
				case '.':
					this.emit('simpleKey', before(token.span));
					this.emit('keySep', token.span);
					continue;
				default:
					this.emit('simpleKey', token.span, encodingOf(token.kind));
					return this.optDotKeys();
			}
		}
		const previous = this.previousSpan();
		throw failure(invalid, [described('key')], after(previous));
	}

	private onExpressionKey(
		keyToken: Token,
		encoding: Encoding | undefined,
	): void {
		this.emit('simpleKey', keyToken.span, encoding);
		this.optDotKeys();
		this.optWhitespace();
		const eq = this.nextIf((k) => k === '=');
		if (eq === undefined) {
			const peek = this.first();
			if (peek !== undefined)
				throw failure('key with no value', [literal('=')], before(peek.span));
			this.ignoreToNewline();
			return;
		}
		this.onKeyValSep(eq);
	}

	private onExpressionDot(dot: Token): void {
		this.emit('simpleKey', before(dot.span));
		this.seekBack();
		this.optDotKeys();
		this.optWhitespace();
		const eq = this.nextIf((k) => k === '=');
		if (eq === undefined) {
			const peek = this.first();
			if (peek !== undefined)
				throw failure(
					'missing value for key',
					[literal('=')],
					before(peek.span),
				);
			this.ignoreToNewline();
			return;
		}
		this.onKeyValSep(eq);
	}

	private onKeyValSep(eq: Token): void {
		this.emit('keyValSep', eq.span);
		this.optWhitespace();
		this.value();
		this.wsCommentNewline();
	}

	private optDotKeys(): boolean {
		this.optWhitespace();
		let success = true;
		dots: for (
			let dot = this.nextIf((k) => k === '.');
			dot !== undefined;
			dot = this.nextIf((k) => k === '.')
		) {
			this.emit('keySep', dot.span);
			for (let token = this.next(); token !== undefined; token = this.next()) {
				switch (token.kind) {
					case '=':
					case ',':
					case '[':
					case ']':
					case '{':
					case '}':
					case 'comment':
					case 'newline':
					case 'eof':
						this.emit('simpleKey', before(token.span));
						this.seekBack();
						success = false;
						break dots;
					case 'whitespace':
						this.whitespace(token.span);
						continue;
					case '.':
						this.emit('simpleKey', before(token.span));
						this.emit('keySep', token.span);
						continue;
					default:
						this.emit('simpleKey', token.span, encodingOf(token.kind));
						this.optWhitespace();
						continue dots;
				}
			}
			this.emit('simpleKey', after(dot.span));
		}
		return success;
	}

	private value(): void {
		const token = this.next();
		if (token === undefined) {
			throw failure(
				'missing value',
				[described('value')],
				after(this.previousSpan()),
			);
		}
		if (token.kind === '=') throw failure('extra `=`', [], token.span);
		switch (token.kind) {
			case 'comment':
			case ',':
			case 'newline':
			case 'eof':
			case 'whitespace':
				this.emit('scalar', before(token.span));
				this.seekBack();
				return;
			case '{':
				this.onInlineTable(token);
				return;
			case '}':
				throw failure(
					'missing inline table opening',
					[literal('{')],
					before(token.span),
				);
			case '[':
				this.onArray(token);
				return;
			case ']':
				throw failure(
					'missing array opening',
					[literal('[')],
					before(token.span),
				);
			default:
				this.onScalar(token);
				return;
		}
	}

	private onScalar(scalar: Token): void {
		let s = scalar.span;
		const encoding = encodingOf(scalar.kind);
		if (encoding === undefined) {
			for (let next = this.first(); next !== undefined; next = this.first()) {
				if (next.kind === 'whitespace') {
					const second = this.get(1);
					if (second?.kind === 'atom') {
						s = append(s, second.span);
						this.offset += 2;
						continue;
					}
					break;
				}
				if (next.kind === '.' || next.kind === 'atom') {
					s = append(s, next.span);
					this.offset++;
					continue;
				}
				break;
			}
		}
		this.emit('scalar', s, encoding);
	}

	private onArray(openToken: Token): void {
		this.open('arrayOpen', openToken.span);
		let needsValue = true;
		const separate = (token: Token) => {
			if (!needsValue)
				throw failure(
					'missing comma between array elements',
					[literal(',')],
					before(token.span),
				);
		};
		for (let token = this.next(); token !== undefined; token = this.next()) {
			switch (token.kind) {
				case 'comment':
					this.onComment(token);
					break;
				case 'whitespace':
					this.whitespace(token.span);
					break;
				case 'newline':
					this.newline(token.span);
					break;
				case 'eof':
					throw failure(
						'unclosed array',
						[literal(']')],
						after(this.previousSpan()),
					);
				case ',':
					if (needsValue)
						throw failure(
							'extra comma in array',
							[described('value')],
							token.span,
						);
					this.emit('valueSep', token.span);
					needsValue = true;
					break;
				case '=':
					throw failure(
						'unexpected `=` in array',
						[described('value'), literal(']')],
						token.span,
					);
				case '{':
					separate(token);
					this.onInlineTable(token);
					needsValue = false;
					break;
				case '}':
					separate(token);
					throw failure(
						'missing inline table opening',
						[literal('{')],
						before(token.span),
					);
				case '[':
					separate(token);
					this.onArray(token);
					needsValue = false;
					break;
				case ']':
					this.close('arrayClose', token.span);
					return;
				default:
					separate(token);
					this.onScalar(token);
					needsValue = false;
			}
		}
		throw failure('unclosed array', [literal(']')], after(this.previousSpan()));
	}

	private onInlineTable(openToken: Token): void {
		this.open('inlineTableOpen', openToken.span);
		type State = 'key' | 'equals' | 'value' | 'comma';
		let state = 'key' as State;
		const expected = (st: State) =>
			st === 'key'
				? [described('key')]
				: st === 'equals'
					? [literal('=')]
					: st === 'value'
						? [described('value')]
						: [literal(',')];
		const keyStart = (token: Token): State => {
			if (token.kind === '.') {
				this.emit('simpleKey', before(token.span), encodingOf(token.kind));
				this.seekBack();
			} else {
				this.emit('simpleKey', token.span, encodingOf(token.kind));
			}
			this.optDotKeys();
			return 'equals';
		};
		/** A nested value where a value or a key belongs: refused unless a value is due. */
		const nestedOpen = (token: Token, current: State): void => {
			if (current === 'key' || current === 'comma')
				throw failure(
					'missing key for inline table element',
					expected(current),
					before(token.span),
				);
			if (current === 'equals')
				throw failure(
					'missing assignment between key-value pairs',
					expected(current),
					before(token.span),
				);
		};
		for (let token = this.next(); token !== undefined; token = this.next()) {
			const current: State = state;
			switch (token.kind) {
				case 'comment':
					this.onComment(token);
					break;
				case 'whitespace':
					this.whitespace(token.span);
					break;
				case 'newline':
					this.newline(token.span);
					break;
				case 'eof':
					throw failure(
						'unclosed inline table',
						[literal('}')],
						after(this.previousSpan()),
					);
				case ',':
					if (current !== 'comma')
						throw failure(
							'extra comma in inline table',
							expected(current),
							before(token.span),
						);
					this.emit('valueSep', token.span);
					state = 'key';
					break;
				case '=':
					if (current === 'value' || current === 'comma')
						throw failure(
							'extra assignment between key-value pairs',
							expected(current),
							before(token.span),
						);
					if (current === 'key') this.emit('simpleKey', before(token.span));
					this.emit('keyValSep', token.span);
					state = 'value';
					break;
				case '{':
					nestedOpen(token, current);
					this.onInlineTable(token);
					state = 'comma';
					break;
				case '}':
					if (current === 'equals') this.emit('keyValSep', before(token.span));
					if (current === 'equals' || current === 'value')
						this.emit('scalar', before(token.span), 'literal');
					this.close('inlineTableClose', token.span);
					return;
				case '[':
					nestedOpen(token, current);
					this.onArray(token);
					state = 'comma';
					break;
				case ']':
					if (current === 'value')
						throw failure(
							'missing array opening',
							[literal('[')],
							before(token.span),
						);
					throw failure(
						'invalid inline table element',
						expected(current),
						before(token.span),
					);
				default:
					if (current === 'equals')
						throw failure(
							'missing assignment between key-value pairs',
							expected(current),
							before(token.span),
						);
					if (current === 'comma')
						throw failure(
							'missing comma between key-value pairs',
							expected(current),
							before(token.span),
						);
					if (current === 'key') {
						state = keyStart(token);
					} else {
						this.onScalar(token);
						state = 'comma';
					}
			}
		}
		throw failure(
			'unclosed inline table',
			[literal('}')],
			after(this.previousSpan()),
		);
	}

	private optWhitespace(): void {
		const ws = this.nextIf((k) => k === 'whitespace');
		if (ws !== undefined) this.whitespace(ws.span);
	}

	private wsCommentNewline(): void {
		for (let token = this.next(); token !== undefined; token = this.next()) {
			switch (token.kind) {
				case 'comment':
					this.onComment(token);
					return;
				case 'whitespace':
					this.whitespace(token.span);
					continue;
				case 'newline':
					this.newline(token.span);
					return;
				case 'eof':
					return;
				default:
					throw failure(
						'unexpected key or value',
						[literal('\n'), literal('#')],
						before(token.span),
					);
			}
		}
	}

	private onComment(commentToken: Token): void {
		this.comment(commentToken.span);
		const token = this.next();
		if (token === undefined || token.kind === 'eof') return;
		if (token.kind === 'newline') {
			this.newline(token.span);
			return;
		}
		throw failure(
			'unexpected content between comment and newline',
			[literal('\n')],
			before(token.span),
		);
	}

	/** Reached only after a key that returned at a terminator without reporting. */
	private ignoreToNewline(): void {
		for (let token = this.next(); token !== undefined; token = this.next()) {
			switch (token.kind) {
				case 'comment':
					this.onComment(token);
					return;
				case 'whitespace':
					this.whitespace(token.span);
					break;
				case 'newline':
					this.newline(token.span);
					return;
				case 'eof':
					return;
				default:
					this.emit('error', token.span);
			}
		}
	}
}

/** Every event of a document, or the first syntax error, thrown. */
export function parseEvents(
	tokens: readonly Token[],
	bytes: Uint8Array,
): Event[] {
	const parser = new Parser(tokens, bytes);
	parser.document();
	return parser.events;
}
