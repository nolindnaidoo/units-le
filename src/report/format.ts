import * as vscode from 'vscode';
import { DIMENSIONS, type Found } from '../extract';
import {
	type ScanLimits,
	type ScanSummary,
	unreadNotes,
} from '../workspace/scan';

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

export interface FileRows {
	readonly file: string;
	readonly format: string;
	/** The rows this report lists for the file, which may be fewer than it holds. */
	readonly rows: readonly Found[];
	/** How many quantities the file holds that resolved. */
	readonly named: number;
	/** How many runs it holds that could not be. */
	readonly refused: number;
}

export interface WorkspaceReportInput {
	/** The folder that was scanned, or undefined for the whole workspace. */
	readonly where: string | undefined;
	readonly files: readonly FileRows[];
	readonly summary: ScanSummary;
	readonly limits: ScanLimits;
	/** Whether the runs that could not be resolved are listed, or only counted. */
	readonly refusalsListed: boolean;
	readonly positions?: boolean;
}

/**
 * The report for a folder or a workspace.
 *
 * It opens with a table of every file that holds something, because a project
 * has too many to find by scrolling. Then one section per file, in path
 * order, and last whatever the scan left unread. A file with nothing in it is
 * counted and not listed.
 */
export function formatWorkspaceReport({
	where,
	files,
	summary,
	limits,
	refusalsListed,
	positions = true,
}: WorkspaceReportInput): string {
	const named = files.reduce((sum, entry) => sum + entry.named, 0);
	const refused = files.reduce((sum, entry) => sum + entry.refused, 0);
	const lines: string[] = [
		`# ${vscode.l10n.t('{0} workspace report', 'Units-LE')}`,
		'',
	];
	const scope = where === undefined ? '' : `${code(where)} · `;
	lines.push(
		`${scope}${vscode.l10n.t('{0} file(s) read', summary.read)} · ${vscode.l10n.t('{0} quantit(ies), {1} could not be resolved', named, refused)}`,
		'',
	);
	if (files.length === 0) lines.push(vscode.l10n.t('No quantities found.'), '');

	if (files.length > 0) {
		lines.push(
			`| ${vscode.l10n.t('File')} | ${vscode.l10n.t('Quantities')} | ${vscode.l10n.t('Could not be resolved')} |`,
			'|---|---|---|',
		);
		for (const entry of files)
			lines.push(
				`| ${code(entry.file).replace(/\|/g, '\\|')} | ${entry.named} | ${entry.refused} |`,
			);
		lines.push('');
	}
	if (refused > 0 && !refusalsListed)
		lines.push(
			`> ${vscode.l10n.t('What could not be read is counted per file and not listed. The {0} setting lists each one.', code('units-le.workspace.scanIncludeRefusals'))}`,
			'',
		);

	for (const entry of files) {
		if (entry.rows.length === 0) continue;
		lines.push(
			`## ${code(entry.file)} · ${entry.format} (${entry.rows.length})`,
			'',
		);
		for (const row of entry.rows) {
			lines.push(item(row, positions, true));
			if (row.base === null)
				lines.push('', `  ${row.reason}: ${row.detail}`, '');
		}
		lines.push('');
	}

	const notes = unreadNotes(summary, limits, code('units-le.workspace.*'));
	if (notes.length > 0) lines.push(...notes.map((note) => `> ${note}`), '');
	return lines.join('\n');
}

/** One row: where, if asked for, then what, its value in the base unit, and its key. */
function item(row: Found, positions: boolean, withKind = false): string {
	const where = row.line === undefined ? '—' : `${row.line}:${row.column}`;
	const parts = positions
		? [`**${where}**`, code(row.value)]
		: [code(row.value)];
	if (row.base !== null) {
		if (withKind && row.dimension !== null) parts.push(row.dimension);
		parts.push(`→ ${code(row.base)} ${row.baseUnit}`);
	} else if (row.dimension !== null) parts.push(row.dimension);
	if (row.key !== undefined)
		parts.push(`${vscode.l10n.t('key')} ${code(row.key)}`);
	return `- ${parts.join(' · ')}`;
}

/** Text as a code span. A code span cannot escape a backtick, so one becomes a quote. */
function code(text: string): string {
	return `\`${text.replace(/`/g, "'").replace(/\r?\n/g, ' ')}\``;
}
