import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { parse } from './args';
import { serve } from './mcp';
import { run, summary } from './run';
import { exitCode, describe as line, scanContent } from './scan';
import { FLAGS, USAGE } from './usage';

const EVERYTHING = { dimension: undefined, format: null };

describe('usage', () => {
	it('names every flag the parser accepts, and no other', () => {
		const named = new Set(
			USAGE.split(/\s+/)
				.filter((word) => word.startsWith('--'))
				.map((word) => word.replace(/[,.:;)]+$/, ''))
				.filter((word) => word !== '--version' && word !== '--help'),
		);
		expect([...named].sort()).toEqual([...FLAGS].sort());
	});
});

describe('parse', () => {
	it('lowercases a dimension, as the crate does', () => {
		expect(parse(['--dimension', 'BYTES', 'x']).scan.dimension).toBe('bytes');
	});

	it('refuses what the crate refuses, in its words', () => {
		expect(() => parse(['--dimension', 'mass', 'x'])).toThrow(
			'mass is not a dimension. Try duration, bytes, percent or frequency.',
		);
		expect(() => parse(['--dimension'])).toThrow('--dimension needs a name');
		expect(() => parse(['--stdin', 'x'])).toThrow('takes no file arguments');
		expect(() => parse([])).toThrow('name a file or a directory to read');
	});
});

describe('scanContent', () => {
	it("writes a quantity in the crate's field order", () => {
		const report = scanContent('{"t": "30s"}', 'a.json', 'json', EVERYTHING);
		expect(Object.keys(report.quantities[0] ?? {})).toEqual([
			'value',
			'dimension',
			'baseUnit',
			'base',
			'key',
			'line',
			'column',
		]);
	});

	it('marks a quantity it cannot place with a dash', () => {
		const report = scanContent(
			'{"t": "30\\u0073"}',
			'a.json',
			'json',
			EVERYTHING,
		);
		const [found] = report.quantities;
		expect(found && line(report, found)).toBe(
			'a.json:-  30s  30000 milliseconds',
		);
	});
});

describe('exitCode', () => {
	it('follows grep, and fails a refusal only under --strict', () => {
		const found = scanContent('5s', 'a', 'unknown', EVERYTHING);
		const refused = scanContent('500m', 'b', 'unknown', EVERYTHING);
		expect(exitCode([found], false)).toBe(0);
		expect(exitCode([refused], true)).toBe(2);
		expect(summary([found, refused], 2)).toMatch(
			/2 quantities in 2 files\n2 binary files skipped\n1 quantity refused, each with a reason\n$/,
		);
	});
});

describe('run', () => {
	it('keeps a byte-order mark on stdin, as the crate does', async () => {
		const out: string[] = [];
		const code = await run(['--stdin', '--format', 'json'], {
			stdout: (text) => out.push(text),
			stderr: () => {},
			stdoutIsTerminal: false,
			readStdin: async () => Buffer.from('﻿{"a": "5s"}'),
			version: '9.9.9',
		});
		const report = JSON.parse(out.join(''));
		// The mark stops the JSON parsing, so nothing is found: exit 1.
		expect([code, report.diagnostics[0]?.code]).toEqual([1, 'unparsed']);
	});
});

describe('mcp', () => {
	it('offers both tools, keys sorted', async () => {
		const written: string[] = [];
		const request = { jsonrpc: '2.0', id: 1, method: 'tools/list' };
		await serve(
			Readable.from([Buffer.from(`${JSON.stringify(request)}\n`)]),
			(reply) => written.push(reply),
			'9.9.9',
		);
		const reply = JSON.parse(written[0] ?? '{}');
		expect(
			reply.result.tools.map((tool: { name: string }) => tool.name),
		).toEqual(['extract_units', 'units_le_scan']);
	});
});
