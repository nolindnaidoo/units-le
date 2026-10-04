import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import {
	_clipboardText,
	_createDocument,
	_createExtensionContext,
	_diagnostics,
	_openedDocuments,
	_registeredCommands,
	_resetMockState,
	_respondToOpenDialog,
	_setActiveEditor,
	_setConfig,
	_setWorkspaceFiles,
	_shownMessages,
	executedBuiltins,
	Uri,
	workspace,
} from '../__mocks__/vscode';
import { registerOpenSettingsCommand } from '../config/settings';
import type { Telemetry } from '../telemetry/telemetry';
import { createNotifier } from '../ui/notifier';
import type { StatusBar } from '../ui/statusBar';
import { generateHelpContent, registerHelpCommand } from './help';
import { registerCommands } from './index';

function makeDeps() {
	const flashes: string[] = [];
	const telemetry: Telemetry = { event: () => {}, dispose: () => {} };
	const statusBar: StatusBar = { flash: (text) => flashes.push(text) };
	return {
		deps: {
			notifier: createNotifier(),
			statusBar,
			telemetry,
			ratingPrompt: { recordSuccess: async () => {} },
		},
		flashes,
	};
}

async function runCommand(id: string, ...args: unknown[]): Promise<void> {
	const handler = _registeredCommands().get(id);
	if (!handler) throw new Error(`command not registered: ${id}`);
	await handler(...args);
}

function report(): string {
	const last = _openedDocuments().at(-1);
	if (!last) throw new Error('no report was opened');
	return last.getText();
}

const DOCUMENT = 'cache:\n  ttl: 1h30m\nmemory: 512MiB\ndisk: 2GB\ncpu: 500m\n';

let flashes: string[] = [];
beforeEach(() => {
	_resetMockState();
	const made = makeDeps();
	flashes = made.flashes;
	registerCommands(_createExtensionContext() as never, made.deps);
});

describe('units-le.extract', () => {
	it('errors when no editor is active', async () => {
		await runCommand('units-le.extract');
		expect(_shownMessages()[0]).toMatchObject({
			kind: 'error',
			message: 'No active editor',
		});
	});

	it('says an empty file is empty', async () => {
		_setConfig('units-le.notificationsLevel', 'all');
		_setActiveEditor(_createDocument({ content: '' }));
		await runCommand('units-le.extract');
		expect(_shownMessages()[0]).toMatchObject({
			kind: 'info',
			message: 'File is empty',
		});
	});

	it('resolves each quantity with its base value and key, flags the SI hazard, and refuses the ambiguous unit by name', async () => {
		_setActiveEditor(
			_createDocument({
				content: DOCUMENT,
				languageId: 'yaml',
				fileName: '/w/config.yaml',
			}),
		);
		await runCommand('units-le.extract');
		const text = report();
		expect(text).toContain(
			'`/w/config.yaml` · yaml · 3 quantit(ies), 1 could not be resolved',
		);
		expect(text).toContain(
			'- **2:8** · `1h30m` · → `5400000` milliseconds · key `cache.ttl`',
		);
		expect(text).toContain(
			'- **3:9** · `512MiB` · → `536870912` bytes · key `memory`',
		);
		expect(text).toContain(
			'- **4:7** · `2GB` · → `2000000000` bytes · key `disk`',
		);
		expect(text).toContain('  si_iec_hazard: reported as SI');
		expect(text).toContain('## Could not be resolved (1)');
		expect(text).toContain(
			'  ambiguous_unit: `m` is minutes in one config format',
		);
		expect(flashes).toContain('3 quantit(ies)');
	});

	it('reads the format from the file name when the language mode does not say', async () => {
		_setActiveEditor(
			_createDocument({ content: 'TIMEOUT=30s\n', fileName: '/w/.env' }),
		);
		await runCommand('units-le.extract');
		expect(report()).toContain('· env ·');
		expect(report()).toContain('key `TIMEOUT`');
	});

	it('scans a format it does not parse as text, with no key paths', async () => {
		_setActiveEditor(
			_createDocument({
				content: 'resources: { limits: memory 512Mi } # 1h + 30m\n',
				languageId: 'terraform',
				fileName: '/w/main.tf',
			}),
		);
		await runCommand('units-le.extract');
		const text = report();
		expect(text).toContain('· unknown ·');
		expect(text).toContain('`512Mi` · → `536870912` bytes');
		expect(text).toContain('compound_arithmetic');
		expect(text).not.toContain('key `');
	});

	it('narrows to the dimensions the settings name, and keeps every refusal that names none', async () => {
		_setConfig('units-le.dimensions', ['bytes']);
		_setActiveEditor(
			_createDocument({ content: DOCUMENT, languageId: 'yaml' }),
		);
		await runCommand('units-le.extract');
		expect(report()).not.toContain('## duration');
		expect(report()).toContain('## bytes (2)');
		expect(report()).toContain('## Could not be resolved (1)');
	});

	it('reads nothing from a document that does not parse, and quotes the parser', async () => {
		_setConfig('units-le.notificationsLevel', 'all');
		_setActiveEditor(
			_createDocument({ content: 'timeout = 30s\n', languageId: 'toml' }),
		);
		await runCommand('units-le.extract');
		const text = report();
		expect(text).toContain(
			'Failed to parse TOML: TOML parse error at line 1, column 11',
		);
		expect(text).toContain(
			'string values must be quoted, expected literal string',
		);
		expect(text).toContain('No quantities found.');
		expect(
			_shownMessages().some(
				(m) =>
					m.message === 'This toml does not parse, so nothing in it was read',
			),
		).toBe(true);
	});

	it('warns about a large file before extracting', async () => {
		_setConfig('units-le.notificationsLevel', 'all');
		_setConfig('units-le.safety.fileSizeWarnBytes', 1000);
		_setWorkspaceFiles({ '/w/big.txt': 'x'.repeat(2000) });
		_setActiveEditor(
			_createDocument({ content: 'x'.repeat(2000), fileName: '/w/big.txt' }),
		);
		await runCommand('units-le.extract');
		expect(
			_shownMessages().some((m) =>
				m.message.startsWith('Large file detected (2000 bytes)'),
			),
		).toBe(true);
	});

	it('copies the report when asked to', async () => {
		_setConfig('units-le.copyToClipboardEnabled', true);
		_setActiveEditor(
			_createDocument({ content: DOCUMENT, languageId: 'yaml' }),
		);
		await runCommand('units-le.extract');
		expect(_clipboardText()).toBe(report());
	});

	it('shows no positions when the setting is off', async () => {
		_setConfig('units-le.showPositions', false);
		_setActiveEditor(
			_createDocument({ content: DOCUMENT, languageId: 'yaml' }),
		);
		await runCommand('units-le.extract');
		expect(report()).not.toMatch(/\*\*(\d+:\d+|—)\*\*/);
		expect(report()).toMatch(/^- `/m);
	});

	it('decides positions for the clipboard separately from the report', async () => {
		_setConfig('units-le.copyToClipboardEnabled', true);
		_setConfig('units-le.clipboardIncludesPositions', false);
		_setActiveEditor(
			_createDocument({ content: DOCUMENT, languageId: 'yaml' }),
		);
		await runCommand('units-le.extract');
		expect(report()).toMatch(/\*\*\d+:\d+\*\*/);
		expect(_clipboardText()).not.toMatch(/\*\*(\d+:\d+|—)\*\*/);
		expect(_clipboardText()).toMatch(/^- `/m);
	});
});

describe('settings and help', () => {
	it('opens the settings filtered to this extension', async () => {
		const { deps } = makeDeps();
		registerOpenSettingsCommand(
			_createExtensionContext() as never,
			deps.telemetry,
		);
		await runCommand('units-le.openSettings');
		expect(executedBuiltins.at(-1)).toMatchObject({ args: ['units-le.'] });
	});

	it('opens the help, which names every dimension and every refusal', async () => {
		const { deps } = makeDeps();
		registerHelpCommand(_createExtensionContext() as never, deps.telemetry);
		await runCommand('units-le.help');
		for (const word of [
			'duration',
			'bytes',
			'percent',
			'frequency',
			'ambiguous_unit',
			'fractional_bytes',
			'locale_separator',
			'compound_arithmetic',
			'out_of_range',
			'si_iec_hazard',
		]) {
			expect(generateHelpContent()).toContain(word);
		}
	});
});

describe('units-le.scanWorkspace and units-le.scanFolder', () => {
	const UUID = '512MiB';
	const BAD = '500m';
	const TREE = {
		'/w/api/a.json': JSON.stringify({ id: UUID }),
		'/w/api/b.txt': `first ${UUID}\nthen ${BAD}`,
		'/w/empty.md': 'nothing here',
		'/w/node_modules/dep.json': JSON.stringify({ id: UUID }),
		// No extension to go by, so it is read and found not to be text.
		'/w/blob': new Uint8Array([0x89, 0x50, 0x00, 0x47]),
	};

	function open(): void {
		_setWorkspaceFiles(TREE);
		workspace.workspaceFolders = [{ uri: Uri.file('/w'), name: 'w', index: 0 }];
	}

	it('warns when no workspace is open', async () => {
		_setConfig('units-le.notificationsLevel', 'all');
		await runCommand('units-le.scanWorkspace');
		expect(_shownMessages()[0]).toMatchObject({ kind: 'warning' });
		expect(_openedDocuments()).toHaveLength(0);
	});

	it('reports every file that holds a quantity, one section each, in path order', async () => {
		open();
		await runCommand('units-le.scanWorkspace');

		const text = report();
		expect(text).toContain('# Units-LE workspace report');
		expect(text).toContain(
			'3 file(s) read · 2 quantit(ies), 1 could not be resolved',
		);
		// The table names every file that holds something, with both counts.
		expect(text).toContain('| File | Quantities | Could not be resolved |');
		expect(text).toContain('| `/w/api/a.json` | 1 | 0 |');
		expect(text).toContain('| `/w/api/b.txt` | 1 | 1 |');
		// What could not be resolved is counted there and not listed below.
		expect(text.match(/^## .*$/gm)).toEqual([
			'## `/w/api/a.json` · json (1)',
			'## `/w/api/b.txt` · unknown (1)',
		]);
		expect(text).not.toContain(BAD);
		expect(text).toContain('`units-le.workspace.scanIncludeRefusals`');
		// A named quantity says its kind here, since nothing groups by it.
		expect(text).toContain(`- **1:8** · \`${UUID}\``);
		// Left out by the built-in excludes, and the report says they were on.
		expect(text).not.toContain('node_modules');
		expect(text).toContain(
			'> Not read: dependency folders, build output, caches and lockfiles; images, fonts, archives and other binary files; 0 file(s) ignored by .gitignore. The `units-le.workspace.*` settings change this.',
		);
		expect(text).toContain(
			'> 1 file(s) that are not UTF-8 text were not read.',
		);
		expect(flashes).toEqual(['2 quantit(ies) in 2 file(s)']);
	});

	it('lists each run that could not be resolved when asked to', async () => {
		open();
		_setConfig('units-le.workspace.scanIncludeRefusals', true);
		await runCommand('units-le.scanWorkspace');

		expect(report()).toContain('## `/w/api/b.txt` · unknown (2)');
		expect(report()).toContain(BAD);
		expect(report()).not.toContain('scanIncludeRefusals');
	});

	it('leaves the Problems panel alone unless asked', async () => {
		open();
		await runCommand('units-le.scanWorkspace');
		expect(_diagnostics().size).toBe(0);
	});

	it('puts the runs that could not be resolved in the Problems panel when asked, and only those', async () => {
		open();
		_setConfig('units-le.workspace.scanProblemsEnabled', true);
		await runCommand('units-le.scanWorkspace');

		const problems = _diagnostics();
		expect([...problems.keys()]).toEqual(['/w/api/b.txt']);
		const [problem] = problems.get('/w/api/b.txt') ?? [];
		expect(problem?.severity).toBe(1);
		expect(problem?.source).toBe('units-le');
		expect(problem?.range.start).toMatchObject({ line: 1, character: 5 });
		expect(problem?.range.end.character).toBe(5 + BAD.length);
	});

	it('scans only the folder it is handed', async () => {
		open();
		_setWorkspaceFiles({ ...TREE, '/w/web/c.txt': UUID });
		await runCommand('units-le.scanFolder', Uri.file('/w/web'));

		expect(report()).toContain('`/w/web` · 1 file(s) read · 1 quantit(ies)');
		// Paths are relative to the folder that was picked.
		expect(report().match(/^## .*$/gm)).toEqual(['## `c.txt` · unknown (1)']);
	});

	it('asks for a folder from the palette, and does nothing when none is picked', async () => {
		open();
		_respondToOpenDialog(() => undefined);
		await runCommand('units-le.scanFolder');
		expect(_openedDocuments()).toHaveLength(0);

		_respondToOpenDialog(() => [Uri.file('/w/api')]);
		await runCommand('units-le.scanFolder');
		expect(report()).toContain('`/w/api` · 2 file(s) read');
	});

	it('stops at the results limit and says the rest was not read', async () => {
		open();
		_setConfig('units-le.workspace.scanMaxResults', 1);
		await runCommand('units-le.scanWorkspace');

		const text = report();
		expect(text.match(/^## .*$/gm)).toEqual(['## `/w/api/a.json` · json (1)']);
		expect(text).toContain(
			'> The results limit was reached. The rest of the files were not read.',
		);
	});

	it('says when more files matched than the file limit', async () => {
		open();
		_setConfig('units-le.workspace.scanMaxFiles', 1);
		await runCommand('units-le.scanWorkspace');
		expect(report()).toContain(
			'> More files matched than the limit of 1. The rest were not read.',
		);
	});

	it('honours the positions settings as Extract does', async () => {
		open();
		_setConfig('units-le.showPositions', false);
		await runCommand('units-le.scanWorkspace');
		expect(report()).not.toMatch(/\*\*\d+:\d+\*\*/);
		expect(report()).toContain(`- \`${UUID}\``);
	});
	it('prints the rows the README shows as its sample', async () => {
		_setWorkspaceFiles({ '/w/deploy/values.yaml': DOCUMENT });
		workspace.workspaceFolders = [{ uri: Uri.file('/w'), name: 'w', index: 0 }];
		await runCommand('units-le.scanFolder', Uri.file('/w'));

		const rows = report()
			.split('\n')
			.filter((line) => line.startsWith('- '));
		expect(rows).toHaveLength(3);
		const readme = readFileSync(
			join(__dirname, '..', '..', 'README.md'),
			'utf8',
		);
		for (const row of rows) expect(readme).toContain(row);
		// The same first row with its position taken off, as the README shows it.
		expect(readme).toContain(
			(rows[0] as string).replace(/\*\*[^*]+\*\* · /, ''),
		);
		expect(report()).toContain('| `deploy/values.yaml` | 3 | 1 |');
		expect(readme).toContain('| `deploy/values.yaml` | 3 | 1 |');
	});
});
