import * as assert from 'node:assert';
import { mkdtempSync, writeFileSync } from 'node:fs';
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
		for (const id of ['units-le.extract', 'units-le.openSettings', 'units-le.help']) {
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
});
