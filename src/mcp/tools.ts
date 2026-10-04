import {
	DIMENSIONS,
	type Dimension,
	extract,
	parseError,
	resolveFormat,
	SUPPORTED_FORMATS,
} from '../extract';
import {
	DEFAULT_MAX_RESULTS,
	type Diagnostic,
	envelope,
	MAX_MAX_RESULTS,
} from './envelope';
import type { ToolDefinition } from './transport';

/**
 * `extract_units`, which the crate's server (`crate/src/mcp/extract.rs`)
 * offers under the same name and schema. The two must answer identically:
 * the shared corpus and the differential hold them to it, and
 * `scripts/check-mcp-definition.ts` holds the definitions equal.
 */

const DESCRIPTION =
	'Extract every quantity — a number with a unit — from a document, with the text as written and its value in one base unit: durations in milliseconds, sizes in bytes, percentages as a ratio, frequencies in hertz. Parses JSON, YAML, CSV, TOML, INI and dotenv; anything else is scanned as text, so a format is optional. A quantity it cannot resolve — a bare `m`, a fractional `1.5KB`, a locale-shaped `1,5s`, an expression like `1h + 30m`, an SI byte multiple that may have meant the binary one — is returned with a named reason instead of a guess. A bare number with no unit is not a finding.';

/** Strict, as the crate is: a cap outside 1–5000 is a malformed question, not an ambitious one. */
function readMaxResults(args: Record<string, unknown>): number {
	if (!Object.hasOwn(args, 'maxResults') || args.maxResults === undefined)
		return DEFAULT_MAX_RESULTS;
	const raw = args.maxResults;
	if (
		typeof raw !== 'number' ||
		!Number.isInteger(raw) ||
		raw < 1 ||
		raw > MAX_MAX_RESULTS
	) {
		throw new Error(
			`maxResults must be a whole number between 1 and ${MAX_MAX_RESULTS}`,
		);
	}
	return raw;
}

function readDimension(args: Record<string, unknown>): Dimension | undefined {
	if (!Object.hasOwn(args, 'dimension') || args.dimension === undefined)
		return undefined;
	const name = args.dimension;
	if (typeof name !== 'string') throw new Error('dimension must be a string');
	const found = DIMENSIONS.find(
		(dimension) => dimension === name.toLowerCase(),
	);
	if (found === undefined)
		throw new Error(
			`${name} is not a dimension. It is one of ${DIMENSIONS.join(', ')}.`,
		);
	return found;
}

function extractUnits(args: Record<string, unknown>): Promise<unknown> {
	if (typeof args.content !== 'string')
		throw new Error('content is required and must be a string');
	const content = args.content;
	const maxResults = readMaxResults(args);
	const dimension = readDimension(args);
	// Never a refusal: an agent that knows nothing about a document still gets its quantities.
	const format = resolveFormat(
		typeof args.format === 'string' ? args.format : undefined,
		typeof args.filename === 'string' ? args.filename : undefined,
	);
	const unparsed = parseError(content, format);
	const diagnostics: Diagnostic[] =
		unparsed === undefined
			? []
			: [{ severity: 'error', code: 'parse-error', message: unparsed }];
	const found = extract(content, format, dimension);
	// Counted before the cap, as the crate counts it.
	const refused = found.filter((one) => one.base === null).length;
	const truncated = found.length > maxResults;
	const quantities = found.slice(0, maxResults);
	return Promise.resolve(
		envelope(
			'extract_units',
			{ quantities, fileType: format, refused },
			quantities.length,
			diagnostics,
			truncated,
		),
	);
}

export const TOOLS: readonly ToolDefinition[] = Object.freeze([
	Object.freeze({
		name: 'extract_units',
		description: DESCRIPTION,
		inputSchema: {
			type: 'object',
			properties: {
				content: { type: 'string', description: 'The document text to scan.' },
				format: {
					type: 'string',
					enum: SUPPORTED_FORMATS,
					description:
						'Document format. Optional — an unrecognised or absent format scans the text directly.',
				},
				filename: {
					type: 'string',
					description:
						'Filename used to infer the format when `format` is absent, e.g. "config.toml".',
				},
				dimension: {
					type: 'string',
					enum: DIMENSIONS,
					description:
						'Report only one dimension. A refusal that names no dimension is always kept, because it could have been the one asked for.',
				},
				maxResults: {
					type: 'integer',
					minimum: 1,
					maximum: MAX_MAX_RESULTS,
					default: DEFAULT_MAX_RESULTS,
					description: `Cap on returned quantities (default ${DEFAULT_MAX_RESULTS}). meta.truncated reports whether any were dropped.`,
				},
			},
			required: ['content'],
			additionalProperties: false,
		},
		handler: extractUnits,
	}),
]);
