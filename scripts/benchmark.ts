/**
 * Measure real throughput. Run with `bun run benchmark`.
 *
 * Numbers are machine-specific, so the host is recorded alongside them and
 * they are never asserted in CI. Inputs are generated rather than checked in so
 * the sizes are explicit.
 */
import { cpus, totalmem } from 'node:os';
import { extract, type Format } from '../src/extract';

const CASES: ReadonlyArray<{ label: string; format: Format; build: () => string }> = [
	{
		label: 'YAML config',
		format: 'yaml',
		build: () =>
			Array.from(
				{ length: 10_000 },
				(_, i) => `service${i}:\n  timeout: ${i % 90}s\n  cache_ttl: ${i % 24}h${i % 60}m\n  memory: ${64 * ((i % 32) + 1)}MiB\n  cpu: ${100 * ((i % 8) + 1)}m\n  headroom: ${i % 100}%`,
			).join('\n'),
	},
	{
		label: 'TOML config',
		format: 'toml',
		build: () =>
			Array.from({ length: 10_000 }, (_, i) => `[service${i}]\ntimeout = "${i % 90}s"\nmemory = "${64 * ((i % 32) + 1)}MiB"\nretries = ${i % 5}\nwindow = "PT${(i % 23) + 1}H"`).join('\n'),
	},
	{
		label: 'Log, scanned as text',
		format: 'unknown',
		build: () =>
			Array.from({ length: 40_000 }, (_, i) => `2026-08-12T10:${String(i % 60).padStart(2, '0')}:00Z level=info request ${i} took ${i % 900}ms, sent ${i % 512}KiB, cache ${i % 100}% warm`).join('\n'),
	},
];

const WARMUP = 2;
const RUNS = 7;
const median = (xs: readonly number[]) => {
	const s = [...xs].sort((a, b) => a - b);
	const mid = Math.floor(s.length / 2);
	return s.length % 2 ? (s[mid] as number) : ((s[mid - 1] as number) + (s[mid] as number)) / 2;
};

const results: Array<Record<string, unknown>> = [];
for (const c of CASES) {
	const content = c.build();
	const bytes = Buffer.byteLength(content, 'utf8');
	const run = () => extract(content, c.format).length;
	for (let i = 0; i < WARMUP; i++) run();
	const durations: number[] = [];
	let count = 0;
	for (let i = 0; i < RUNS; i++) {
		const t0 = performance.now();
		count = run();
		durations.push(performance.now() - t0);
	}
	const ms = median(durations);
	results.push({
		label: c.label,
		bytes,
		lines: content.split('\n').length,
		extracted: count,
		ms: Number(ms.toFixed(2)),
		perSecond: count > 0 ? Math.round(count / (ms / 1000)) : null,
		mbPerSecond: Number((bytes / 1_048_576 / (ms / 1000)).toFixed(1)),
	});
	console.log(`${c.label.padEnd(18)} ${(bytes / 1_048_576).toFixed(2)} MB  ${String(count).padStart(7)}  ${ms.toFixed(2)} ms`);
}
const cpu = cpus()[0]?.model ?? 'unknown CPU';
await Bun.write(
	'benchmark-results.json',
	`${JSON.stringify({ host: `${cpu}, ${Math.round(totalmem() / 1_073_741_824)} GB RAM, Node ${process.versions.node}`, runs: RUNS, results }, null, 2)}\n`,
);
console.log('\nwrote benchmark-results.json');
