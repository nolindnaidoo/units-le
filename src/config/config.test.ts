import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { _resetMockState, _setConfig } from '../__mocks__/vscode';
import { DIMENSIONS } from '../extract';
import {
	DEFAULT_EXCLUDED_FILES,
	DEFAULT_EXCLUDED_FOLDERS,
	DEFAULT_EXCLUDED_PATHS,
} from '../workspace/defaults';
import {
	CONFIG_DEFAULTS,
	isValidNotificationLevel,
	readConfig,
} from './config';

describe('config defaults parity with package.json', () => {
	const manifest = JSON.parse(
		readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf8'),
	) as {
		contributes: {
			configuration: {
				properties: Record<string, { default: unknown; enum?: string[] }>;
			};
		};
	};
	const props = manifest.contributes.configuration.properties;
	const KEY_MAP: Record<string, keyof typeof CONFIG_DEFAULTS> = {
		'units-le.clipboardIncludesPositions': 'clipboardIncludesPositions',
		'units-le.copyToClipboardEnabled': 'copyToClipboardEnabled',
		'units-le.dimensions': 'dimensions',
		'units-le.notificationsLevel': 'notificationsLevel',
		'units-le.openResultsSideBySide': 'openResultsSideBySide',
		'units-le.safety.enabled': 'safetyEnabled',
		'units-le.safety.fileSizeWarnBytes': 'safetyFileSizeWarnBytes',
		'units-le.showPositions': 'showPositions',
		'units-le.statusBar.enabled': 'statusBarEnabled',
		'units-le.telemetryEnabled': 'telemetryEnabled',
		'units-le.workspace.scanAlwaysInclude': 'workspaceScanAlwaysInclude',
		'units-le.workspace.scanExcludes': 'workspaceScanExcludes',
		'units-le.workspace.scanIncludeRefusals': 'workspaceScanIncludeRefusals',
		'units-le.workspace.scanMaxFiles': 'workspaceScanMaxFiles',
		'units-le.workspace.scanMaxResults': 'workspaceScanMaxResults',
		'units-le.workspace.scanPatterns': 'workspaceScanPatterns',
		'units-le.workspace.scanProblemsEnabled': 'workspaceScanProblemsEnabled',
		'units-le.workspace.scanRespectGitignore': 'workspaceScanRespectGitignore',
		'units-le.workspace.scanSkipBinaryFiles': 'workspaceScanSkipBinaryFiles',
		'units-le.workspace.scanUseDefaultExcludes':
			'workspaceScanUseDefaultExcludes',
	};

	it('covers every declared setting', () => {
		expect(Object.keys(props).sort()).toEqual(Object.keys(KEY_MAP).sort());
	});

	for (const [manifestKey, defaultsKey] of Object.entries(KEY_MAP)) {
		it(`${manifestKey} default matches`, () => {
			expect(CONFIG_DEFAULTS[defaultsKey]).toEqual(props[manifestKey]?.default);
		});
	}

	it('offers exactly the dimensions the engine names', () => {
		const items = (key: string) =>
			(props[key] as unknown as { items: { enum: string[] } }).items.enum;
		expect(items('units-le.dimensions')).toEqual([...DIMENSIONS]);
	});
});

describe('the README states the scan limits the code uses', () => {
	const readme = readFileSync(join(__dirname, '..', '..', 'README.md'), 'utf8');
	// Grouped by hand, not by Intl. The first Intl call in a process loads its
	// locale data, and on a Windows runner that once took sixteen seconds
	// inside a test that only compares two strings.
	const grouped = (n: number) =>
		String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

	it('in the settings table', () => {
		expect(readme).toContain(
			`| \`units-le.workspace.scanMaxFiles\` | \`${CONFIG_DEFAULTS.workspaceScanMaxFiles}\` |`,
		);
		expect(readme).toContain(
			`| \`units-le.workspace.scanMaxResults\` | \`${CONFIG_DEFAULTS.workspaceScanMaxResults}\` |`,
		);
	});

	it('in the prose', () => {
		expect(readme).toContain(
			`It stops at ${grouped(CONFIG_DEFAULTS.workspaceScanMaxFiles)} files or ${grouped(CONFIG_DEFAULTS.workspaceScanMaxResults)} listed quantities.`,
		);
	});
});

describe('the README lists the folders a scan skips', () => {
	it('exactly as the code has them', () => {
		const readme = readFileSync(
			join(__dirname, '..', '..', 'README.md'),
			'utf8',
		);
		const listed =
			/<!-- built-in-folders -->\n(.*)\n<!-- \/built-in-folders -->/
				.exec(readme)?.[1]
				?.split(', ')
				.map((entry) => entry.replace(/`/g, ''));
		expect(listed).toEqual([...DEFAULT_EXCLUDED_FOLDERS, '*.egg-info']);
	});

	it('and the files, exactly as the code has them', () => {
		const readme = readFileSync(
			join(__dirname, '..', '..', 'README.md'),
			'utf8',
		);
		const listed = /<!-- built-in-files -->\n(.*)\n<!-- \/built-in-files -->/
			.exec(readme)?.[1]
			?.split(', ')
			.map((entry) => entry.replace(/`/g, ''));
		expect(listed).toEqual([
			...DEFAULT_EXCLUDED_FILES,
			...DEFAULT_EXCLUDED_PATHS,
		]);
	});
});

describe('readConfig', () => {
	afterEach(() => _resetMockState());

	it('drops a name the engine does not know, so a typo never hides a quantity', () => {
		_setConfig('units-le.dimensions', ['length']);
		expect(readConfig().dimensions).toEqual([]);
		_setConfig('units-le.dimensions', ['bytes', 'nonsense']);
		expect(readConfig().dimensions).toEqual(['bytes']);
		_setConfig('units-le.dimensions', 'bytes');
		expect(readConfig().dimensions).toEqual([]);
	});

	it('falls back to the default for a value of the wrong type, and floors the size', () => {
		_setConfig('units-le.openResultsSideBySide', 'yes');
		_setConfig('units-le.safety.fileSizeWarnBytes', 5);
		expect(readConfig().openResultsSideBySide).toBe(true);
		expect(readConfig().safetyFileSizeWarnBytes).toBe(1000);
	});
});

describe('isValidNotificationLevel', () => {
	it('accepts the three declared levels and nothing else', () => {
		for (const level of ['all', 'important', 'silent'])
			expect(isValidNotificationLevel(level)).toBe(true);
		expect(isValidNotificationLevel('verbose')).toBe(false);
	});
});
