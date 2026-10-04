import type { Field } from './policy';
import { isWhitespace, lines, trim, trimEnd } from './text';

/**
 * The crate's `ini.rs`, over rust-ini 0.21.3's parser with the options the
 * crate passes: escapes off, quotes on, single-line values, no inline
 * comments. Bare keys are dropped before parsing, as the crate drops them.
 *
 * Transcribed to the character: a key reads up to the next `=` or `:` across
 * lines, a backslash before a newline continues the line even with escapes
 * off, and an error is reported in rust-ini's words at its line and column.
 */

class IniError extends Error {}

type Endpoint = string | null;

/** `{:?}` of a `&[Option<char>]`. */
function debugEndpoints(endpoints: readonly Endpoint[]): string {
	const debugChar = (character: string): string => {
		if (character === '\n') return "'\\n'";
		if (character === '\r') return "'\\r'";
		if (character === "'") return "'\\''";
		return `'${character}'`;
	};
	return `[${endpoints.map((endpoint) => (endpoint === null ? 'None' : `Some(${debugChar(endpoint)})`)).join(', ')}]`;
}

interface Section {
	readonly name: string | null;
	readonly properties: Array<[string, string]>;
}

class Parser {
	private readonly characters: string[];
	private at = -1;
	ch: string | null = null;
	private line = 0;
	private col = 0;

	constructor(text: string) {
		this.characters = Array.from(text);
		this.bump();
	}

	private bump(): void {
		this.at++;
		this.ch = this.characters[this.at] ?? null;
		if (this.ch === '\n') {
			this.line++;
			this.col = 0;
		} else if (this.ch !== null) {
			this.col++;
		}
	}

	private error(message: string): IniError {
		return new IniError(`${this.line + 1}:${this.col + 1} ${message}`);
	}

	private charOrEof(endpoints: readonly Endpoint[]): string {
		if (this.ch === null)
			throw this.error(
				`expecting "${debugEndpoints(endpoints)}" but found EOF.`,
			);
		return this.ch;
	}

	private whitespacePreservingLineLeading(): void {
		while (this.ch !== null) {
			const c = this.ch;
			if (c === ' ' || c === '\t') {
				this.bump();
			} else if (c === '\n' || c === '\r') {
				this.bump();
				if (this.ch === ' ' || this.ch === '\t') break;
			} else if (isWhitespace(c)) {
				this.bump();
			} else {
				break;
			}
		}
	}

	private whitespaceExceptLineBreak(): void {
		while (this.ch !== null) {
			const c = this.ch;
			if ((c === '\n' || c === '\r' || !isWhitespace(c)) && c !== '\t') break;
			this.bump();
		}
	}

	parse(): Section[] {
		// The general section exists from the start, so it iterates first.
		const sections: Section[] = [{ name: null, properties: [] }];
		const open = (name: string) => {
			sections.push({ name, properties: [] });
			return name;
		};
		let currentKey = '';
		let currentSection: string | null = null;
		while (this.ch !== null) {
			const c = this.ch;
			if (c === ';' || c === '#') {
				if (this.col > 1) throw this.error("doesn't support inline comment");
				this.comment();
			} else if (c === '[') {
				currentSection = open(trim(this.section()));
			} else if (c === '=' || c === ':') {
				if (currentKey === '') throw this.error('missing key');
				const value = this.value();
				// rust-ini appends to the last section of this name.
				let target = sections[0] as Section;
				for (const section of sections)
					if (section.name === currentSection) target = section;
				target.properties.push([currentKey, value]);
				currentKey = '';
			} else if (c === ' ' || c === '\t') {
				while (this.ch === ' ' || this.ch === '\t') this.bump();
				if (this.ch === '[') {
					currentSection = open(trim(this.section()));
				} else if (this.ch === '\n' || this.ch === '\r') {
					this.bump();
					continue;
				} else {
					try {
						currentKey = trim(this.until(['=', ':']));
					} catch (error) {
						// rust-ini takes a failed key here for trailing whitespace at EOF.
						if (!(error instanceof IniError)) throw error;
					}
				}
			} else if (c === '\n' || c === '\r') {
				this.bump();
			} else {
				currentKey = trim(this.until(['=', ':']));
			}
			this.whitespacePreservingLineLeading();
		}
		return sections;
	}

	private comment(): void {
		while (this.ch !== null) {
			const c = this.ch;
			this.bump();
			if (c === '\n') break;
		}
	}

	private until(endpoints: readonly Endpoint[]): string {
		let result = '';
		while (!endpoints.includes(this.ch)) {
			const c = this.charOrEof(endpoints);
			if (c === '\\') {
				this.bump();
				const next = this.ch;
				if (next === null) {
					result += '\\';
					continue;
				}
				// A backslash-newline continues the line; with escapes off, any other pair is kept as written.
				if (next !== '\n') result += `\\${next}`;
			} else {
				result += c;
			}
			this.bump();
		}
		return result;
	}

	private section(): string {
		this.bump();
		const name = this.until([']']);
		if (this.ch === ']') this.bump();
		return name;
	}

	private value(): string {
		this.bump();
		this.whitespaceExceptLineBreak();
		let value = '';
		let firstPart = true;
		for (;;) {
			const c = this.ch;
			if (c === null) break;
			if (c === '"' || c === "'") {
				this.bump();
				value += this.until([c]);
				this.bump();
				firstPart = false;
				continue;
			}
			const standard = this.until(['\n', '\r', null]);
			value += firstPart ? trim(standard) : trimEnd(standard);
			break;
		}
		return value;
	}
}

/** Drop the unindented separator-less lines rust-ini rejects. An indented one continues the value above. */
function withoutBareKeys(text: string): string {
	return lines(text)
		.filter((line) => {
			const trimmed = trim(line);
			const first = Array.from(line)[0];
			return (
				trimmed === '' ||
				(first !== undefined && isWhitespace(first)) ||
				trimmed.startsWith(';') ||
				trimmed.startsWith('#') ||
				trimmed.startsWith('[') ||
				trimmed.includes('=') ||
				trimmed.includes(':')
			);
		})
		.join('\n');
}

function parsed(text: string): Section[] | string {
	try {
		return new Parser(withoutBareKeys(text)).parse();
	} catch (error) {
		if (error instanceof IniError) return error.message;
		throw error;
	}
}

export function extractIni(text: string): Field[] {
	const sections = parsed(text);
	if (typeof sections === 'string') return [];
	return sections.flatMap((section) =>
		section.properties.map(([key, text]) => ({
			key: section.name === null ? key : `${section.name}.${key}`,
			text,
		})),
	);
}

export function iniParseError(text: string): string | undefined {
	const sections = parsed(text);
	return typeof sections === 'string'
		? `Failed to parse INI: ${sections}`
		: undefined;
}
