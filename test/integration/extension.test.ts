import * as assert from 'node:assert';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as vscode from 'vscode';

const EXTENSION_ID = 'nolindnaidoo.units-le';

function file(name: string, content: string): vscode.Uri {
	const path = join(mkdtempSync(join(tmpdir(), 'units-le-it-')), name);
	writeFileSync(path, content);
	return vscode.Uri.file(path);
}

async function extractFrom(uri: vscode.Uri): Promise<string> {
	await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri));
	await vscode.commands.executeCommand('units-le.extract');
	const report = vscode.workspace.textDocuments
		.filter((doc) => doc.languageId === 'markdown' && doc.getText().includes('Units-LE report'))
		.find((doc) => doc.getText().includes(vscode.workspace.asRelativePath(uri, false)));
	assert.ok(report, 'no report document found');
	return report.getText();
}

describe('Units-LE integration', function () {
	this.timeout(30_000);

	it('activates', async () => {
		const extension = vscode.extensions.getExtension(EXTENSION_ID);
		assert.ok(extension, `extension ${EXTENSION_ID} not found`);
		await extension.activate();
		assert.strictEqual(extension.isActive, true);
	});

	it('registers every declared command', async () => {
		const extension = vscode.extensions.getExtension(EXTENSION_ID);
		await extension?.activate();
		const commands = await vscode.commands.getCommands(true);
		for (const id of [
			'units-le.extract',
			'units-le.scanWorkspace',
			'units-le.scanFolder',
			'units-le.openSettings',
			'units-le.help',
		]) {
			assert.ok(commands.includes(id), `missing command: ${id}`);
		}
	});

	it('resolves each quantity with its key in a real YAML file, and refuses the ambiguous unit by name', async () => {
		const text = await extractFrom(file('config.yaml', 'cache:\n  ttl: 1h30m\nmemory: 512MiB\ncpu: 500m\n'));
		assert.ok(text.includes('`1h30m` · → `5400000` milliseconds · key `cache.ttl`'), text);
		assert.ok(text.includes('`512MiB` · → `536870912` bytes · key `memory`'), text);
		assert.ok(text.includes('ambiguous_unit: `m` is minutes'), text);
	});

	it('reads a TOML file by its name, and quotes the parser when it does not parse', async () => {
		const text = await extractFrom(file('broken.toml', 'timeout = 30s\n'));
		assert.ok(text.includes('Failed to parse TOML: TOML parse error at line 1, column 11'), text);
		assert.ok(text.includes('No quantities found.'), text);
	});

	it('offers its MCP server to agent mode', async () => {
		// The registration itself is only observable in a real host, which
		// scripts/e2e-vsix.js covers against the installed VSIX.
		const extension = vscode.extensions.getExtension(EXTENSION_ID);
		await extension?.activate();
		assert.strictEqual(
			typeof vscode.lm.registerMcpServerDefinitionProvider,
			'function',
			'this VS Code build predates the MCP provider API',
		);
		const providers = extension?.packageJSON.contributes.mcpServerDefinitionProviders as {
			id: string;
			label: string;
		}[];
		assert.deepStrictEqual(
			providers.map((p) => p.id),
			['units-le'],
		);
	});

	it('scans a folder from disk: a section per file, excludes honoured, binaries left unread, refusals in Problems', async () => {
		const root = mkdtempSync(join(tmpdir(), 'units-le-scan-'));
		mkdirSync(join(root, 'api'));
		mkdirSync(join(root, 'node_modules'));
		const uuid = '512MiB';
		const bad = '500m';
		writeFileSync(join(root, 'api', 'a.json'), JSON.stringify({ id: uuid }));
		writeFileSync(join(root, 'api', 'b.txt'), `first ${uuid}\nthen ${bad}\n`);
		writeFileSync(join(root, 'node_modules', 'dep.json'), JSON.stringify({ id: uuid }));
		writeFileSync(join(root, 'logo.bin'), Buffer.from([0x89, 0x50, 0x00, 0x47]));
		writeFileSync(join(root, 'empty.md'), 'nothing here');

		writeFileSync(join(root, '.gitignore'), 'generated/\n');
		mkdirSync(join(root, 'generated'));
		writeFileSync(join(root, 'generated', 'g.json'), JSON.stringify({ id: uuid }));
		const settings = vscode.workspace.getConfiguration('units-le');
		await settings.update('workspace.scanProblemsEnabled', true, vscode.ConfigurationTarget.Global);

		// As the Explorer calls it: with the folder that was clicked.
		await vscode.commands.executeCommand('units-le.scanFolder', vscode.Uri.file(root));
		await settings.update('workspace.scanProblemsEnabled', undefined, vscode.ConfigurationTarget.Global);

		// This scan's report, whatever other reports the session has open.
		const report = vscode.workspace.textDocuments.find(
			(doc) => doc.languageId === 'markdown' && doc.getText().includes('units-le-scan-'),
		);
		assert.ok(report, 'no workspace report was opened');
		const text = report.getText();
		// The .gitignore itself is read, and what it names is not.
		assert.match(text, /4 file\(s\) read · 2 quantit\(ies\), 1 could not be resolved/);
		assert.ok(!text.includes('generated'), 'a file ignored by .gitignore was read');
		assert.match(text, /\| `api\/b\.txt` \| 1 \| 1 \|/);
		assert.deepStrictEqual(text.match(/^## .*$/gm), ['## `api/a.json` · json (1)', '## `api/b.txt` · unknown (1)']);
		assert.ok(!text.includes('node_modules'), 'an excluded folder was read');
		// `.bin` is on the list of extensions that are not text, so the file is
		// never opened, and the report says which filters were on.
		assert.match(text, /> Not read: dependency folders, build output, caches and lockfiles; images, fonts, archives and other binary files; 1 file\(s\) ignored by \.gitignore\./);

		const problems = vscode.languages
			.getDiagnostics()
			.filter(([, list]) => list.some((d) => d.source === 'units-le'));
		assert.strictEqual(problems.length, 1, 'expected problems for one file');
		const [uri, list] = problems[0] as [vscode.Uri, vscode.Diagnostic[]];
		assert.ok(uri.path.endsWith('/api/b.txt'));
		assert.strictEqual(list.length, 1);
		assert.strictEqual(list[0]?.severity, vscode.DiagnosticSeverity.Warning);
		assert.strictEqual(list[0]?.range.start.line, 1);
		assert.strictEqual(list[0]?.range.start.character, 5);
	});
});
