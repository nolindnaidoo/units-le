import type { Quantity } from './grammar';

/**
 * The crate's `locate.rs` and `position.rs`. A quantity is reported as the
 * text that produced it, so it is placed by a forward-only search sharing one
 * cursor. Lines and columns are 1-based, and a column counts UTF-16 units —
 * which is what a JavaScript index already is.
 */

export interface Position {
	readonly line: number;
	readonly column: number;
}

export interface Found extends Quantity {
	readonly key?: string;
	readonly line?: number;
	readonly column?: number;
}

export type Harvest =
	| {
			readonly kind: 'fields';
			readonly fields: ReadonlyArray<readonly [Quantity, string | null]>;
	  }
	| {
			readonly kind: 'runs';
			readonly runs: ReadonlyArray<readonly [Quantity, number]>;
	  };

class PositionIndex {
	private readonly lineStarts: number[] = [0];

	constructor(text: string) {
		for (
			let index = text.indexOf('\n');
			index !== -1;
			index = text.indexOf('\n', index + 1)
		) {
			this.lineStarts.push(index + 1);
		}
	}

	at(offset: number): Position {
		let low = 0;
		let high = this.lineStarts.length;
		// partition_point(start <= offset) - 1
		while (low < high) {
			const middle = (low + high) >>> 1;
			if ((this.lineStarts[middle] as number) <= offset) low = middle + 1;
			else high = middle;
		}
		const line = low - 1;
		return {
			line: line + 1,
			column: offset - (this.lineStarts[line] as number) + 1,
		};
	}
}

const placed = (
	quantity: Quantity,
	key: string | null,
	position: Position | undefined,
): Found => ({
	...quantity,
	...(key === null ? {} : { key }),
	...(position === undefined ? {} : position),
});

export function locate(text: string, harvest: Harvest): Found[] {
	const index = new PositionIndex(text);
	if (harvest.kind === 'runs')
		return harvest.runs.map(([quantity, offset]) =>
			placed(quantity, null, index.at(offset)),
		);
	let cursor = 0;
	return harvest.fields.map(([quantity, key]) => {
		const at = text.indexOf(quantity.value, cursor);
		if (at === -1) return placed(quantity, key, undefined);
		cursor = at + quantity.value.length;
		return placed(quantity, key, index.at(at));
	});
}
