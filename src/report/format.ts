import * as vscode from 'vscode';
import { DIMENSIONS, type Found } from '../extract';

export interface ReportInput {
	readonly file: string;
	readonly format: string;
	readonly rows: readonly Found[];
	/** The parser's message, when a structured document did not parse. */
	readonly unparsed: string | undefined;
	/** Whether each row leads with its line and column. On unless said otherwise. */
	readonly positions?: boolean;
}

/**
 * The report a person reads, as Markdown: the quantities grouped by dimension
 * with their value in the base unit, then every quantity that could not be
 * resolved with the reason — never dropped.
 */
export function formatReport({
	file,
	format,
	rows,
	unparsed,
	positions = true,
}: ReportInput): string {
	const refusals = rows.filter((row) => row.base === null);
	const resolved = rows.length - refusals.length;
	const lines: string[] = [`# ${vscode.l10n.t('Units-LE report')}`, ''];
	lines.push(
		`${code(file)} · ${format} · ${vscode.l10n.t('{0} quantit(ies), {1} could not be resolved', resolved, refusals.length)}`,
		'',
	);
	if (unparsed !== undefined) lines.push('```', unparsed.trimEnd(), '```', '');
	if (rows.length === 0) {
		lines.push(vscode.l10n.t('No quantities found.'), '');
		return lines.join('\n');
	}

	for (const dimension of DIMENSIONS) {
		const ofDimension = rows.filter(
			(row) => row.base !== null && row.dimension === dimension,
		);
		if (ofDimension.length === 0) continue;
		lines.push(`## ${dimension} (${ofDimension.length})`, '');
		for (const row of ofDimension) {
			lines.push(item(row, positions));
			// The SI hazard is the one reason that comes with a value: reported, and flagged.
			if (row.reason !== undefined)
				lines.push('', `  ${row.reason}: ${row.detail}`, '');
		}
		lines.push('');
	}

	if (refusals.length > 0) {
		lines.push(
			`## ${vscode.l10n.t('Could not be resolved ({0})', refusals.length)}`,
			'',
		);
		for (const row of refusals)
			lines.push(
				item(row, positions),
				'',
				`  ${row.reason}: ${row.detail}`,
				'',
			);
	}
	return lines.join('\n');
}

/** One row: where, if asked for, then what, its value in the base unit, and its key. */
function item(row: Found, positions: boolean): string {
	const where = row.line === undefined ? '—' : `${row.line}:${row.column}`;
	const parts = positions
		? [`**${where}**`, code(row.value)]
		: [code(row.value)];
	if (row.base !== null) parts.push(`→ ${code(row.base)} ${row.baseUnit}`);
	else if (row.dimension !== null) parts.push(row.dimension);
	if (row.key !== undefined)
		parts.push(`${vscode.l10n.t('key')} ${code(row.key)}`);
	return `- ${parts.join(' · ')}`;
}

/** Text as a code span. A code span cannot escape a backtick, so one becomes a quote. */
function code(text: string): string {
	return `\`${text.replace(/`/g, "'").replace(/\r?\n/g, ' ')}\``;
}
