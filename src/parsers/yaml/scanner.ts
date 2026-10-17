/**
 * saphyr-parser 0.1.0's scanner (`scanner.rs`), transcribed. The crate reads
 * a document through `BufferedInput` over `str::chars`, which is a window on
 * the code points padded with `'\0'` past the end — so a `'\0'` in the text
 * ends the stream exactly as the end does, and this reads it the same way.
 *
 * Markers count characters (code points), as saphyr's do: `index` is the
 * character offset, `line` is 1-based and `col` 0-based.
 */

export interface Marker {
	index: number;
	line: number;
	col: number;
}

export interface Span {
	readonly start: Marker;
	readonly end: Marker;
}

export type ScalarStyle = 'plain' | 'single' | 'double' | 'literal' | 'folded';

export type TokenType =
	| { readonly t: 'StreamStart' }
	| { readonly t: 'StreamEnd' }
	| { readonly t: 'VersionDirective' }
	| {
			readonly t: 'TagDirective';
			readonly handle: string;
			readonly prefix: string;
	  }
	| { readonly t: 'ReservedDirective' }
	| { readonly t: 'DocumentStart' }
	| { readonly t: 'DocumentEnd' }
	| { readonly t: 'BlockSequenceStart' }
	| { readonly t: 'BlockMappingStart' }
	| { readonly t: 'BlockEnd' }
	| { readonly t: 'FlowSequenceStart' }
	| { readonly t: 'FlowSequenceEnd' }
	| { readonly t: 'FlowMappingStart' }
	| { readonly t: 'FlowMappingEnd' }
	| { readonly t: 'BlockEntry' }
	| { readonly t: 'FlowEntry' }
	| { readonly t: 'Key' }
	| { readonly t: 'Value' }
	| { readonly t: 'Alias'; readonly name: string }
	| { readonly t: 'Anchor'; readonly name: string }
	| { readonly t: 'Tag'; readonly handle: string; readonly suffix: string }
	| {
			readonly t: 'Scalar';
			readonly style: ScalarStyle;
			readonly value: string;
	  };

export interface Token {
	readonly span: Span;
	readonly type: TokenType;
}

/** `ScanError`, whose Display is `{info} at byte {index} line {line} column {col + 1}`. */
export class ScanError extends Error {
	constructor(
		readonly mark: Marker,
		readonly info: string,
	) {
		super(
			`${info} at byte ${mark.index} line ${mark.line} column ${mark.col + 1}`,
		);
	}
}

/**
 * Raised where saphyr would read `'\0'` padding forever. A directive that
 * runs to the very end of the input (`%YAML` with no line break) makes
 * `fetch_while_is_yaml_non_space` loop without end in the crate, because
 * `is_yaml_non_space('\0')` is true; this stops instead of hanging.
 */
export class UnboundedScan extends Error {}

// ------------------------------------------------------------ char_traits

const isZ = (c: string) => c === '\0';
const isBreak = (c: string) => c === '\n' || c === '\r';
const isBreakz = (c: string) => isBreak(c) || isZ(c);
const isBlank = (c: string) => c === ' ' || c === '\t';
export const isBlankOrBreakz = (c: string) => isBlank(c) || isBreakz(c);
const isDigit = (c: string) => c >= '0' && c <= '9';
const isAlpha = (c: string) => /^[0-9a-zA-Z_-]$/.test(c);
const isHex = (c: string) => /^[0-9a-fA-F]$/.test(c);
const asHex = (c: string) => Number.parseInt(c, 16);
export const isFlow = (c: string) =>
	c === ',' || c === '[' || c === ']' || c === '{' || c === '}';
const isBom = (c: string) => c === '﻿';
const isYamlNonBreak = (c: string) => !isBreak(c) && !isBom(c);
const isYamlNonSpace = (c: string) => isYamlNonBreak(c) && !isBlank(c);
const isAnchorChar = (c: string) => isYamlNonSpace(c) && !isFlow(c) && !isZ(c);
const isWordChar = (c: string) => isAlpha(c) && c !== '_';
const isUriChar = (c: string) =>
	isWordChar(c) || (c.length > 0 && "#;/?:@&=+$,_.!~*'()[]%".includes(c));
const isTagChar = (c: string) => isUriChar(c) && !isFlow(c) && c !== '!';

// ------------------------------------------------------------------ input

type SkipTabs =
	| 'yes'
	| 'no'
	| { readonly foundTabs: boolean; readonly hasYamlWs: boolean };

/** `BufferedInput`: the characters, and `'\0'` for every read past the end. */
class Input {
	private pos = 0;

	constructor(private readonly chars: readonly string[]) {}

	peek(): string {
		return this.peekNth(0);
	}

	peekNth(n: number): string {
		const at = this.pos + n;
		if (at > this.chars.length + 64) throw new UnboundedScan();
		return this.chars[at] ?? '\0';
	}

	skip(): void {
		this.pos++;
	}

	skipN(count: number): void {
		this.pos += count;
	}

	next2Are(a: string, b: string): boolean {
		return this.peek() === a && this.peekNth(1) === b;
	}

	next3Are(a: string, b: string, c: string): boolean {
		return this.peek() === a && this.peekNth(1) === b && this.peekNth(2) === c;
	}

	nextIsDocumentIndicator(): boolean {
		return (
			isBlankOrBreakz(this.peekNth(3)) &&
			(this.next3Are('.', '.', '.') || this.next3Are('-', '-', '-'))
		);
	}

	nextIsDocumentStart(): boolean {
		return this.next3Are('-', '-', '-') && isBlankOrBreakz(this.peekNth(3));
	}

	nextIsDocumentEnd(): boolean {
		return this.next3Are('.', '.', '.') && isBlankOrBreakz(this.peekNth(3));
	}

	/** Returns the characters consumed and the outcome, an error message or the tab/space flags. */
	skipWsToEol(skipTabs: SkipTabs): [number, string | SkipTabs] {
		let encounteredTab = false;
		let hasYamlWs = false;
		let consumed = 0;
		for (;;) {
			const c = this.peek();
			if (c === ' ') {
				hasYamlWs = true;
				this.skip();
			} else if (c === '\t' && skipTabs !== 'no') {
				encounteredTab = true;
				this.skip();
			} else if (c === '#' && !encounteredTab && !hasYamlWs) {
				return [
					consumed,
					'comments must be separated from other tokens by whitespace',
				];
			} else if (c === '#') {
				this.skip();
				while (!isBreakz(this.peek())) {
					this.skip();
					consumed++;
				}
			} else {
				break;
			}
			consumed++;
		}
		return [consumed, { foundTabs: encounteredTab, hasYamlWs }];
	}

	nextCanBePlainScalar(inFlow: boolean): boolean {
		const nc = this.peekNth(1);
		const c = this.peek();
		if (c === ':' && (isBlankOrBreakz(nc) || (inFlow && isFlow(nc))))
			return false;
		if (inFlow && isFlow(c)) return false;
		return true;
	}

	nextIsBlankOrBreak(): boolean {
		return isBlank(this.peek()) || isBreak(this.peek());
	}

	nextIsBlankOrBreakz(): boolean {
		return isBlank(this.peek()) || isBreakz(this.peek());
	}

	nextIsBlank(): boolean {
		return isBlank(this.peek());
	}

	nextIsBreak(): boolean {
		return isBreak(this.peek());
	}

	nextIsBreakz(): boolean {
		return isBreakz(this.peek());
	}

	nextIsZ(): boolean {
		return isZ(this.peek());
	}

	nextIsFlow(): boolean {
		return isFlow(this.peek());
	}

	nextIsDigit(): boolean {
		return isDigit(this.peek());
	}

	nextIsAlpha(): boolean {
		return isAlpha(this.peek());
	}

	skipWhileNonBreakz(): number {
		let count = 0;
		while (!isBreakz(this.peek())) {
			count++;
			this.skip();
		}
		return count;
	}

	skipWhileBlank(): number {
		let count = 0;
		while (isBlank(this.peek())) {
			count++;
			this.skip();
		}
		return count;
	}

	fetchWhileIsAlpha(out: string[]): number {
		let count = 0;
		while (isAlpha(this.peek())) {
			count++;
			out.push(this.peek());
			this.skip();
		}
		return count;
	}

	fetchWhileIsYamlNonSpace(out: string[]): number {
		let count = 0;
		while (isYamlNonSpace(this.peek())) {
			count++;
			out.push(this.peek());
			this.skip();
		}
		return count;
	}
}

// ---------------------------------------------------------------- scanner

interface SimpleKey {
	possible: boolean;
	required: boolean;
	tokenNumber: number;
	mark: Marker;
}

interface Indent {
	readonly indent: number;
	readonly needsBlockEnd: boolean;
}

type ImplicitMappingState = 'possible' | 'inside';
type Chomping = 'strip' | 'clip' | 'keep';

const copy = (mark: Marker): Marker => ({
	index: mark.index,
	line: mark.line,
	col: mark.col,
});
const emptySpan = (mark: Marker): Span => ({
	start: copy(mark),
	end: copy(mark),
});
const span = (start: Marker, end: Marker): Span => ({
	start: copy(start),
	end: copy(end),
});
const newSimpleKey = (mark: Marker): SimpleKey => ({
	possible: false,
	required: false,
	tokenNumber: 0,
	mark: copy(mark),
});

export class Scanner {
	private readonly input: Input;
	mark: Marker = { index: 0, line: 1, col: 0 };
	private readonly tokens: Token[] = [];
	private error: ScanError | undefined;
	streamStartProduced = false;
	streamEndProduced = false;
	private adjacentValueAllowedAt = 0;
	private simpleKeyAllowed = true;
	private readonly simpleKeys: SimpleKey[] = [];
	private indent = -1;
	private readonly indents: Indent[] = [];
	private flowLevel = 0;
	private tokensParsed = 0;
	private tokenAvailable = false;
	private leadingWhitespace = true;
	private flowMappingStarted = false;
	private readonly implicitFlowMappingStates: ImplicitMappingState[] = [];
	private interruptedPlainByComment: Marker | undefined;
	private bufLeadingBreak = '';
	private bufTrailingBreaks = '';
	private bufWhitespaces = '';

	constructor(text: string) {
		this.input = new Input(Array.from(text));
	}

	getError(): ScanError | undefined {
		return this.error;
	}

	/** `Iterator::next`: a token, or nothing once the stream ended or an error was stored. */
	next(): Token | undefined {
		if (this.error !== undefined) return undefined;
		try {
			return this.nextToken();
		} catch (error) {
			if (error instanceof ScanError) {
				this.error = error;
				return undefined;
			}
			throw error;
		}
	}

	private err(mark: Marker, info: string): ScanError {
		return new ScanError(copy(mark), info);
	}

	private skipBlank(): void {
		this.input.skip();
		this.mark.index++;
		this.mark.col++;
	}

	private skipNonBlank(): void {
		this.input.skip();
		this.mark.index++;
		this.mark.col++;
		this.leadingWhitespace = false;
	}

	private skipNNonBlank(count: number): void {
		this.input.skipN(count);
		this.mark.index += count;
		this.mark.col += count;
		this.leadingWhitespace = false;
	}

	private skipNl(): void {
		this.input.skip();
		this.mark.index++;
		this.mark.col = 0;
		this.mark.line++;
		this.leadingWhitespace = true;
	}

	private skipLinebreak(): void {
		if (this.input.next2Are('\r', '\n')) {
			this.skipBlank();
			this.skipNl();
		} else if (this.input.nextIsBreak()) {
			this.skipNl();
		}
	}

	private readBreak(): string {
		this.skipBreak();
		return '\n';
	}

	private skipBreak(): void {
		const c = this.input.peek();
		const nc = this.input.peekNth(1);
		if (c === '\r' && nc === '\n') this.skipBlank();
		this.skipNl();
	}

	private insertToken(pos: number, token: Token): void {
		this.tokens.splice(pos, 0, token);
	}

	private fetchNextToken(): void {
		if (!this.streamStartProduced) {
			this.fetchStreamStart();
			return;
		}
		this.skipToNextToken();
		this.staleSimpleKeys();
		const mark = copy(this.mark);
		this.unrollIndent(mark.col);
		if (this.input.nextIsZ()) {
			this.fetchStreamEnd();
			return;
		}
		if (this.mark.col === 0) {
			if (this.input.peek() === '%') {
				this.fetchDirective();
				return;
			}
			if (this.input.nextIsDocumentStart()) {
				this.fetchDocumentIndicator({ t: 'DocumentStart' });
				return;
			}
			if (this.input.nextIsDocumentEnd()) {
				this.fetchDocumentIndicator({ t: 'DocumentEnd' });
				this.skipWsToEol('yes');
				if (!this.input.nextIsBreakz())
					throw this.err(
						this.mark,
						'invalid content after document end marker',
					);
				return;
			}
		}
		if (this.mark.col < this.indent)
			throw this.err(this.mark, 'invalid indentation');
		const c = this.input.peek();
		const nc = this.input.peekNth(1);
		if (c === '[') {
			this.fetchFlowCollectionStart({ t: 'FlowSequenceStart' });
			return;
		}
		if (c === '{') {
			this.fetchFlowCollectionStart({ t: 'FlowMappingStart' });
			return;
		}
		if (c === ']') {
			this.fetchFlowCollectionEnd({ t: 'FlowSequenceEnd' });
			return;
		}
		if (c === '}') {
			this.fetchFlowCollectionEnd({ t: 'FlowMappingEnd' });
			return;
		}
		if (c === ',') {
			this.fetchFlowEntry();
			return;
		}
		if (c === '-' && isBlankOrBreakz(nc)) {
			this.fetchBlockEntry();
			return;
		}
		if (c === '?' && isBlankOrBreakz(nc)) {
			this.fetchKey();
			return;
		}
		if (c === ':' && isBlankOrBreakz(nc)) {
			this.fetchValue();
			return;
		}
		if (
			c === ':' &&
			this.flowLevel > 0 &&
			(isFlow(nc) || this.mark.index === this.adjacentValueAllowedAt)
		) {
			this.fetchFlowValue();
			return;
		}
		if (c === '*') {
			this.fetchAnchor(true);
			return;
		}
		if (c === '&') {
			this.fetchAnchor(false);
			return;
		}
		if (c === '!') {
			this.fetchTag();
			return;
		}
		if (c === '|' && this.flowLevel === 0) {
			this.fetchBlockScalar(true);
			return;
		}
		if (c === '>' && this.flowLevel === 0) {
			this.fetchBlockScalar(false);
			return;
		}
		if (c === "'") {
			this.fetchFlowScalar(true);
			return;
		}
		if (c === '"') {
			this.fetchFlowScalar(false);
			return;
		}
		if (c === '-' && !isBlankOrBreakz(nc)) {
			this.fetchPlainScalar();
			return;
		}
		if (
			(c === ':' || c === '?') &&
			!isBlankOrBreakz(nc) &&
			this.flowLevel === 0
		) {
			this.fetchPlainScalar();
			return;
		}
		if (c === '%' || c === '@' || c === '`')
			throw this.err(this.mark, `unexpected character: \`${c}'`);
		this.fetchPlainScalar();
		return;
	}

	private nextToken(): Token | undefined {
		if (this.streamEndProduced) return undefined;
		if (!this.tokenAvailable) this.fetchMoreTokens();
		const token = this.tokens.shift();
		if (token === undefined)
			throw this.err(this.mark, 'did not find expected next token');
		this.tokenAvailable = false;
		this.tokensParsed++;
		if (token.type.t === 'StreamEnd') this.streamEndProduced = true;
		return token;
	}

	private fetchMoreTokens(): void {
		for (;;) {
			let needMore: boolean;
			if (this.tokens.length === 0) {
				needMore = true;
			} else {
				needMore = false;
				this.staleSimpleKeys();
				for (const key of this.simpleKeys) {
					if (key.possible && key.tokenNumber === this.tokensParsed) {
						needMore = true;
						break;
					}
				}
			}
			if (!needMore) break;
			this.fetchNextToken();
		}
		this.tokenAvailable = true;
	}

	private staleSimpleKeys(): void {
		for (const key of this.simpleKeys) {
			if (
				key.possible &&
				this.flowLevel === 0 &&
				(key.mark.line < this.mark.line ||
					key.mark.index + 1024 < this.mark.index)
			) {
				if (key.required) throw this.err(this.mark, "simple key expect ':'");
				key.possible = false;
			}
		}
	}

	private skipToNextToken(): void {
		for (;;) {
			const c = this.input.peek();
			if (
				c === '\t' &&
				this.isWithinBlock() &&
				this.leadingWhitespace &&
				this.mark.col < this.indent
			) {
				this.skipWsToEol('yes');
				if (!this.input.nextIsBreakz()) {
					throw this.err(
						this.mark,
						'tabs disallowed within this context (block indentation)',
					);
				}
			} else if (c === '\t' || c === ' ') {
				this.skipBlank();
			} else if (c === '\n' || c === '\r') {
				this.skipLinebreak();
				if (this.flowLevel === 0) this.simpleKeyAllowed = true;
			} else if (c === '#') {
				const length = this.input.skipWhileNonBreakz();
				this.mark.index += length;
				this.mark.col += length;
			} else {
				break;
			}
		}
		const errMark = this.interruptedPlainByComment;
		this.interruptedPlainByComment = undefined;
		if (errMark !== undefined) {
			const isImmediateNextLine = this.mark.line === errMark.line + 1;
			if (
				this.flowLevel === 0 &&
				isImmediateNextLine &&
				this.mark.col > this.indent &&
				!this.input.nextIsZ() &&
				!this.input.nextIsDocumentIndicator() &&
				this.input.nextCanBePlainScalar(false)
			) {
				throw this.err(errMark, 'comment intercepting the multiline text');
			}
		}
	}

	private skipYamlWhitespace(): void {
		let needWhitespace = true;
		for (;;) {
			const c = this.input.peek();
			if (c === ' ') {
				this.skipBlank();
				needWhitespace = false;
			} else if (c === '\n' || c === '\r') {
				this.skipLinebreak();
				if (this.flowLevel === 0) this.simpleKeyAllowed = true;
				needWhitespace = false;
			} else if (c === '#') {
				const length = this.input.skipWhileNonBreakz();
				this.mark.index += length;
				this.mark.col += length;
			} else {
				break;
			}
		}
		if (needWhitespace) throw this.err(this.mark, 'expected whitespace');
	}

	private skipWsToEol(skipTabs: SkipTabs): SkipTabs {
		const [count, result] = this.input.skipWsToEol(skipTabs);
		this.mark.col += count;
		this.mark.index += count;
		if (typeof result === 'string') throw this.err(this.mark, result);
		return result;
	}

	private fetchStreamStart(): void {
		const mark = copy(this.mark);
		this.indent = -1;
		this.streamStartProduced = true;
		this.simpleKeyAllowed = true;
		this.tokens.push({ span: emptySpan(mark), type: { t: 'StreamStart' } });
		this.simpleKeys.push(newSimpleKey({ index: 0, line: 0, col: 0 }));
	}

	private fetchStreamEnd(): void {
		if (this.mark.col !== 0) {
			this.mark.col = 0;
			this.mark.line++;
		}
		for (const key of this.simpleKeys) {
			if (key.required && key.possible)
				throw this.err(this.mark, 'simple key expected');
			key.possible = false;
		}
		this.unrollIndent(-1);
		this.removeSimpleKey();
		this.simpleKeyAllowed = false;
		this.tokens.push({ span: emptySpan(this.mark), type: { t: 'StreamEnd' } });
	}

	private fetchDirective(): void {
		this.unrollIndent(-1);
		this.removeSimpleKey();
		this.simpleKeyAllowed = false;
		this.tokens.push(this.scanDirective());
	}

	private scanDirective(): Token {
		const startMark = copy(this.mark);
		this.skipNonBlank();
		const name = this.scanDirectiveName();
		let token: Token;
		if (name === 'YAML') {
			token = this.scanVersionDirectiveValue(startMark);
		} else if (name === 'TAG') {
			token = this.scanTagDirectiveValue(startMark);
		} else {
			while (this.input.nextIsBlank()) {
				const blanks = this.input.skipWhileBlank();
				this.mark.index += blanks;
				this.mark.col += blanks;
				if (!isBlankOrBreakz(this.input.peek())) {
					const count = this.input.fetchWhileIsYamlNonSpace([]);
					this.mark.index += count;
					this.mark.col += count;
				}
			}
			token = {
				span: span(startMark, this.mark),
				type: { t: 'ReservedDirective' },
			};
		}
		this.skipWsToEol('yes');
		if (this.input.nextIsBreakz()) {
			this.skipLinebreak();
			return token;
		}
		throw this.err(
			startMark,
			'while scanning a directive, did not find expected comment or line break',
		);
	}

	private scanVersionDirectiveValue(mark: Marker): Token {
		const blanks = this.input.skipWhileBlank();
		this.mark.index += blanks;
		this.mark.col += blanks;
		this.scanVersionDirectiveNumber(mark);
		if (this.input.peek() !== '.') {
			throw this.err(
				mark,
				"while scanning a YAML directive, did not find expected digit or '.' character",
			);
		}
		this.skipNonBlank();
		this.scanVersionDirectiveNumber(mark);
		return { span: span(mark, this.mark), type: { t: 'VersionDirective' } };
	}

	private scanDirectiveName(): string {
		const startMark = copy(this.mark);
		const out: string[] = [];
		const count = this.input.fetchWhileIsYamlNonSpace(out);
		this.mark.index += count;
		this.mark.col += count;
		if (out.length === 0)
			throw this.err(
				startMark,
				'while scanning a directive, could not find expected directive name',
			);
		if (!isBlankOrBreakz(this.input.peek())) {
			throw this.err(
				startMark,
				'while scanning a directive, found unexpected non-alphabetical character',
			);
		}
		return out.join('');
	}

	private scanVersionDirectiveNumber(mark: Marker): void {
		let length = 0;
		// `char::to_digit(10)` reads ASCII digits only.
		while (isDigit(this.input.peek())) {
			if (length + 1 > 9)
				throw this.err(
					mark,
					'while scanning a YAML directive, found extremely long version number',
				);
			length++;
			this.skipNonBlank();
		}
		if (length === 0)
			throw this.err(
				mark,
				'while scanning a YAML directive, did not find expected version number',
			);
	}

	private scanTagDirectiveValue(mark: Marker): Token {
		let blanks = this.input.skipWhileBlank();
		this.mark.index += blanks;
		this.mark.col += blanks;
		const handle = this.scanTagHandle(true, mark);
		blanks = this.input.skipWhileBlank();
		this.mark.index += blanks;
		this.mark.col += blanks;
		const prefix = this.scanTagPrefix(mark);
		if (this.input.nextIsBlankOrBreakz()) {
			return {
				span: span(mark, this.mark),
				type: { t: 'TagDirective', handle, prefix },
			};
		}
		throw this.err(
			mark,
			'while scanning TAG, did not find expected whitespace or line break',
		);
	}

	private fetchTag(): void {
		this.saveSimpleKey();
		this.simpleKeyAllowed = false;
		this.tokens.push(this.scanTag());
	}

	private scanTag(): Token {
		const startMark = copy(this.mark);
		let handle = '';
		let suffix: string;
		if (this.input.peekNth(1) === '<') {
			suffix = this.scanVerbatimTag(startMark);
		} else {
			handle = this.scanTagHandle(false, startMark);
			if (
				handle.length >= 2 &&
				handle.startsWith('!') &&
				handle.endsWith('!')
			) {
				suffix = this.scanTagShorthandSuffix('', startMark);
			} else {
				suffix = this.scanTagShorthandSuffix(handle, startMark);
				handle = '!';
				if (suffix === '') {
					handle = '';
					suffix = '!';
				}
			}
		}
		if (
			isBlankOrBreakz(this.input.peek()) ||
			(this.flowLevel > 0 && this.input.nextIsFlow())
		) {
			return {
				span: span(startMark, this.mark),
				type: { t: 'Tag', handle, suffix },
			};
		}
		throw this.err(
			startMark,
			'while scanning a tag, did not find expected whitespace or line break',
		);
	}

	private scanTagHandle(directive: boolean, mark: Marker): string {
		if (this.input.peek() !== '!')
			throw this.err(mark, "while scanning a tag, did not find expected '!'");
		const out: string[] = [this.input.peek()];
		this.skipNonBlank();
		const count = this.input.fetchWhileIsAlpha(out);
		this.mark.index += count;
		this.mark.col += count;
		if (this.input.peek() === '!') {
			out.push(this.input.peek());
			this.skipNonBlank();
		} else if (directive && out.join('') !== '!') {
			throw this.err(
				mark,
				"while parsing a tag directive, did not find expected '!'",
			);
		}
		return out.join('');
	}

	private scanTagPrefix(startMark: Marker): string {
		let out = '';
		if (this.input.peek() === '!') {
			out += this.input.peek();
			this.skipNonBlank();
		} else if (!isTagChar(this.input.peek())) {
			throw this.err(startMark, 'invalid global tag character');
		} else if (this.input.peek() === '%') {
			out += this.scanUriEscapes(startMark);
		} else {
			out += this.input.peek();
			this.skipNonBlank();
		}
		while (isUriChar(this.input.peek())) {
			if (this.input.peek() === '%') {
				out += this.scanUriEscapes(startMark);
			} else {
				out += this.input.peek();
				this.skipNonBlank();
			}
		}
		return out;
	}

	private scanVerbatimTag(startMark: Marker): string {
		this.skipNonBlank();
		this.skipNonBlank();
		let out = '';
		while (isUriChar(this.input.peek())) {
			if (this.input.peek() === '%') {
				out += this.scanUriEscapes(startMark);
			} else {
				out += this.input.peek();
				this.skipNonBlank();
			}
		}
		if (this.input.peek() !== '>') {
			throw this.err(
				startMark,
				"while scanning a verbatim tag, did not find the expected '>'",
			);
		}
		this.skipNonBlank();
		return out;
	}

	private scanTagShorthandSuffix(head: string, mark: Marker): string {
		// `head.len()` is bytes, and a handle is `!` and ASCII word characters, so bytes and units agree.
		let length = head.length;
		let out = length > 1 ? head.slice(1) : '';
		while (isTagChar(this.input.peek())) {
			if (this.input.peek() === '%') {
				out += this.scanUriEscapes(mark);
			} else {
				out += this.input.peek();
				this.skipNonBlank();
			}
			length++;
		}
		if (length === 0)
			throw this.err(
				mark,
				'while parsing a tag, did not find expected tag URI',
			);
		return out;
	}

	private scanUriEscapes(mark: Marker): string {
		let width = 0;
		let code = 0;
		for (;;) {
			const c = this.input.peekNth(1);
			const nc = this.input.peekNth(2);
			if (!(this.input.peek() === '%' && isHex(c) && isHex(nc))) {
				throw this.err(
					mark,
					'while parsing a tag, found an invalid escape sequence',
				);
			}
			const byte = (asHex(c) << 4) + asHex(nc);
			if (width === 0) {
				if ((byte & 0x80) === 0x00) width = 1;
				else if ((byte & 0xe0) === 0xc0) width = 2;
				else if ((byte & 0xf0) === 0xe0) width = 3;
				else if ((byte & 0xf8) === 0xf0) width = 4;
				else
					throw this.err(
						mark,
						'while parsing a tag, found an incorrect leading UTF-8 byte',
					);
				code = byte;
			} else {
				if ((byte & 0xc0) !== 0x80)
					throw this.err(
						mark,
						'while parsing a tag, found an incorrect trailing UTF-8 byte',
					);
				// u32 arithmetic: a four-byte sequence shifts its lead byte past 2^24.
				code = ((code << 8) >>> 0) + byte;
			}
			this.skipNNonBlank(3);
			width--;
			if (width === 0) break;
		}
		// `char::from_u32` of the raw bytes, not of a decoded code point.
		if (code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) {
			throw this.err(
				mark,
				'while parsing a tag, found an invalid UTF-8 codepoint',
			);
		}
		return String.fromCodePoint(code);
	}

	private fetchAnchor(alias: boolean): void {
		this.saveSimpleKey();
		this.simpleKeyAllowed = false;
		this.tokens.push(this.scanAnchor(alias));
	}

	private scanAnchor(alias: boolean): Token {
		let out = '';
		const startMark = copy(this.mark);
		this.skipNonBlank();
		while (isAnchorChar(this.input.peek())) {
			out += this.input.peek();
			this.skipNonBlank();
		}
		if (out === '') {
			throw this.err(
				startMark,
				'while scanning an anchor or alias, did not find expected alphabetic or numeric character',
			);
		}
		return {
			span: span(startMark, this.mark),
			type: alias ? { t: 'Alias', name: out } : { t: 'Anchor', name: out },
		};
	}

	private fetchFlowCollectionStart(type: TokenType): void {
		this.saveSimpleKey();
		this.rollOneColIndent();
		this.increaseFlowLevel();
		this.simpleKeyAllowed = true;
		const startMark = copy(this.mark);
		this.skipNonBlank();
		if (type.t === 'FlowMappingStart') this.flowMappingStarted = true;
		else this.implicitFlowMappingStates.push('possible');
		this.skipWsToEol('yes');
		this.tokens.push({ span: span(startMark, this.mark), type });
	}

	private fetchFlowCollectionEnd(type: TokenType): void {
		if (this.flowLevel === 0) throw this.err(this.mark, 'misplaced bracket');
		this.removeSimpleKey();
		this.decreaseFlowLevel();
		this.simpleKeyAllowed = false;
		if (type.t === 'FlowSequenceEnd') {
			this.endImplicitMapping(this.mark);
			this.implicitFlowMappingStates.pop();
		}
		const startMark = copy(this.mark);
		this.skipNonBlank();
		this.skipWsToEol('yes');
		if (this.flowLevel > 0) this.adjacentValueAllowedAt = this.mark.index;
		this.tokens.push({ span: span(startMark, this.mark), type });
	}

	private fetchFlowEntry(): void {
		this.removeSimpleKey();
		this.simpleKeyAllowed = true;
		this.endImplicitMapping(this.mark);
		const startMark = copy(this.mark);
		this.skipNonBlank();
		this.skipWsToEol('yes');
		this.tokens.push({
			span: span(startMark, this.mark),
			type: { t: 'FlowEntry' },
		});
	}

	private increaseFlowLevel(): void {
		this.simpleKeys.push(newSimpleKey({ index: 0, line: 0, col: 0 }));
		// flow_level is a u8.
		if (this.flowLevel === 255)
			throw this.err(this.mark, 'recursion limit exceeded');
		this.flowLevel++;
	}

	private decreaseFlowLevel(): void {
		if (this.flowLevel > 0) {
			this.flowLevel--;
			this.simpleKeys.pop();
		}
	}

	private fetchBlockEntry(): void {
		if (this.flowLevel > 0)
			throw this.err(this.mark, '"-" is only valid inside a block');
		if (!this.simpleKeyAllowed)
			throw this.err(
				this.mark,
				'block sequence entries are not allowed in this context',
			);
		const back = this.tokens.at(-1);
		if (
			back !== undefined &&
			(back.type.t === 'Anchor' || back.type.t === 'Tag')
		) {
			if (
				this.mark.col === 0 &&
				back.span.start.col === 0 &&
				this.indent > -1
			) {
				throw this.err(back.span.start, 'invalid indentation for anchor');
			}
		}
		const mark = copy(this.mark);
		this.skipNonBlank();
		this.rollIndent(mark.col, undefined, { t: 'BlockSequenceStart' }, mark);
		const result = this.skipWsToEol('yes');
		const foundTabs = typeof result === 'object' && result.foundTabs;
		if (
			foundTabs &&
			this.input.peek() === '-' &&
			isBlankOrBreakz(this.input.peekNth(1))
		) {
			throw this.err(
				this.mark,
				"'-' must be followed by a valid YAML whitespace",
			);
		}
		this.skipWsToEol('no');
		if (this.input.nextIsBreak() || this.input.nextIsFlow())
			this.rollOneColIndent();
		this.removeSimpleKey();
		this.simpleKeyAllowed = true;
		this.tokens.push({ span: emptySpan(this.mark), type: { t: 'BlockEntry' } });
	}

	private fetchDocumentIndicator(type: TokenType): void {
		this.unrollIndent(-1);
		this.removeSimpleKey();
		this.simpleKeyAllowed = false;
		const mark = copy(this.mark);
		this.skipNNonBlank(3);
		this.tokens.push({ span: span(mark, this.mark), type });
	}

	private fetchBlockScalar(literal: boolean): void {
		this.saveSimpleKey();
		this.simpleKeyAllowed = true;
		this.tokens.push(this.scanBlockScalar(literal));
	}

	private scanBlockScalar(literal: boolean): Token {
		let startMark = copy(this.mark);
		let chomping: Chomping = 'clip';
		let increment = 0;
		let indent = 0;
		let trailingBlank: boolean;
		let leadingBlank = false;
		const style: ScalarStyle = literal ? 'literal' : 'folded';
		let string = '';
		let leadingBreak = '';
		let trailingBreaks = '';
		let chompingBreak = '';
		this.skipNonBlank();
		this.unrollNonBlockIndents();
		if (this.input.peek() === '+' || this.input.peek() === '-') {
			chomping = this.input.peek() === '+' ? 'keep' : 'strip';
			this.skipNonBlank();
			if (this.input.nextIsDigit()) {
				if (this.input.peek() === '0') {
					throw this.err(
						startMark,
						'while scanning a block scalar, found an indentation indicator equal to 0',
					);
				}
				increment = Number(this.input.peek());
				this.skipNonBlank();
			}
		} else if (this.input.nextIsDigit()) {
			if (this.input.peek() === '0') {
				throw this.err(
					startMark,
					'while scanning a block scalar, found an indentation indicator equal to 0',
				);
			}
			increment = Number(this.input.peek());
			this.skipNonBlank();
			if (this.input.peek() === '+' || this.input.peek() === '-') {
				chomping = this.input.peek() === '+' ? 'keep' : 'strip';
				this.skipNonBlank();
			}
		}
		this.skipWsToEol('yes');
		if (!this.input.nextIsBreakz()) {
			throw this.err(
				startMark,
				'while scanning a block scalar, did not find expected comment or line break',
			);
		}
		if (this.input.nextIsBreak()) chompingBreak += this.readBreak();
		if (this.input.peek() === '\t')
			throw this.err(
				startMark,
				'a block scalar content cannot start with a tab',
			);
		if (increment > 0)
			indent = this.indent >= 0 ? this.indent + increment : increment;
		if (indent === 0) {
			const [found, breaks] = this.skipBlockScalarFirstLineIndent();
			indent = found;
			trailingBreaks += breaks;
		} else {
			trailingBreaks += this.skipBlockScalarIndent(indent);
		}
		if (this.input.nextIsZ()) {
			let contents: string;
			if (chomping === 'strip') contents = '';
			else if (this.mark.line === startMark.line) contents = '';
			else if (chomping === 'clip') contents = chompingBreak;
			else if (trailingBreaks === '') contents = chompingBreak;
			else contents = trailingBreaks;
			return {
				span: span(startMark, this.mark),
				type: { t: 'Scalar', style, value: contents },
			};
		}
		if (this.mark.col < indent && this.mark.col > this.indent) {
			throw this.err(this.mark, 'wrongly indented line in block scalar');
		}
		startMark = copy(this.mark);
		while (this.mark.col === indent && !this.input.nextIsZ()) {
			if (indent === 0 && this.input.nextIsDocumentEnd()) break;
			trailingBlank = this.input.nextIsBlank();
			if (!literal && leadingBreak !== '' && !leadingBlank && !trailingBlank) {
				string += trailingBreaks;
				if (trailingBreaks === '') string += ' ';
			} else {
				string += leadingBreak;
				string += trailingBreaks;
			}
			leadingBreak = '';
			trailingBreaks = '';
			leadingBlank = this.input.nextIsBlank();
			string += this.scanBlockScalarContentLine();
			if (this.input.nextIsZ()) break;
			leadingBreak += this.readBreak();
			trailingBreaks += this.skipBlockScalarIndent(indent);
		}
		if (chomping !== 'strip') {
			string += leadingBreak;
			if (this.input.nextIsZ() && this.mark.col >= Math.max(indent, 1))
				string += '\n';
		}
		if (chomping === 'keep') string += trailingBreaks;
		return {
			span: span(startMark, this.mark),
			type: { t: 'Scalar', style, value: string },
		};
	}

	private scanBlockScalarContentLine(): string {
		let out = '';
		while (!this.input.nextIsBreakz()) {
			out += this.input.peek();
			this.skipBlank();
		}
		return out;
	}

	private skipBlockScalarIndent(indent: number): string {
		let breaks = '';
		for (;;) {
			while (this.mark.col < indent && this.input.peek() === ' ')
				this.skipBlank();
			if (this.input.nextIsBreak()) breaks += this.readBreak();
			else break;
		}
		return breaks;
	}

	private skipBlockScalarFirstLineIndent(): [number, string] {
		let maxIndent = 0;
		let breaks = '';
		for (;;) {
			while (this.input.peek() === ' ') this.skipBlank();
			if (this.mark.col > maxIndent) maxIndent = this.mark.col;
			if (this.input.nextIsBreak()) breaks += this.readBreak();
			else break;
		}
		let indent = Math.max(maxIndent, this.indent + 1);
		if (this.indent > 0) indent = Math.max(indent, 1);
		return [indent, breaks];
	}

	private fetchFlowScalar(single: boolean): void {
		this.saveSimpleKey();
		this.simpleKeyAllowed = false;
		const token = this.scanFlowScalar(single);
		this.skipToNextToken();
		this.adjacentValueAllowedAt = this.mark.index;
		this.tokens.push(token);
	}

	private scanFlowScalar(single: boolean): Token {
		const startMark = copy(this.mark);
		let string = '';
		let leadingBreak = '';
		let trailingBreaks = '';
		let whitespaces = '';
		this.skipNonBlank();
		for (;;) {
			if (this.mark.col === 0 && this.input.nextIsDocumentIndicator()) {
				throw this.err(
					startMark,
					'while scanning a quoted scalar, found unexpected document indicator',
				);
			}
			if (this.input.nextIsZ())
				throw this.err(
					startMark,
					'while scanning a quoted scalar, found unexpected end of stream',
				);
			if (this.mark.col < this.indent)
				throw this.err(startMark, 'invalid indentation in quoted scalar');
			const [text, leadingBlanksAfter] =
				this.consumeFlowScalarNonWhitespaceChars(single, startMark);
			string += text;
			let leadingBlanks = leadingBlanksAfter;
			const c = this.input.peek();
			if ((c === "'" && single) || (c === '"' && !single)) break;
			while (this.input.nextIsBlank() || this.input.nextIsBreak()) {
				if (this.input.nextIsBlank()) {
					if (leadingBlanks) {
						if (this.input.peek() === '\t' && this.mark.col < this.indent) {
							throw this.err(this.mark, 'tab cannot be used as indentation');
						}
						this.skipBlank();
					} else {
						whitespaces += this.input.peek();
						this.skipBlank();
					}
				} else if (leadingBlanks) {
					trailingBreaks += this.readBreak();
				} else {
					whitespaces = '';
					leadingBreak += this.readBreak();
					leadingBlanks = true;
				}
			}
			if (leadingBlanks) {
				if (leadingBreak === '') {
					string += leadingBreak;
					string += trailingBreaks;
					trailingBreaks = '';
					leadingBreak = '';
				} else {
					if (trailingBreaks === '') {
						string += ' ';
					} else {
						string += trailingBreaks;
						trailingBreaks = '';
					}
					leadingBreak = '';
				}
			} else {
				string += whitespaces;
				whitespaces = '';
			}
		}
		this.skipNonBlank();
		this.skipWsToEol('yes');
		const next = this.input.peek();
		const fine =
			((next === ',' || next === '}' || next === ']') && this.flowLevel > 0) ||
			isBreakz(next) ||
			(next === ':' &&
				this.flowLevel === 0 &&
				startMark.line === this.mark.line) ||
			(next === ':' && this.flowLevel > 0);
		if (!fine)
			throw this.err(
				this.mark,
				'invalid trailing content after double-quoted scalar',
			);
		return {
			span: span(startMark, this.mark),
			type: { t: 'Scalar', style: single ? 'single' : 'double', value: string },
		};
	}

	/** Returns the text read and whether an escaped line break left leading blanks to skip. */
	private consumeFlowScalarNonWhitespaceChars(
		single: boolean,
		startMark: Marker,
	): [string, boolean] {
		let out = '';
		while (!isBlankOrBreakz(this.input.peek())) {
			const c = this.input.peek();
			if (c === "'" && this.input.peekNth(1) === "'" && single) {
				out += "'";
				this.skipNNonBlank(2);
			} else if (c === "'" && single) {
				break;
			} else if (c === '"' && !single) {
				break;
			} else if (c === '\\' && !single && isBreak(this.input.peekNth(1))) {
				this.skipNonBlank();
				this.skipLinebreak();
				return [out, true];
			} else if (c === '\\' && !single) {
				out += this.resolveFlowScalarEscapeSequence(startMark);
			} else {
				out += c;
				this.skipNonBlank();
			}
		}
		return [out, false];
	}

	private resolveFlowScalarEscapeSequence(startMark: Marker): string {
		const ESCAPES: Record<string, string> = {
			'0': '\0',
			a: '\x07',
			b: '\x08',
			t: '\t',
			'\t': '\t',
			n: '\n',
			v: '\x0b',
			f: '\x0c',
			r: '\x0d',
			e: '\x1b',
			' ': ' ',
			'"': '"',
			'/': '/',
			'\\': '\\',
			N: '\u0085',
			_: ' ',
			L: ' ',
			P: ' ',
		};
		const LENGTHS: Record<string, number> = { x: 2, u: 4, U: 8 };
		const escaped = this.input.peekNth(1);
		const codeLength = Object.hasOwn(LENGTHS, escaped)
			? (LENGTHS[escaped] as number)
			: 0;
		let result = Object.hasOwn(ESCAPES, escaped)
			? (ESCAPES[escaped] as string)
			: undefined;
		if (result === undefined && codeLength === 0) {
			throw this.err(
				startMark,
				'while parsing a quoted scalar, found unknown escape character',
			);
		}
		this.skipNNonBlank(2);
		if (codeLength > 0) {
			let value = 0;
			for (let i = 0; i < codeLength; i++) {
				const c = this.input.peekNth(i);
				if (!isHex(c)) {
					throw this.err(
						startMark,
						'while parsing a quoted scalar, did not find expected hexadecimal number',
					);
				}
				value = value * 16 + asHex(c);
			}
			if (value > 0x10ffff || (value >= 0xd800 && value <= 0xdfff)) {
				throw this.err(
					startMark,
					'while parsing a quoted scalar, found invalid Unicode character escape code',
				);
			}
			result = String.fromCodePoint(value);
			this.skipNNonBlank(codeLength);
		}
		return result as string;
	}

	private fetchPlainScalar(): void {
		this.saveSimpleKey();
		this.simpleKeyAllowed = false;
		this.tokens.push(this.scanPlainScalar());
	}

	private scanPlainScalar(): Token {
		this.unrollNonBlockIndents();
		const indent = this.indent + 1;
		const startMark = copy(this.mark);
		if (this.flowLevel > 0 && startMark.col < indent) {
			throw this.err(startMark, 'invalid indentation in flow construct');
		}
		let string = '';
		this.bufWhitespaces = '';
		this.bufLeadingBreak = '';
		this.bufTrailingBreaks = '';
		let endMark = copy(this.mark);
		for (;;) {
			if (
				(this.mark.col === 0 && this.input.nextIsDocumentIndicator()) ||
				this.input.peek() === '#'
			) {
				if (
					this.input.peek() === '#' &&
					string !== '' &&
					this.bufWhitespaces !== '' &&
					this.flowLevel === 0
				) {
					this.interruptedPlainByComment = copy(this.mark);
				}
				break;
			}
			if (
				this.flowLevel > 0 &&
				this.input.peek() === '-' &&
				isFlow(this.input.peekNth(1))
			) {
				throw this.err(
					this.mark,
					"plain scalar cannot start with '-' followed by ,[]{}",
				);
			}
			if (
				!this.input.nextIsBlankOrBreakz() &&
				this.input.nextCanBePlainScalar(this.flowLevel > 0)
			) {
				if (this.leadingWhitespace) {
					if (this.bufLeadingBreak === '') {
						string += this.bufLeadingBreak;
						string += this.bufTrailingBreaks;
						this.bufTrailingBreaks = '';
						this.bufLeadingBreak = '';
					} else {
						if (this.bufTrailingBreaks === '') {
							string += ' ';
						} else {
							string += this.bufTrailingBreaks;
							this.bufTrailingBreaks = '';
						}
						this.bufLeadingBreak = '';
					}
					this.leadingWhitespace = false;
				} else if (this.bufWhitespaces !== '') {
					string += this.bufWhitespaces;
					this.bufWhitespaces = '';
				}
				string += this.input.peek();
				this.skipNonBlank();
				while (
					!this.input.nextIsBlankOrBreakz() &&
					this.input.nextCanBePlainScalar(this.flowLevel > 0)
				) {
					string += this.input.peek();
					this.skipNonBlank();
				}
				endMark = copy(this.mark);
			}
			if (!(this.input.nextIsBlank() || this.input.nextIsBreak())) break;
			while (this.input.nextIsBlankOrBreak()) {
				if (this.input.nextIsBlank()) {
					if (!this.leadingWhitespace) {
						this.bufWhitespaces += this.input.peek();
						this.skipBlank();
					} else if (this.mark.col < indent && this.input.peek() === '\t') {
						this.skipWsToEol('yes');
						if (!this.input.nextIsBreakz())
							throw this.err(
								startMark,
								'while scanning a plain scalar, found a tab',
							);
					} else {
						this.skipBlank();
					}
				} else if (this.leadingWhitespace) {
					this.skipBreak();
					this.bufTrailingBreaks += '\n';
				} else {
					this.bufWhitespaces = '';
					this.skipBreak();
					this.bufLeadingBreak += '\n';
					this.leadingWhitespace = true;
				}
			}
			if (this.flowLevel === 0 && this.mark.col < indent) break;
		}
		if (this.leadingWhitespace) this.simpleKeyAllowed = true;
		if (string === '')
			throw this.err(startMark, 'unexpected end of plain scalar');
		return {
			span: span(startMark, endMark),
			type: { t: 'Scalar', style: 'plain', value: string },
		};
	}

	private fetchKey(): void {
		const startMark = copy(this.mark);
		if (this.flowLevel === 0) {
			if (!this.simpleKeyAllowed)
				throw this.err(
					this.mark,
					'mapping keys are not allowed in this context',
				);
			this.rollIndent(
				startMark.col,
				undefined,
				{ t: 'BlockMappingStart' },
				startMark,
			);
		} else {
			this.flowMappingStarted = true;
		}
		this.removeSimpleKey();
		this.simpleKeyAllowed = this.flowLevel === 0;
		this.skipNonBlank();
		this.skipYamlWhitespace();
		if (this.input.peek() === '\t')
			throw this.err(this.mark, 'tabs disallowed in this context');
		this.tokens.push({ span: span(startMark, this.mark), type: { t: 'Key' } });
	}

	private fetchFlowValue(): void {
		const nc = this.input.peekNth(1);
		if (
			this.mark.index !== this.adjacentValueAllowedAt &&
			(nc === '[' || nc === '{')
		) {
			throw this.err(
				this.mark,
				"':' may not precede any of `[{` in flow mapping",
			);
		}
		this.fetchValue();
	}

	private fetchValue(): void {
		const last = this.simpleKeys.at(-1) as SimpleKey;
		const key: SimpleKey = { ...last, mark: copy(last.mark) };
		const startMark = copy(this.mark);
		const isImplicitFlowMapping =
			this.implicitFlowMappingStates.length > 0 && !this.flowMappingStarted;
		if (isImplicitFlowMapping)
			this.implicitFlowMappingStates[
				this.implicitFlowMappingStates.length - 1
			] = 'inside';
		this.skipNonBlank();
		if (this.input.peek() === '\t') {
			const result = this.skipWsToEol('yes');
			const valid = typeof result === 'object' && result.hasYamlWs;
			if (!valid && (this.input.peek() === '-' || this.input.nextIsAlpha())) {
				throw this.err(
					this.mark,
					"':' must be followed by a valid YAML whitespace",
				);
			}
		}
		if (key.possible) {
			this.insertToken(key.tokenNumber - this.tokensParsed, {
				span: emptySpan(key.mark),
				type: { t: 'Key' },
			});
			if (isImplicitFlowMapping) {
				if (key.mark.line < startMark.line)
					throw this.err(startMark, "illegal placement of ':' indicator");
				this.insertToken(key.tokenNumber - this.tokensParsed, {
					span: emptySpan(key.mark),
					type: { t: 'FlowMappingStart' },
				});
			}
			this.rollIndent(
				key.mark.col,
				key.tokenNumber,
				{ t: 'BlockMappingStart' },
				key.mark,
			);
			this.rollOneColIndent();
			(this.simpleKeys.at(-1) as SimpleKey).possible = false;
			this.simpleKeyAllowed = false;
		} else {
			if (isImplicitFlowMapping)
				this.tokens.push({
					span: emptySpan(startMark),
					type: { t: 'FlowMappingStart' },
				});
			if (this.flowLevel === 0) {
				if (!this.simpleKeyAllowed)
					throw this.err(
						startMark,
						'mapping values are not allowed in this context',
					);
				this.rollIndent(
					startMark.col,
					undefined,
					{ t: 'BlockMappingStart' },
					startMark,
				);
			}
			this.rollOneColIndent();
			this.simpleKeyAllowed = this.flowLevel === 0;
		}
		this.tokens.push({ span: emptySpan(startMark), type: { t: 'Value' } });
	}

	private rollIndent(
		col: number,
		number: number | undefined,
		type: TokenType,
		mark: Marker,
	): void {
		if (this.flowLevel > 0) return;
		if (this.indent <= col) {
			const last = this.indents.at(-1);
			if (last !== undefined && !last.needsBlockEnd) {
				this.indent = last.indent;
				this.indents.pop();
			}
		}
		if (this.indent < col) {
			this.indents.push({ indent: this.indent, needsBlockEnd: true });
			this.indent = col;
			const token: Token = { span: emptySpan(mark), type };
			if (number === undefined) this.tokens.push(token);
			else this.insertToken(number - this.tokensParsed, token);
		}
	}

	private unrollIndent(col: number): void {
		if (this.flowLevel > 0) return;
		while (this.indent > col) {
			const indent = this.indents.pop() as Indent;
			this.indent = indent.indent;
			if (indent.needsBlockEnd)
				this.tokens.push({
					span: emptySpan(this.mark),
					type: { t: 'BlockEnd' },
				});
		}
	}

	private rollOneColIndent(): void {
		if (this.flowLevel === 0 && this.indents.at(-1)?.needsBlockEnd === true) {
			this.indents.push({ indent: this.indent, needsBlockEnd: false });
			this.indent++;
		}
	}

	private unrollNonBlockIndents(): void {
		for (
			let last = this.indents.at(-1);
			last !== undefined;
			last = this.indents.at(-1)
		) {
			if (last.needsBlockEnd) break;
			this.indent = last.indent;
			this.indents.pop();
		}
	}

	private saveSimpleKey(): void {
		if (this.simpleKeyAllowed) {
			const required =
				this.flowLevel === 0 &&
				this.indent === this.mark.col &&
				(this.indents.at(-1) as Indent).needsBlockEnd;
			const key = newSimpleKey(this.mark);
			key.possible = true;
			key.required = required;
			key.tokenNumber = this.tokensParsed + this.tokens.length;
			this.simpleKeys.pop();
			this.simpleKeys.push(key);
		}
	}

	private removeSimpleKey(): void {
		const last = this.simpleKeys.at(-1) as SimpleKey;
		if (last.possible && last.required)
			throw this.err(this.mark, 'simple key expected');
		last.possible = false;
	}

	private isWithinBlock(): boolean {
		return this.indents.length > 0;
	}

	private endImplicitMapping(mark: Marker): void {
		const last = this.implicitFlowMappingStates.length - 1;
		if (last >= 0 && this.implicitFlowMappingStates[last] === 'inside') {
			this.flowMappingStarted = false;
			this.implicitFlowMappingStates[last] = 'possible';
			this.tokens.push({
				span: emptySpan(mark),
				type: { t: 'FlowMappingEnd' },
			});
		}
	}
}
