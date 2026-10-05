import { beforeEach, describe, expect, it } from 'vitest';
import {
	_clipboardText,
	_createDocument,
	_createExtensionContext,
	_openedDocuments,
	_registeredCommands,
	_resetMockState,
	_setActiveEditor,
	_setConfig,
	_setWorkspaceFiles,
	_shownMessages,
	executedBuiltins,
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
		deps: { notifier: createNotifier(), statusBar, telemetry },
		flashes,
	};
}

async function runCommand(id: string): Promise<void> {
	const handler = _registeredCommands().get(id);
	if (!handler) throw new Error(`command not registered: ${id}`);
	await handler();
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
