import {
	type Marker,
	type ScalarStyle,
	ScanError,
	Scanner,
	type Span,
	type Token,
} from './scanner';

/**
 * saphyr-parser 0.1.0's event parser (`parser.rs`) and its `load`, which is
 * what `Yaml::load_from_str` drives. Errors are thrown as `ScanError`, the
 * first one wins, and events go to the receiver as they are produced — so a
 * document that fails late has still been half-loaded, and discarded, as the
 * crate discards it.
 */

export interface Tag {
	readonly handle: string;
	readonly suffix: string;
}

export const isCoreSchema = (tag: Tag): boolean =>
	tag.handle === 'tag:yaml.org,2002:';

export type Event =
	| { readonly e: 'Nothing' }
	| { readonly e: 'StreamStart' }
	| { readonly e: 'StreamEnd' }
	| { readonly e: 'DocumentStart' }
	| { readonly e: 'DocumentEnd' }
	| { readonly e: 'Alias'; readonly id: number }
	| {
			readonly e: 'Scalar';
			readonly value: string;
			readonly style: ScalarStyle;
			readonly anchor: number;
			readonly tag: Tag | undefined;
	  }
	| {
			readonly e: 'SequenceStart';
			readonly anchor: number;
			readonly tag: Tag | undefined;
	  }
	| { readonly e: 'SequenceEnd' }
	| {
			readonly e: 'MappingStart';
			readonly anchor: number;
			readonly tag: Tag | undefined;
	  }
	| { readonly e: 'MappingEnd' };

export interface Receiver {
	onEvent(event: Event): void;
}

type State =
	| { readonly s: 'StreamStart' }
	| { readonly s: 'ImplicitDocumentStart' }
	| { readonly s: 'DocumentStart' }
	| { readonly s: 'DocumentContent' }
	| { readonly s: 'DocumentEnd' }
	| { readonly s: 'BlockNode' }
	| { readonly s: 'BlockSequenceFirstEntry' }
	| { readonly s: 'BlockSequenceEntry' }
	| { readonly s: 'IndentlessSequenceEntry' }
	| { readonly s: 'BlockMappingFirstKey' }
	| { readonly s: 'BlockMappingKey' }
	| { readonly s: 'BlockMappingValue' }
	| { readonly s: 'FlowSequenceFirstEntry' }
	| { readonly s: 'FlowSequenceEntry' }
	| { readonly s: 'FlowSequenceEntryMappingKey' }
	| { readonly s: 'FlowSequenceEntryMappingValue' }
	| { readonly s: 'FlowSequenceEntryMappingEnd'; readonly mark: Marker }
	| { readonly s: 'FlowMappingFirstKey' }
	| { readonly s: 'FlowMappingKey' }
	| { readonly s: 'FlowMappingValue' }
	| { readonly s: 'FlowMappingEmptyValue' }
	| { readonly s: 'End' };

const st = <S extends State['s']>(s: S): State => ({ s }) as State;

const EMPTY_SCALAR: Event = {
	e: 'Scalar',
	value: '',
	style: 'plain',
	anchor: 0,
	tag: undefined,
};

type Result = [Event, Span];

export class Parser {
	private readonly scanner: Scanner;
	private readonly states: State[] = [];
	private state: State = st('StreamStart');
	private token: Token | undefined;
	private current: Result | undefined;
	private anchors = new Map<string, number>();
	private anchorIdCount = 1;
	private tags = new Map<string, string>();

	constructor(text: string) {
		this.scanner = new Scanner(text);
	}

	private nextEventImpl(): Result {
		const current = this.current;
		this.current = undefined;
		return current ?? this.parse();
	}

	private peekToken(): Token {
		if (this.token === undefined) this.token = this.scanNextToken();
		return this.token;
	}

	private scanNextToken(): Token {
		const token = this.scanner.next();
		if (token !== undefined) return token;
		const error = this.scanner.getError();
		throw error ?? new ScanError({ ...this.scanner.mark }, 'unexpected eof');
	}

	private fetchToken(): Token {
		const token = this.token as Token;
		this.token = undefined;
		return token;
	}

	private skip(): void {
		this.token = undefined;
	}

	private popState(): void {
		this.state = this.states.pop() as State;
	}

	private pushState(state: State): void {
		this.states.push(state);
	}

	private parse(): Result {
		if (this.state.s === 'End') {
			const mark = { ...this.scanner.mark };
			return [{ e: 'StreamEnd' }, { start: mark, end: { ...mark } }];
		}
		return this.stateMachine();
	}

	/** `Parser::load` with `multi` set. */
	load(receiver: Receiver): void {
		if (!this.scanner.streamStartProduced) {
			const [event, span] = this.nextEventImpl();
			if (event.e !== 'StreamStart')
				throw new ScanError(span.start, 'did not find expected <stream-start>');
			receiver.onEvent(event);
		}
		if (this.scanner.streamEndProduced) {
			receiver.onEvent({ e: 'StreamEnd' });
			return;
		}
		for (;;) {
			const [event, span] = this.nextEventImpl();
			if (event.e === 'StreamEnd') {
				receiver.onEvent(event);
				return;
			}
			this.anchors.clear();
			this.loadDocument(event, span, receiver);
		}
	}

	private loadDocument(first: Event, span: Span, receiver: Receiver): void {
		if (first.e !== 'DocumentStart')
			throw new ScanError(span.start, 'did not find expected <document-start>');
		receiver.onEvent(first);
		const [event, nodeSpan] = this.nextEventImpl();
		this.loadNode(event, nodeSpan, receiver);
		const [end] = this.nextEventImpl();
		receiver.onEvent(end);
	}

	private loadNode(first: Event, _span: Span, receiver: Receiver): void {
		receiver.onEvent(first);
		if (first.e === 'SequenceStart') this.loadSequence(receiver);
		else if (first.e === 'MappingStart') this.loadMapping(receiver);
	}

	private loadMapping(receiver: Receiver): void {
		let [key, keySpan] = this.nextEventImpl();
		while (key.e !== 'MappingEnd') {
			this.loadNode(key, keySpan, receiver);
			const [value, valueSpan] = this.nextEventImpl();
			this.loadNode(value, valueSpan, receiver);
			[key, keySpan] = this.nextEventImpl();
		}
		receiver.onEvent(key);
	}

	private loadSequence(receiver: Receiver): void {
		let [event, span] = this.nextEventImpl();
		while (event.e !== 'SequenceEnd') {
			this.loadNode(event, span, receiver);
			[event, span] = this.nextEventImpl();
		}
		receiver.onEvent(event);
	}

	private stateMachine(): Result {
		const state = this.state;
		switch (state.s) {
			case 'StreamStart':
				return this.streamStart();
			case 'ImplicitDocumentStart':
				return this.documentStart(true);
			case 'DocumentStart':
				return this.documentStart(false);
			case 'DocumentContent':
				return this.documentContent();
			case 'DocumentEnd':
				return this.documentEnd();
			case 'BlockNode':
				return this.parseNode(true, false);
			case 'BlockMappingFirstKey':
				return this.blockMappingKey(true);
			case 'BlockMappingKey':
				return this.blockMappingKey(false);
			case 'BlockMappingValue':
				return this.blockMappingValue();
			case 'BlockSequenceFirstEntry':
				return this.blockSequenceEntry(true);
			case 'BlockSequenceEntry':
				return this.blockSequenceEntry(false);
			case 'FlowSequenceFirstEntry':
				return this.flowSequenceEntry(true);
			case 'FlowSequenceEntry':
				return this.flowSequenceEntry(false);
			case 'FlowMappingFirstKey':
				return this.flowMappingKey(true);
			case 'FlowMappingKey':
				return this.flowMappingKey(false);
			case 'FlowMappingValue':
				return this.flowMappingValue(false);
			case 'IndentlessSequenceEntry':
				return this.indentlessSequenceEntry();
			case 'FlowSequenceEntryMappingKey':
				return this.flowSequenceEntryMappingKey();
			case 'FlowSequenceEntryMappingValue':
				return this.flowSequenceEntryMappingValue();
			case 'FlowSequenceEntryMappingEnd':
				this.state = st('FlowSequenceEntry');
				return [{ e: 'MappingEnd' }, { start: state.mark, end: state.mark }];
			case 'FlowMappingEmptyValue':
				return this.flowMappingValue(true);
			case 'End':
				throw new Error('unreachable');
		}
	}

	private streamStart(): Result {
		const token = this.peekToken();
		if (token.type.t === 'StreamStart') {
			this.state = st('ImplicitDocumentStart');
			this.skip();
			return [{ e: 'StreamStart' }, token.span];
		}
		throw new ScanError(
			token.span.start,
			'did not find expected <stream-start>',
		);
	}

	private documentStart(implicit: boolean): Result {
		while (this.peekToken().type.t === 'DocumentEnd') this.skip();
		const token = this.peekToken();
		const t = token.type.t;
		if (t === 'StreamEnd') {
			this.state = st('End');
			this.skip();
			return [{ e: 'StreamEnd' }, token.span];
		}
		if (
			t === 'VersionDirective' ||
			t === 'TagDirective' ||
			t === 'ReservedDirective' ||
			t === 'DocumentStart'
		) {
			return this.explicitDocumentStart();
		}
		if (implicit) {
			this.processDirectives();
			this.pushState(st('DocumentEnd'));
			this.state = st('BlockNode');
			return [{ e: 'DocumentStart' }, token.span];
		}
		return this.explicitDocumentStart();
	}

	/**
	 * As saphyr has it: the map of tags is rebuilt on every directive, so the
	 * duplicate check never fires and only the last directive's tag survives.
	 */
	private processDirectives(): void {
		let versionReceived = false;
		for (;;) {
			const tags = new Map<string, string>();
			const token = this.peekToken();
			if (token.type.t === 'VersionDirective') {
				if (versionReceived)
					throw new ScanError(token.span.start, 'duplicate version directive');
				versionReceived = true;
			} else if (token.type.t === 'TagDirective') {
				if (tags.has(token.type.handle)) {
					throw new ScanError(
						token.span.start,
						'the TAG directive must only be given at most once per handle in the same document',
					);
				}
				tags.set(token.type.handle, token.type.prefix);
			} else if (token.type.t !== 'ReservedDirective') {
				break;
			}
			this.tags = tags;
			this.skip();
		}
	}

	private explicitDocumentStart(): Result {
		this.processDirectives();
		const token = this.peekToken();
		if (token.type.t === 'DocumentStart') {
			this.pushState(st('DocumentEnd'));
			this.state = st('DocumentContent');
			this.skip();
			return [{ e: 'DocumentStart' }, token.span];
		}
		throw new ScanError(
			token.span.start,
			'did not find expected <document start>',
		);
	}

	private documentContent(): Result {
		const token = this.peekToken();
		const t = token.type.t;
		if (
			t === 'VersionDirective' ||
			t === 'TagDirective' ||
			t === 'ReservedDirective' ||
			t === 'DocumentStart' ||
			t === 'DocumentEnd' ||
			t === 'StreamEnd'
		) {
			this.popState();
			return [EMPTY_SCALAR, token.span];
		}
		return this.parseNode(true, false);
	}

	private documentEnd(): Result {
		let explicitEnd = false;
		const token = this.peekToken();
		const span = token.span;
		if (token.type.t === 'DocumentEnd') {
			explicitEnd = true;
			this.skip();
		}
		this.tags.clear();
		if (explicitEnd) {
			this.state = st('ImplicitDocumentStart');
		} else {
			const next = this.peekToken();
			const t = next.type.t;
			if (
				t === 'VersionDirective' ||
				t === 'TagDirective' ||
				t === 'ReservedDirective'
			) {
				throw new ScanError(
					next.span.start,
					'missing explicit document end marker before directive',
				);
			}
			this.state = st('DocumentStart');
		}
		return [{ e: 'DocumentEnd' }, span];
	}

	private registerAnchor(name: string): number {
		const id = this.anchorIdCount;
		this.anchorIdCount++;
		this.anchors.set(name, id);
		return id;
	}

	private parseNode(block: boolean, indentlessSequence: boolean): Result {
		let anchorId = 0;
		let tag: Tag | undefined;
		const first = this.peekToken();
		if (first.type.t === 'Alias') {
			this.popState();
			const token = this.fetchToken();
			const id = this.anchors.get((token.type as { name: string }).name);
			if (id === undefined)
				throw new ScanError(
					token.span.start,
					'while parsing node, found unknown anchor',
				);
			return [{ e: 'Alias', id }, token.span];
		}
		if (first.type.t === 'Anchor') {
			const token = this.fetchToken();
			anchorId = this.registerAnchor((token.type as { name: string }).name);
			const next = this.peekToken();
			if (next.type.t === 'Tag') {
				const tagToken = this.fetchToken().type as {
					handle: string;
					suffix: string;
				};
				// saphyr resolves this tag against the anchor's span.
				tag = this.resolveTag(token.span, tagToken.handle, tagToken.suffix);
			}
		} else if (first.type.t === 'Tag') {
			const tagToken = this.fetchToken().type as {
				handle: string;
				suffix: string;
			};
			tag = this.resolveTag(first.span, tagToken.handle, tagToken.suffix);
			if (this.peekToken().type.t === 'Anchor') {
				const token = this.fetchToken();
				anchorId = this.registerAnchor((token.type as { name: string }).name);
			}
		}
		const token = this.peekToken();
		const t = token.type;
		if (t.t === 'BlockEntry' && indentlessSequence) {
			this.state = st('IndentlessSequenceEntry');
			return [{ e: 'SequenceStart', anchor: anchorId, tag }, token.span];
		}
		if (t.t === 'Scalar') {
			this.popState();
			this.fetchToken();
			return [
				{ e: 'Scalar', value: t.value, style: t.style, anchor: anchorId, tag },
				token.span,
			];
		}
		if (t.t === 'FlowSequenceStart') {
			this.state = st('FlowSequenceFirstEntry');
			return [{ e: 'SequenceStart', anchor: anchorId, tag }, token.span];
		}
		if (t.t === 'FlowMappingStart') {
			this.state = st('FlowMappingFirstKey');
			return [{ e: 'MappingStart', anchor: anchorId, tag }, token.span];
		}
		if (t.t === 'BlockSequenceStart' && block) {
			this.state = st('BlockSequenceFirstEntry');
			return [{ e: 'SequenceStart', anchor: anchorId, tag }, token.span];
		}
		if (t.t === 'BlockMappingStart' && block) {
			this.state = st('BlockMappingFirstKey');
			return [{ e: 'MappingStart', anchor: anchorId, tag }, token.span];
		}
		if (tag !== undefined || anchorId > 0) {
			this.popState();
			return [
				{ e: 'Scalar', value: '', style: 'plain', anchor: anchorId, tag },
				token.span,
			];
		}
		throw new ScanError(
			token.span.start,
			'while parsing a node, did not find expected node content',
		);
	}

	private blockMappingKey(first: boolean): Result {
		if (first) {
			this.peekToken();
			this.skip();
		}
		const token = this.peekToken();
		const t = token.type.t;
		if (t === 'Key') {
			this.skip();
			const next = this.peekToken();
			if (
				next.type.t === 'Key' ||
				next.type.t === 'Value' ||
				next.type.t === 'BlockEnd'
			) {
				this.state = st('BlockMappingValue');
				return [EMPTY_SCALAR, next.span];
			}
			this.pushState(st('BlockMappingValue'));
			return this.parseNode(true, true);
		}
		if (t === 'Value') {
			this.state = st('BlockMappingValue');
			return [EMPTY_SCALAR, token.span];
		}
		if (t === 'BlockEnd') {
			this.popState();
			this.skip();
			return [{ e: 'MappingEnd' }, token.span];
		}
		throw new ScanError(
			token.span.start,
			'while parsing a block mapping, did not find expected key',
		);
	}

	private blockMappingValue(): Result {
		const token = this.peekToken();
		if (token.type.t === 'Value') {
			this.skip();
			const next = this.peekToken().type.t;
			if (next === 'Key' || next === 'Value' || next === 'BlockEnd') {
				this.state = st('BlockMappingKey');
				return [EMPTY_SCALAR, token.span];
			}
			this.pushState(st('BlockMappingKey'));
			return this.parseNode(true, true);
		}
		this.state = st('BlockMappingKey');
		return [EMPTY_SCALAR, token.span];
	}

	private flowMappingKey(first: boolean): Result {
		if (first) {
			this.peekToken();
			this.skip();
		}
		let span: Span;
		const token = this.peekToken();
		if (token.type.t === 'FlowMappingEnd') {
			span = token.span;
		} else {
			if (!first) {
				const separator = this.peekToken();
				if (separator.type.t === 'FlowEntry') this.skip();
				else {
					throw new ScanError(
						separator.span.start,
						"while parsing a flow mapping, did not find expected ',' or '}'",
					);
				}
			}
			const next = this.peekToken();
			if (next.type.t === 'Key') {
				this.skip();
				const after = this.peekToken();
				if (
					after.type.t === 'Value' ||
					after.type.t === 'FlowEntry' ||
					after.type.t === 'FlowMappingEnd'
				) {
					this.state = st('FlowMappingValue');
					return [EMPTY_SCALAR, after.span];
				}
				this.pushState(st('FlowMappingValue'));
				return this.parseNode(false, false);
			}
			if (next.type.t === 'Value') {
				this.state = st('FlowMappingValue');
				return [EMPTY_SCALAR, next.span];
			}
			if (next.type.t !== 'FlowMappingEnd') {
				this.pushState(st('FlowMappingEmptyValue'));
				return this.parseNode(false, false);
			}
			span = token.span;
		}
		this.popState();
		this.skip();
		return [{ e: 'MappingEnd' }, span];
	}

	private flowMappingValue(empty: boolean): Result {
		if (empty) {
			const token = this.peekToken();
			this.state = st('FlowMappingKey');
			return [EMPTY_SCALAR, token.span];
		}
		let span: Span;
		const token = this.peekToken();
		if (token.type.t === 'Value') {
			this.skip();
			const next = this.peekToken().type.t;
			if (next !== 'FlowEntry' && next !== 'FlowMappingEnd') {
				this.pushState(st('FlowMappingKey'));
				return this.parseNode(false, false);
			}
			span = token.span;
		} else {
			span = token.span;
		}
		this.state = st('FlowMappingKey');
		return [EMPTY_SCALAR, span];
	}

	private flowSequenceEntry(first: boolean): Result {
		if (first) {
			this.peekToken();
			this.skip();
		}
		const token = this.peekToken();
		if (token.type.t === 'FlowSequenceEnd') {
			this.popState();
			this.skip();
			return [{ e: 'SequenceEnd' }, token.span];
		}
		if (token.type.t === 'FlowEntry' && !first) {
			this.skip();
		} else if (!first) {
			throw new ScanError(
				token.span.start,
				"while parsing a flow sequence, expected ',' or ']'",
			);
		}
		const next = this.peekToken();
		if (next.type.t === 'FlowSequenceEnd') {
			this.popState();
			this.skip();
			return [{ e: 'SequenceEnd' }, next.span];
		}
		if (next.type.t === 'Key') {
			this.state = st('FlowSequenceEntryMappingKey');
			this.skip();
			return [{ e: 'MappingStart', anchor: 0, tag: undefined }, next.span];
		}
		this.pushState(st('FlowSequenceEntry'));
		return this.parseNode(false, false);
	}

	private indentlessSequenceEntry(): Result {
		const token = this.peekToken();
		if (token.type.t === 'BlockEntry') {
			this.skip();
			const next = this.peekToken().type.t;
			if (
				next === 'BlockEntry' ||
				next === 'Key' ||
				next === 'Value' ||
				next === 'BlockEnd'
			) {
				this.state = st('IndentlessSequenceEntry');
				return [EMPTY_SCALAR, token.span];
			}
			this.pushState(st('IndentlessSequenceEntry'));
			return this.parseNode(true, false);
		}
		this.popState();
		return [{ e: 'SequenceEnd' }, token.span];
	}

	private blockSequenceEntry(first: boolean): Result {
		if (first) {
			this.peekToken();
			this.skip();
		}
		const token = this.peekToken();
		if (token.type.t === 'BlockEnd') {
			this.popState();
			this.skip();
			return [{ e: 'SequenceEnd' }, token.span];
		}
		if (token.type.t === 'BlockEntry') {
			this.skip();
			const next = this.peekToken().type.t;
			if (next === 'BlockEntry' || next === 'BlockEnd') {
				this.state = st('BlockSequenceEntry');
				return [EMPTY_SCALAR, token.span];
			}
			this.pushState(st('BlockSequenceEntry'));
			return this.parseNode(true, false);
		}
		throw new ScanError(
			token.span.start,
			"while parsing a block collection, did not find expected '-' indicator",
		);
	}

	private flowSequenceEntryMappingKey(): Result {
		const token = this.peekToken();
		const t = token.type.t;
		if (t === 'Value' || t === 'FlowEntry' || t === 'FlowSequenceEnd') {
			this.skip();
			this.state = st('FlowSequenceEntryMappingValue');
			return [EMPTY_SCALAR, token.span];
		}
		this.pushState(st('FlowSequenceEntryMappingValue'));
		return this.parseNode(false, false);
	}

	private flowSequenceEntryMappingValue(): Result {
		const token = this.peekToken();
		if (token.type.t === 'Value') {
			this.skip();
			this.state = st('FlowSequenceEntryMappingValue');
			const next = this.peekToken();
			if (next.type.t === 'FlowEntry' || next.type.t === 'FlowSequenceEnd') {
				this.state = { s: 'FlowSequenceEntryMappingEnd', mark: next.span.end };
				return [EMPTY_SCALAR, next.span];
			}
			this.pushState({ s: 'FlowSequenceEntryMappingEnd', mark: next.span.end });
			return this.parseNode(false, false);
		}
		this.state = { s: 'FlowSequenceEntryMappingEnd', mark: token.span.end };
		return [EMPTY_SCALAR, token.span];
	}

	private resolveTag(span: Span, handle: string, suffix: string): Tag {
		if (handle === '!!')
			return { handle: this.tags.get('!!') ?? 'tag:yaml.org,2002:', suffix };
		if (handle === '' && suffix === '!')
			return { handle: this.tags.get('') ?? '', suffix };
		const prefix = this.tags.get(handle);
		if (prefix !== undefined) return { handle: prefix, suffix };
		if (handle.length >= 2 && handle.startsWith('!') && handle.endsWith('!')) {
			throw new ScanError(span.start, "the handle wasn't declared");
		}
		return { handle, suffix };
	}
}
