/**
 * The crate's `policy.rs`: a quantity is a string value. Every reader
 * normalises its document into a `Value`, and `collect` walks it in
 * document order with a dotted, bracketed key path.
 */

export interface Field {
	/** `cache.ttl`, `limits[0]`; null where the format has no path or a key cannot be spelled. */
	readonly key: string | null;
	readonly text: string;
}

export type Value =
	| { readonly type: 'text'; readonly text: string }
	| { readonly type: 'other' }
	| { readonly type: 'seq'; readonly items: readonly Value[] }
	| {
			readonly type: 'map';
			readonly entries: ReadonlyArray<readonly [string | null, Value]>;
	  };

export const OTHER: Value = Object.freeze({ type: 'other' });

export function collect(value: Value): Field[] {
	const out: Field[] = [];
	walk(value, '', out);
	return out;
}

function walk(value: Value, path: string | null, out: Field[]): void {
	if (value.type === 'text') {
		out.push({ key: path === '' ? null : path, text: value.text });
	} else if (value.type === 'seq') {
		value.items.forEach((item, index) => {
			walk(item, path === null ? null : `${path}[${index}]`, out);
		});
	} else if (value.type === 'map') {
		for (const [key, item] of value.entries) {
			walk(
				item,
				path === null || key === null
					? null
					: path === ''
						? key
						: `${path}.${key}`,
				out,
			);
		}
	}
}
