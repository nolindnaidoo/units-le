import * as vscode from 'vscode';
import type { Telemetry } from '../telemetry/telemetry';

/**
 * Register the help command
 */
export function registerHelpCommand(
	context: vscode.ExtensionContext,
	telemetry: Telemetry,
): void {
	const disposable = vscode.commands.registerCommand(
		'units-le.help',
		async () => {
			telemetry.event('command', { name: 'help' });
			await showHelp();
		},
	);
	context.subscriptions.push(disposable);
}

async function showHelp(): Promise<void> {
	const doc = await vscode.workspace.openTextDocument({
		content: generateHelpContent(),
		language: 'markdown',
	});
	await vscode.window.showTextDocument(doc, {
		preview: false,
		viewColumn: vscode.ViewColumn.Beside,
	});
}

/** Every claim here is the crate's behaviour, and the corpus pins it. */
export function generateHelpContent(): string {
	return [
		'# Units-LE Help',
		'',
		'Finds every quantity in a document — a number welded to a unit — and reports it twice: as the document wrote it, and in one base unit so two of them can be compared. A quantity that cannot be read unambiguously is reported with the reason, never guessed at. A bare number with no unit is not a finding.',
		'',
		'## Commands',
		'',
		'- **Extract Quantities** (`Ctrl+Alt+Q`, Mac `Cmd+Alt+Q`): the active document, as the editor holds it.',
		'',
		'## Dimensions',
		'',
		'| Dimension | Base unit | Units |',
		'|---|---|---|',
		'| `duration` | milliseconds | `ns` `us` `µs` `ms` `s` `sec` `min` `h` `hr` `d` `day` `w`, compounds like `1h30m`, ISO-8601 like `PT1H30M` |',
		'| `bytes` | bytes | `B`, SI `kB` `MB` `GB` `TB` `PB`, IEC `KiB` `MiB` `GiB` `TiB` `PiB`, Kubernetes `Ki` `Mi` `Gi` `Ti` `Pi` |',
		'| `percent` | ratio | `%` — `15%` is `0.15` |',
		'| `frequency` | hertz | `Hz` `kHz` `MHz` `GHz` `THz` |',
		'',
		'Case is part of the symbol: `MB` is a megabyte and `Mb` is a megabit.',
		'',
		'## Refusals',
		'',
		'| Reason | When |',
		'|---|---|',
		'| `ambiguous_unit` | A symbol with more than one reading: `500m`, `10M`, `5k`, `1y`, `100Mb`, `P1M` |',
		'| `fractional_bytes` | A fraction of a byte: `1.5KB` |',
		"| `locale_separator` | A separator whose meaning is the writer's locale: `1,5s`, `1.000s` |",
		'| `compound_arithmetic` | An expression rather than a quantity: `1h + 30m`, `30s*2` |',
		'| `out_of_range` | A base value that does not fit in 128 bits |',
		'| `si_iec_hazard` | Reported with its value: `1MB` is 10^6 bytes by the standard, and may have meant 2^20 |',
		'',
		'## Formats',
		'',
		'JSON, JSONC, YAML, TOML, INI, dotenv, CSV and TSV are parsed, and every quantity carries its key path. Everything else is scanned as text — a Kubernetes manifest, a Terraform file, a log — so a format is never required. A structured document that does not parse yields nothing, and the report quotes the parser.',
		'',
		'## Agents',
		'',
		"The bundled MCP server offers `extract_units` to agent mode. It answers exactly as the `units-le` command-line tool's server does.",
		'',
		'## Troubleshooting',
		'',
		'- **Nothing found in a config file**: check the language mode. A file read as plain text is scanned, which finds quantities but no key paths.',
		'- **"Failed to parse"**: the document is not valid in its format, so nothing in it was read. The report quotes the parser and the line.',
		'',
	].join('\n');
}
