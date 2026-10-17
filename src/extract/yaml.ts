import { loadYaml, type YamlNode as Node } from '../parsers/yaml/load';
import { collect, type Field, OTHER, type Value } from './policy';

/** units-le's reading of saphyr's tree: text leaves, and key paths. */
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

export function extractYaml(text: string): Field[] {
	const documents = loadYaml(text);
	if (typeof documents === 'string') return [];
	// A multi-document file is a sequence of documents, so a key in the second is `[1].timeout`.
	const [single] = documents;
	if (documents.length === 1 && single !== undefined)
		return collect(convert(single));
	return collect({ type: 'seq', items: documents.map(convert) });
}

export function yamlParseError(text: string): string | undefined {
	const documents = loadYaml(text);
	return typeof documents === 'string'
		? `Failed to parse YAML: ${documents}`
		: undefined;
}
