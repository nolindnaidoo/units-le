import * as vscode from 'vscode';
import { readConfig } from '../config/config';
import { extract, parseError, resolveFormat } from '../extract';
import { formatReport } from '../report/format';
import type { CommandDependencies } from './index';
import { showReport } from './output';

/**
 * Extract the quantities in the active document, as the editor holds it.
 *
 * The format comes from the language mode first and the file name second. A
 * structured format that does not parse yields nothing, and the report says
 * why in the parser's own words.
 */
export async function extractFromActiveDocument(
	deps: CommandDependencies,
): Promise<void> {
	deps.telemetry.event('command', { name: 'extract' });
	const editor = vscode.window.activeTextEditor;
	if (!editor) {
		deps.notifier.error(vscode.l10n.t('No active editor'));
		return;
	}
	const document = editor.document;
	const text = document.getText();
	if (text.length === 0) {
		deps.notifier.info(vscode.l10n.t('File is empty'));
		return;
	}
	const config = readConfig();
	if (config.safetyEnabled && !document.isUntitled) {
		try {
			const { size } = await vscode.workspace.fs.stat(document.uri);
			if (size > config.safetyFileSizeWarnBytes) {
				deps.notifier.warn(
					vscode.l10n.t(
						'Large file detected ({0} bytes). Extraction may take longer.',
						size,
					),
				);
			}
		} catch {
			// A document with no file behind it has no size to warn about.
		}
	}

	// The base name, not the path: the rules that read a name never see a directory.
	const base = document.fileName.slice(
		Math.max(
			document.fileName.lastIndexOf('/'),
			document.fileName.lastIndexOf('\\'),
		) + 1,
	);
	const format = resolveFormat(document.languageId, base);
	// A refusal that names no dimension survives every filter: it could have been the one asked for.
	const rows = extract(text, format).filter(
		(row) =>
			config.dimensions.length === 0 ||
			row.dimension === null ||
			config.dimensions.includes(row.dimension),
	);
	const unparsed = parseError(text, format);
	const refused = rows.filter((row) => row.base === null).length;
	const file = document.isUntitled
		? document.fileName
		: vscode.workspace.asRelativePath(document.uri, false);
	await showReport(
		formatReport({
			file,
			format,
			rows,
			unparsed,
			positions: config.showPositions,
		}),
		config,
		deps,
		formatReport({
			file,
			format,
			rows,
			unparsed,
			positions: config.clipboardIncludesPositions,
		}),
	);

	deps.telemetry.event('extracted', {
		quantities: String(rows.length - refused),
		refused: String(refused),
	});
	deps.statusBar.flash(
		vscode.l10n.t('{0} quantit(ies)', rows.length - refused),
	);
	if (unparsed !== undefined)
		deps.notifier.warn(
			vscode.l10n.t(
				'This {0} does not parse, so nothing in it was read',
				format,
			),
		);
	if (refused > 0)
		deps.notifier.warn(
			vscode.l10n.t(
				'{0} quantit(ies) could not be resolved; the report gives each reason',
				refused,
			),
		);
}
