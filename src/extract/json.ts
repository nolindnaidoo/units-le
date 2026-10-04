import { JsoncError, type JsonValue, parseJsonc } from './jsonc';
import { collect, type Field, OTHER, type Value } from './policy';

/** The crate's `json.rs`. Only strings are candidates; `"timeout": 30` has no unit. */

function parsed(text: string, loose: boolean): JsonValue | undefined {
	try {
		return parseJsonc(text, loose);
	} catch (error) {
		if (error instanceof JsoncError) return undefined;
		throw error;
	}
}

function convert(node: JsonValue): Value {
	if (node.type === 'string') return { type: 'text', text: node.value };
	if (node.type === 'array')
		return { type: 'seq', items: node.elements.map(convert) };
	if (node.type === 'object')
		return {
			type: 'map',
			entries: node.properties.map(
				(property) => [property.name, convert(property.value)] as const,
			),
		};
	return OTHER;
}

export function extractJson(text: string, loose: boolean): Field[] {
	const root = parsed(text, loose);
	return collect(root === undefined ? OTHER : convert(root));
}

export function jsonParseError(
	text: string,
	loose: boolean,
): string | undefined {
	try {
		// jsonc-parser reads an empty document as a parse of nothing; JSON.parse("") throws.
		if (parseJsonc(text, loose) === undefined)
			return 'Failed to parse JSON: unexpected end of input';
		return undefined;
	} catch (error) {
		if (error instanceof JsoncError)
			return `Failed to parse JSON: ${error.message}`;
		throw error;
	}
}
