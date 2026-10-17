/**
 * Reading files and shaping the report, as the Rust CLI's `scan.rs` does.
 *
 * One report per text file. A binary file, a NUL in its first 8 KiB, is not a
 * candidate: it produces no report and is counted. A text file that could not
 * be read is reported with the reason.
 */
import { readFileSync } from 'node:fs';
import { basename, sep } from 'node:path';
import {
	extract,
	type Format,
	type Found,
	parseError,
	resolveFormat,
} from '../extract';
import type { ScanOptions } from './args';
import { decodeUtf8OrThrow, rustIoMessage, withoutBom } from './ioError';

interface Diagnostic {
	readonly severity: 'warning';
	readonly code: 'skipped' | 'unparsed';
	readonly message: string;
}

export interface FileReport {
	readonly schema: 1;
	readonly file: string;
	readonly format: Format;
	readonly quantities: readonly Found[];
	readonly diagnostics: readonly Diagnostic[];
	readonly summary: { readonly quantities: number; readonly refused: number };
}

/** A report, or null for a binary file. */
export function scanFile(
	path: string,
	options: ScanOptions,
): FileReport | null {
	const file = sep === '/' ? path : path.split(sep).join('/');
	const format = options.format ?? resolveFormat(undefined, basename(path));
	let bytes: Buffer;
	try {
		bytes = readFileSync(path);
	} catch (error) {
		return skipped(file, format, rustIoMessage(error));
	}
	if (bytes.subarray(0, 8192).includes(0)) return null;
	let content: string;
	try {
		content = decodeUtf8OrThrow(bytes);
	} catch {
		return skipped(file, format, 'not UTF-8 text');
	}
	return scanContent(withoutBom(content), file, format, options);
}

export function scanContent(
	content: string,
	file: string,
	format: Format,
	options: ScanOptions,
): FileReport {
	const quantities = extract(content, format, options.dimension).map(
		crateOrder,
	);
	const unparsed = parseError(content, format);
	return Object.freeze({
		schema: 1,
		file,
		format,
		quantities,
		diagnostics:
			unparsed === undefined
				? []
				: [
						{
							severity: 'warning' as const,
							code: 'unparsed' as const,
							message: unparsed,
						},
					],
		summary: {
			quantities: quantities.length,
			refused: quantities.filter((found) => found.base === null).length,
		},
	});
}

/** `Found`'s serde order: the flattened quantity, the key, then the position. */
function crateOrder(found: Found): Found {
	return {
		value: found.value,
		dimension: found.dimension,
		baseUnit: found.baseUnit,
		base: found.base,
		...(found.reason === undefined ? {} : { reason: found.reason }),
		...(found.detail === undefined ? {} : { detail: found.detail }),
		...(found.key === undefined ? {} : { key: found.key }),
		...(found.line === undefined
			? {}
			: { line: found.line, column: found.column }),
	};
}

function skipped(file: string, format: Format, message: string): FileReport {
	return Object.freeze({
		schema: 1,
		file,
		format,
		quantities: [],
		diagnostics: [
			{ severity: 'warning' as const, code: 'skipped' as const, message },
		],
		summary: { quantities: 0, refused: 0 },
	});
}

export function wasSkipped(report: FileReport): boolean {
	return report.diagnostics.some((diagnostic) => diagnostic.code === 'skipped');
}

/** grep's convention, with a refusal or an unread file failing only `--strict`. */
export function exitCode(
	reports: readonly FileReport[],
	strict: boolean,
): number {
	const incomplete = reports.some((report) =>
		report.diagnostics.some(
			(diagnostic) => (diagnostic.severity as string) === 'error',
		),
	);
	if (incomplete) return 2;
	const unsure = reports.some(
		(report) => wasSkipped(report) || report.summary.refused > 0,
	);
	if (strict && unsure) return 2;
	return reports.some((report) => report.summary.quantities > 0) ? 0 : 1;
}

export function describe(report: FileReport, found: Found): string {
	const at =
		found.line === undefined
			? `${report.file}:-`
			: `${report.file}:${found.line}:${found.column}`;
	const answer =
		found.base !== null && found.baseUnit !== null
			? `${found.base} ${found.baseUnit}`
			: `refused: ${found.reason ?? 'unknown'}`;
	return `${at}  ${found.value}  ${answer}`;
}
