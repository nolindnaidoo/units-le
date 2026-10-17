import { datetimeError } from './datetime';
import { decodeKey, decodeScalar } from './decoder';
import { report, type Span, span } from './errors';
import type { Event, EventKind } from './parser';

/**
 * The toml crate's `de/parser/{document,key,value,array,inline_table}.rs`:
 * events in, a tree of tables out, with every table rule the crate enforces
 * and the order `preserve_order` gives — which is insertion order, with a
 * table that a later header claims moved to the end, because the crate
 * removes it and re-inserts it.
 */

export class DeTable {
	readonly entries = new Map<string, Entry>();
	implicit = false;
	dotted = false;
	inline = false;
}

export interface DeArray {
	readonly type: 'array';
	readonly items: Spanned[];
	arrayOfTables: boolean;
}

export type DeValue =
	| { readonly type: 'string'; readonly text: string }
	| { readonly type: 'integer'; readonly text: string; readonly radix: number }
	| { readonly type: 'float'; readonly text: string }
	| { readonly type: 'boolean'; readonly value: boolean }
	| { readonly type: 'datetime' }
	| DeArray
	| { readonly type: 'table'; readonly table: DeTable };

export interface Spanned {
	value: DeValue;
	span: Span;
}

interface Entry {
	readonly keySpan: Span;
	readonly item: Spanned;
}

interface Key {
	readonly text: string;
	readonly span: Span;
}

const LIMIT = 80;

const TYPE_STR: Record<DeValue['type'], string> = {
	string: 'string',
	integer: 'integer',
	float: 'float',
	boolean: 'boolean',
	datetime: 'datetime',
	array: 'array',
	table: 'table',
};

class Events {
	private offset = 0;

	constructor(
		private readonly events: readonly Event[],
		readonly bytes: Uint8Array,
	) {}

	next(): Event | undefined {
		const event = this.events[this.offset];
		if (event !== undefined) this.offset++;
		return event;
	}
	get(index: number): Event | undefined {
		return this.events[this.offset + index];
	}
	raw(event: Event): Uint8Array {
		return this.bytes.subarray(event.span.start, event.span.end);
	}
}

function onKey(keyEvent: Event, input: Events): [Key[], Key | undefined] {
	const path: Key[] = [];
	let result: Key | undefined;
	let current: Event | undefined = keyEvent;
	const moreKey = () => {
		const first = input.get(0)?.kind;
		return (
			first === 'keySep' ||
			(first === 'whitespace' && input.get(1)?.kind === 'keySep')
		);
	};
	const closeKey = () => {
		if (current === undefined) return;
		const key: Key = {
			text: decodeKey(input.raw(current), current.span.start, current.encoding),
			span: current.span,
		};
		current = undefined;
		if (result !== undefined) path.push(result);
		result = key;
	};
	if (moreKey()) {
		for (let event = input.next(); event !== undefined; event = input.next()) {
			if (event.kind === 'simpleKey') {
				current = event;
				if (!moreKey()) break;
			} else if (event.kind === 'keySep') {
				closeKey();
			}
		}
	}
	closeKey();
	if (LIMIT <= path.length) report('recursion limit');
	return [path, result];
}

function onScalar(event: Event, input: Events): Spanned {
	const [text, kind] = decodeScalar(
		input.raw(event),
		event.span.start,
		event.encoding,
	);
	let value: DeValue;
	if (kind.kind === 'string') value = { type: 'string', text };
	else if (kind.kind === 'boolean')
		value = { type: 'boolean', value: text === 'true' };
	else if (kind.kind === 'datetime') {
		const error = datetimeError(text);
		if (error !== undefined) report(error, undefined, event.span);
		value = { type: 'datetime' };
	} else if (kind.kind === 'float') value = { type: 'float', text };
	else value = { type: 'integer', text, radix: kind.radix };
	return { value, span: event.span };
}

function value(input: Events): Spanned {
	const event = input.next();
	if (event?.kind === 'inlineTableOpen') return onInlineTable(event, input);
	if (event?.kind === 'arrayOpen') return onArray(event, input);
	if (event?.kind === 'scalar') return onScalar(event, input);
	return { value: { type: 'integer', text: '0', radix: 10 }, span: span(0, 0) };
}

function onArray(open: Event, input: Events): Spanned {
	const result: DeArray = { type: 'array', items: [], arrayOfTables: false };
	let closeSpan = open.span;
	let current: Spanned | undefined;
	const finish = () => {
		if (current !== undefined) result.items.push(current);
		current = undefined;
	};
	const stops: readonly EventKind[] = [
		'stdTableOpen',
		'arrayTableOpen',
		'inlineTableClose',
		'simpleKey',
		'keySep',
		'keyValSep',
		'stdTableClose',
		'arrayTableClose',
	];
	for (let event = input.next(); event !== undefined; event = input.next()) {
		closeSpan = event.span;
		if (stops.includes(event.kind)) break;
		if (event.kind === 'inlineTableOpen') current = onInlineTable(event, input);
		else if (event.kind === 'arrayOpen') current = onArray(event, input);
		else if (event.kind === 'scalar') current = onScalar(event, input);
		else if (event.kind === 'valueSep') finish();
		else if (event.kind === 'arrayClose') {
			finish();
			break;
		}
	}
	return { value: result, span: span(open.span.start, closeSpan.end) };
}

function onInlineTable(open: Event, input: Events): Spanned {
	const result = new DeTable();
	result.inline = true;
	let closeSpan = open.span;
	let currentKey: [Key[], Key] | undefined;
	let currentValue: Spanned | undefined;
	const finish = () => {
		const keyed = currentKey;
		const item = currentValue;
		currentKey = undefined;
		currentValue = undefined;
		if (keyed === undefined || item === undefined) return;
		const [path, key] = keyed;
		const table = descendInline(result, path);
		if (table.dotted === (path.length === 0))
			report('duplicate key', undefined, key.span);
		if (table.entries.has(key.text))
			report('duplicate key', undefined, key.span);
		table.entries.set(key.text, { keySpan: key.span, item });
	};
	const stops: readonly EventKind[] = [
		'stdTableOpen',
		'arrayTableOpen',
		'stdTableClose',
		'arrayClose',
		'arrayTableClose',
		'keySep',
	];
	for (let event = input.next(); event !== undefined; event = input.next()) {
		closeSpan = event.span;
		if (stops.includes(event.kind)) break;
		if (event.kind === 'simpleKey') {
			const [path, key] = onKey(event, input);
			if (key !== undefined) currentKey = [path, key];
		} else if (event.kind === 'inlineTableOpen')
			currentValue = onInlineTable(event, input);
		else if (event.kind === 'arrayOpen') currentValue = onArray(event, input);
		else if (event.kind === 'scalar') currentValue = onScalar(event, input);
		else if (event.kind === 'valueSep') finish();
		else if (event.kind === 'inlineTableClose') {
			finish();
			break;
		}
	}
	return {
		value: { type: 'table', table: result },
		span: span(open.span.start, closeSpan.end),
	};
}

function newTable(dotted: boolean, inline: boolean): DeTable {
	const table = new DeTable();
	table.implicit = true;
	table.dotted = dotted;
	table.inline = inline;
	return table;
}

function descendInline(root: DeTable, path: readonly Key[]): DeTable {
	let table = root;
	for (const key of path) {
		const existing = table.entries.get(key.text);
		if (existing === undefined) {
			const created = newTable(true, true);
			table.entries.set(key.text, {
				keySpan: key.span,
				item: { value: { type: 'table', table: created }, span: key.span },
			});
			table = created;
			continue;
		}
		const found = existing.item.value;
		if (found.type !== 'table')
			report(
				`cannot extend value of type ${TYPE_STR[found.type]} with a dotted key`,
				undefined,
				key.span,
			);
		if (!found.table.implicit) report('duplicate key', undefined, key.span);
		table = found.table;
	}
	return table;
}

function descend(
	root: DeTable,
	path: readonly Key[],
	dotted: boolean,
): DeTable {
	let table = root;
	for (const key of path) {
		const existing = table.entries.get(key.text);
		if (existing === undefined) {
			const created = newTable(dotted, false);
			table.entries.set(key.text, {
				keySpan: key.span,
				item: { value: { type: 'table', table: created }, span: key.span },
			});
			table = created;
			continue;
		}
		const found = existing.item.value;
		if (found.type === 'array') {
			if (!found.arrayOfTables)
				report(
					'cannot extend value of type array with a dotted key',
					undefined,
					key.span,
				);
			const last = (found.items.at(-1) as Spanned).value;
			if (last.type !== 'table')
				report(
					`cannot extend value of type ${TYPE_STR[last.type]} with a dotted key`,
					undefined,
					key.span,
				);
			table = last.table;
		} else if (found.type === 'table') {
			const child = found.table;
			if (child.inline)
				report(
					'cannot extend value of type inline table with a dotted key',
					undefined,
					key.span,
				);
			if (dotted && child.implicit) child.dotted = true;
			if (dotted && !child.implicit)
				report('duplicate key', undefined, key.span);
			table = child;
		} else {
			report(
				`cannot extend value of type ${TYPE_STR[found.type]} with a dotted key`,
				undefined,
				key.span,
			);
		}
	}
	return table;
}

interface Header {
	readonly path: Key[];
	readonly key: Key | undefined;
	readonly span: Span;
	readonly isArray: boolean;
}

function onTable(open: Event, input: Events): Header {
	let path: Key[] = [];
	let key: Key | undefined;
	let current = open.span;
	for (let event = input.next(); event !== undefined; event = input.next()) {
		if (event.kind === 'arrayTableClose' || event.kind === 'stdTableClose') {
			current = span(current.start, event.span.end);
			break;
		}
		if (event.kind === 'simpleKey') [path, key] = onKey(event, input);
	}
	return { path, key, span: current, isArray: open.kind === 'arrayTableOpen' };
}

class State {
	root = new DeTable();
	current = new DeTable();
	header: Header | undefined;

	captureKeyValue(path: Key[], key: Key, item: Spanned): void {
		const dotted = path.length > 0;
		const parent = descend(this.current, path, dotted);
		if (dotted && !parent.implicit)
			report('duplicate key', undefined, key.span);
		if (parent.entries.has(key.text))
			report('duplicate key', undefined, key.span);
		parent.entries.set(key.text, { keySpan: key.span, item });
	}

	finishTable(): void {
		const previous = this.current;
		this.current = new DeTable();
		const header = this.header;
		this.header = undefined;
		if (header === undefined) {
			this.root = previous;
			return;
		}
		if (header.key === undefined) return;
		const item: Spanned = {
			value: { type: 'table', table: previous },
			span: header.span,
		};
		const parent = descend(this.root, header.path, false);
		if (!header.isArray) {
			parent.entries.set(header.key.text, { keySpan: header.key.span, item });
			return;
		}
		let entry = parent.entries.get(header.key.text);
		if (entry === undefined) {
			entry = {
				keySpan: header.key.span,
				item: {
					value: { type: 'array', items: [], arrayOfTables: true },
					span: header.span,
				},
			};
			parent.entries.set(header.key.text, entry);
		}
		const array = entry.item.value;
		if (array.type !== 'array' || !array.arrayOfTables)
			report('duplicate key', undefined, header.key.span);
		array.items.push(item);
	}

	startTable(header: Header): void {
		if (!header.isArray && header.key !== undefined) {
			const parent = descend(this.root, header.path, false);
			const old = parent.entries.get(header.key.text);
			if (old !== undefined) {
				// shift_remove: the others keep their places, and this one is re-inserted at the end.
				parent.entries.delete(header.key.text);
				const value = old.item.value;
				if (
					value.type === 'table' &&
					value.table.implicit &&
					!value.table.dotted
				)
					this.current = value.table;
				else report('duplicate key', undefined, header.key.span);
			}
		}
		this.current.implicit = false;
		this.current.dotted = false;
		this.header = header;
	}
}

/** The document's tables, or the first error the toml crate's layer reports, thrown. */
export function buildDocument(
	events: readonly Event[],
	bytes: Uint8Array,
): DeTable {
	const input = new Events(events, bytes);
	const state = new State();
	const ignored: readonly EventKind[] = [
		'inlineTableOpen',
		'inlineTableClose',
		'arrayOpen',
		'arrayClose',
		'scalar',
		'valueSep',
		'error',
		'keySep',
		'keyValSep',
		'stdTableClose',
		'arrayTableClose',
	];
	for (let event = input.next(); event !== undefined; event = input.next()) {
		if (ignored.includes(event.kind)) continue;
		if (event.kind === 'stdTableOpen' || event.kind === 'arrayTableOpen') {
			state.finishTable();
			state.startTable(onTable(event, input));
		} else if (event.kind === 'simpleKey') {
			const [path, key] = onKey(event, input);
			if (key === undefined) break;
			let next = input.next();
			if (next === undefined) break;
			if (next.kind === 'whitespace') {
				next = input.next();
				if (next === undefined) break;
			}
			if (next.kind !== 'keyValSep') break;
			if (input.get(0)?.kind === 'whitespace') input.next();
			state.captureKeyValue(path, key, value(input));
		}
	}
	state.finishTable();
	return state.root;
}
