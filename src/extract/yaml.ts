import { collect, type Field, OTHER, type Value } from './policy';
import {
	type Event,
	isCoreSchema,
	Parser,
	type Receiver,
	type Tag,
} from './yaml/parser';
import { ScanError, UnboundedScan } from './yaml/scanner';

/**
 * The crate's `yaml.rs`, over saphyr 0.1.0's `Yaml::load_from_str`: its
 * loader (`loader.rs`) and its core-schema scalar typing (`scalar.rs`).
 *
 * `timeout: 30s` is a string because `30s` is not a core-schema number, and
 * only a string is a candidate. A key is spelled where it is a string, an
 * integer or a boolean; any other key leaves its subtree with no path.
 */

type Node =
	| { readonly k: 'str'; readonly v: string }
	| { readonly k: 'int'; readonly v: bigint }
	| { readonly k: 'float'; readonly v: number }
	| { readonly k: 'bool'; readonly v: boolean }
	| { readonly k: 'null' }
	| { readonly k: 'seq'; readonly items: Node[] }
	| {
			readonly k: 'map';
			readonly entries: Map<string, { key: Node; value: Node }>;
	  }
	| { readonly k: 'tagged'; readonly tag: Tag; readonly node: Node }
	| { readonly k: 'bad' };

const BAD: Node = { k: 'bad' };

/** A string that is equal for two nodes exactly when saphyr's derived `Eq` says they are. */
function identity(node: Node): string {
	switch (node.k) {
		case 'str':
			return `s${JSON.stringify(node.v)}`;
		case 'int':
			return `i${node.v}`;
		case 'float':
			// OrderedFloat: every NaN is equal, and 0.0 equals -0.0.
			return `f${Number.isNaN(node.v) ? 'nan' : String(node.v)}`;
		case 'bool':
			return `b${node.v}`;
		case 'null':
			return 'n';
		case 'seq':
			return `[${node.items.map(identity).join(',')}]`;
		case 'map':
			return `{${[...node.entries.values()].map(({ key, value }) => `${identity(key)}:${identity(value)}`).join(',')}}`;
		case 'tagged':
			return `t${JSON.stringify(node.tag.handle)}${JSON.stringify(node.tag.suffix)}(${identity(node.node)})`;
		case 'bad':
			return 'x';
	}
}

/** `i64::from_str_radix`: one optional sign, at least one digit of the radix, and no overflow. */
function parseI64(text: string, radix: 8 | 10 | 16): bigint | undefined {
	const digits = radix === 16 ? '[0-9a-fA-F]' : radix === 8 ? '[0-7]' : '[0-9]';
	const match = new RegExp(`^([+-]?)(${digits}+)$`).exec(text);
	if (match === null) return undefined;
	const prefix = radix === 16 ? '0x' : radix === 8 ? '0o' : '';
	const magnitude = BigInt(`${prefix}${match[2]}`);
	const value = match[1] === '-' ? -magnitude : magnitude;
	if (value < -(2n ** 63n) || value > 2n ** 63n - 1n) return undefined;
	return value;
}

/** `parse_core_schema_fp`: the YAML spellings, else Rust's `f64::from_str` on text holding a digit. */
function parseCoreFloat(text: string): number | undefined {
	if (['.inf', '.Inf', '.INF', '+.inf', '+.Inf', '+.INF'].includes(text))
		return Number.POSITIVE_INFINITY;
	if (['-.inf', '-.Inf', '-.INF'].includes(text))
		return Number.NEGATIVE_INFINITY;
	if (['.nan', '.NaN', '.NAN'].includes(text)) return Number.NaN;
	if (!/[0-9]/.test(text)) return undefined;
	// Digits with an optional point, or a point and digits, then an optional exponent.
	if (!/^[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?$/.test(text))
		return undefined;
	return Number(text);
}

/** `Scalar::parse_from_cow`: the guess an untagged plain scalar gets. */
function parseFromCow(text: string): Node {
	if (text.length >= 2) {
		const radix = text.startsWith('0x')
			? 16
			: text.startsWith('0o')
				? 8
				: undefined;
		if (radix !== undefined) {
			const value = parseI64(text.slice(2), radix);
			if (value !== undefined) return { k: 'int', v: value };
		} else if (text.startsWith('+')) {
			const value = parseI64(text.slice(1), 10);
			if (value !== undefined) return { k: 'int', v: value };
		}
	}
	if (text === '~') return { k: 'null' };
	if (text === 'null' || text === 'Null' || text === 'NULL')
		return { k: 'null' };
	if (text === 'true' || text === 'True' || text === 'TRUE')
		return { k: 'bool', v: true };
	if (text === 'false' || text === 'False' || text === 'FALSE')
		return { k: 'bool', v: false };
	const integer = parseI64(text, 10);
	if (integer !== undefined) return { k: 'int', v: integer };
	const float = parseCoreFloat(text);
	if (float !== undefined) return { k: 'float', v: float };
	return { k: 'str', v: text };
}

/** `Yaml::value_from_cow_and_metadata`. */
function scalar(text: string, plain: boolean, tag: Tag | undefined): Node {
	if (tag !== undefined && !isCoreSchema(tag))
		return { k: 'tagged', tag, node: scalar(text, plain, undefined) };
	if (!plain) return { k: 'str', v: text };
	if (tag === undefined) return parseFromCow(text);
	switch (tag.suffix) {
		case 'bool':
			return text === 'true'
				? { k: 'bool', v: true }
				: text === 'false'
					? { k: 'bool', v: false }
					: BAD;
		case 'int': {
			const value = parseI64(text, 10);
			return value === undefined ? BAD : { k: 'int', v: value };
		}
		case 'float': {
			const value = parseCoreFloat(text);
			return value === undefined ? BAD : { k: 'float', v: value };
		}
		case 'null':
			return text === '~' || text === 'null' ? { k: 'null' } : BAD;
		case 'str':
			return { k: 'str', v: text };
		default:
			return BAD;
	}
}

/** saphyr's `YamlLoader`, with `early_parse` on. */
class Loader implements Receiver {
	readonly docs: Node[] = [];
	private readonly docStack: Array<[Node, number, Tag | undefined]> = [];
	private readonly keyStack: Node[] = [];
	private readonly anchorMap = new Map<number, Node>();

	onEvent(event: Event): void {
		switch (event.e) {
			case 'DocumentEnd':
				this.docs.push(
					this.docStack.length === 0
						? BAD
						: (this.docStack.pop() as [Node, number, Tag | undefined])[0],
				);
				return;
			case 'SequenceStart':
				this.docStack.push([{ k: 'seq', items: [] }, event.anchor, event.tag]);
				return;
			case 'MappingStart':
				this.docStack.push([
					{ k: 'map', entries: new Map() },
					event.anchor,
					event.tag,
				]);
				this.keyStack.push(BAD);
				return;
			case 'MappingEnd':
			case 'SequenceEnd': {
				if (event.e === 'MappingEnd') this.keyStack.pop();
				let [node, anchor, tag] = this.docStack.pop() as [
					Node,
					number,
					Tag | undefined,
				];
				if (tag !== undefined && !isCoreSchema(tag))
					node = { k: 'tagged', tag, node };
				this.insert(node, anchor, undefined);
				return;
			}
			case 'Scalar':
				this.insert(
					scalar(event.value, event.style === 'plain', event.tag),
					event.anchor,
					event.tag,
				);
				return;
			case 'Alias':
				this.insert(this.anchorMap.get(event.id) ?? BAD, 0, undefined);
				return;
			default:
				return;
		}
	}

	private insert(node: Node, anchor: number, tag: Tag | undefined): void {
		if (anchor > 0) this.anchorMap.set(anchor, node);
		const top = this.docStack.at(-1);
		if (top === undefined) {
			this.docStack.push([node, anchor, tag]);
			return;
		}
		const parent = top[0];
		let child = node;
		if (
			tag !== undefined &&
			(child.k === 'seq' || child.k === 'map') &&
			!isCoreSchema(tag)
		) {
			child = { k: 'tagged', tag, node: child };
		}
		if (parent.k === 'seq') {
			parent.items.push(child);
		} else if (parent.k === 'map') {
			const key = this.keyStack.at(-1) as Node;
			if (key.k === 'bad') {
				this.keyStack[this.keyStack.length - 1] = child;
			} else {
				this.keyStack[this.keyStack.length - 1] = BAD;
				// hashlink's insert: a repeated key keeps its first spelling, takes the new value, and moves to the back.
				const id = identity(key);
				const existing = parent.entries.get(id);
				parent.entries.delete(id);
				parent.entries.set(id, { key: existing?.key ?? key, value: child });
			}
		}
	}
}

function load(text: string): Node[] {
	const loader = new Loader();
	new Parser(text).load(loader);
	return loader.docs;
}

function convert(node: Node): Value {
	if (node.k === 'str') return { type: 'text', text: node.v };
	if (node.k === 'seq') return { type: 'seq', items: node.items.map(convert) };
	if (node.k === 'map') {
		return {
			type: 'map',
			entries: [...node.entries.values()].map(
				({ key, value }) => [keyOf(key), convert(value)] as const,
			),
		};
	}
	return OTHER;
}

function keyOf(node: Node): string | null {
	if (node.k === 'str') return node.v;
	if (node.k === 'int') return node.v.toString();
	if (node.k === 'bool') return String(node.v);
	return null;
}

/** What loading produced: the documents, or why there are none. */
function outcome(text: string): Node[] | string {
	try {
		return load(text);
	} catch (error) {
		if (error instanceof ScanError) return error.message;
		if (error instanceof UnboundedScan) {
			return 'a directive runs to the end of the document with no line break after it, which the crate never returns from';
		}
		throw error;
	}
}

export function extractYaml(text: string): Field[] {
	const documents = outcome(text);
	if (typeof documents === 'string') return [];
	// A multi-document file is a sequence of documents, so a key in the second is `[1].timeout`.
	const [single] = documents;
	if (documents.length === 1 && single !== undefined)
		return collect(convert(single));
	return collect({ type: 'seq', items: documents.map(convert) });
}

export function yamlParseError(text: string): string | undefined {
	const documents = outcome(text);
	return typeof documents === 'string'
		? `Failed to parse YAML: ${documents}`
		: undefined;
}

/** Whether this is the one input the crate's YAML library never returns from, so a differential can leave it out. */
export function yamlNeverReturns(text: string): boolean {
	try {
		load(text);
		return false;
	} catch (error) {
		return error instanceof UnboundedScan;
	}
}
