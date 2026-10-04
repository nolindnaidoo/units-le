import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DIMENSIONS, extract, type Format, SUPPORTED_FORMATS } from './index';

/**
 * The crate's `fixtures/extraction.json`, run through the port, with the
 * invariants `crate/src/extract/corpus.rs` holds the corpus to.
 */
const CORPUS = join(__dirname, '..', '..', 'crate', 'fixtures');
const document = (name: string) =>
	readFileSync(join(CORPUS, 'documents', name), 'utf8');
const corpus = JSON.parse(
	readFileSync(join(CORPUS, 'extraction.json'), 'utf8'),
) as {
	documents: Array<{
		name: string;
		file: string;
		fileType: Format;
		expected: Array<{ reason: string | null; dimension: string | null }>;
		errors: string[];
	}>;
};
const REASONS = [
	'ambiguous_unit',
	'fractional_bytes',
	'locale_separator',
	'compound_arithmetic',
	'si_iec_hazard',
	'out_of_range',
];

describe('the shared corpus', () => {
	for (const c of corpus.documents) {
		it(`reproduces ${c.name}`, () => {
			expect(c.errors).toEqual([]);
			const rows = extract(document(c.file), c.fileType).map((one) => ({
				value: one.value,
				dimension: one.dimension,
				base: one.base,
				reason: one.reason ?? null,
				key: one.key ?? null,
			}));
			expect(rows).toEqual(c.expected);
		});
	}

	it('covers every reader', () => {
		for (const format of [...SUPPORTED_FORMATS, 'unknown'])
			expect(
				corpus.documents.some((c) => c.fileType === format),
				format,
			).toBe(true);
	});

	it('pins every reason and every dimension', () => {
		const rows = corpus.documents.flatMap((c) => c.expected);
		for (const reason of REASONS)
			expect(
				rows.some((row) => row.reason === reason),
				reason,
			).toBe(true);
		for (const dimension of DIMENSIONS)
			expect(
				rows.some((row) => row.dimension === dimension),
				dimension,
			).toBe(true);
	});

	it('reports every case in the ambiguity set with a reason, and resolves only the SI hazard', () => {
		const text = document('ambiguous.yaml');
		const found = extract(text, 'yaml');
		expect(found).toHaveLength(
			text
				.split('\n')
				.filter((line, i, all) => i < all.length - 1 || line !== '').length,
		);
		expect(found.every((row) => row.reason !== undefined)).toBe(true);
		expect(
			found.filter((row) => row.base !== null).map((row) => row.value),
		).toEqual(['1MB']);
	});
});

describe('the dimension filter', () => {
	it('keeps a refusal that names no dimension, whichever is asked for', () => {
		for (const dimension of DIMENSIONS)
			expect(
				extract('a: 500m\nb: 30s', 'yaml', dimension).map((row) => row.value),
			).toContain('500m');
		expect(
			extract('a: 1.5KB\nb: 30s', 'yaml', 'bytes').map((row) => row.value),
		).toEqual(['1.5KB']);
	});
});

describe('positions', () => {
	it('counts columns in UTF-16 units, and gives a repeated value its own position', () => {
		const found = extract('café: 30s\nb: 30s\n😀: 30s', 'yaml');
		expect(found.map((row) => [row.line, row.column])).toEqual([
			[1, 7],
			[2, 4],
			[3, 5],
		]);
	});
});
