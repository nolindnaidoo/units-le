import { describe, expect, it } from 'vitest';
import { extract } from '../extract';
import { formatReport } from './format';

const report = (
	content: string,
	format: Parameters<typeof extract>[1],
	unparsed?: string,
) =>
	formatReport({ file: 'x', format, rows: extract(content, format), unparsed });

describe('the report', () => {
	it('says when a document holds no quantities', () => {
		const text = report('timeout: 30\n', 'yaml');
		expect(text).toContain(
			'`x` · yaml · 0 quantit(ies), 0 could not be resolved',
		);
		expect(text).toContain('No quantities found.');
	});

	it("groups by dimension, in the engine's order, with the value in its base unit", () => {
		const text = report('a: 60Hz\nb: 15%\nc: 1KiB\nd: 2s\n', 'yaml');
		const order = [
			'## duration (1)',
			'## bytes (1)',
			'## percent (1)',
			'## frequency (1)',
		].map((heading) => text.indexOf(heading));
		expect(
			order.every(
				(at, index) =>
					at !== -1 && (index === 0 || at > (order[index - 1] as number)),
			),
		).toBe(true);
		expect(text).toContain('`15%` · → `0.15` ratio');
	});

	it('names the dimension a refusal claims, and none where the unit itself is the question', () => {
		const text = report('a: 1.5KB\nb: 500m\n', 'yaml');
		expect(text).toContain('`1.5KB` · bytes · key `a`');
		expect(text).toContain('`500m` · key `b`');
	});

	it('marks a quantity it could not place in the text', () => {
		const text = report('{"k": "1\\u0073"}', 'json');
		expect(text).toContain('- **—** · `1s` · → `1000` milliseconds · key `k`');
	});

	it('quotes the parser when a document does not parse, and keeps a backtick from closing a code span', () => {
		const text = formatReport({
			file: 'a`b',
			format: 'toml',
			rows: [],
			unparsed: 'Failed to parse TOML: x\n',
		});
		expect(text).toContain('```\nFailed to parse TOML: x\n```');
		expect(text).toContain("`a'b`");
	});
});
