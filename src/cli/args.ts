/**
 * The command line, parsed as the Rust CLI parses it: strictly, in order, and
 * refusing rather than defaulting.
 */
import {
	DIMENSIONS,
	type Dimension,
	type Format,
	resolveFormat,
} from '../extract';
import { FLAGS } from './usage';

export interface WalkOptions {
	readonly hidden: boolean;
	readonly respectIgnore: boolean;
}

export interface ScanOptions {
	readonly dimension: Dimension | undefined;
	/** The forced format, or null to infer one per file name. */
	readonly format: Format | null;
}

export interface Cli {
	readonly strict: boolean;
	readonly inputs: readonly string[];
	readonly stdin: boolean;
	readonly scan: ScanOptions;
	readonly walk: WalkOptions;
}

export function parse(args: readonly string[]): Cli {
	const inputs: string[] = [];
	let stdin = false;
	let strict = false;
	let format: Format | null = null;
	let dimension: Dimension | undefined;
	let walk: WalkOptions = { hidden: false, respectIgnore: true };

	for (let index = 0; index < args.length; index++) {
		const arg = args[index] as string;
		if (arg.startsWith('-') && !FLAGS.includes(arg)) {
			throw new Error(`${arg} is not an option. Try --help.`);
		}
		if (arg === '--format') {
			index += 1;
			const value = args[index];
			if (value === undefined) throw new Error('--format needs a format');
			format = resolveFormat(value, undefined);
			continue;
		}
		if (arg === '--dimension') {
			index += 1;
			dimension = dimensionOf(args[index]);
			continue;
		}
		if (arg === '--stdin') stdin = true;
		if (arg === '--strict') strict = true;
		if (arg === '--hidden') walk = { ...walk, hidden: true };
		if (arg === '--no-ignore') walk = { ...walk, respectIgnore: false };
		if (!arg.startsWith('-')) inputs.push(arg);
	}

	if (stdin && inputs.length > 0) {
		throw new Error('reading from stdin takes no file arguments');
	}
	if (!stdin && inputs.length === 0) {
		throw new Error('name a file or a directory to read. Try --help.');
	}
	return Object.freeze({
		strict,
		inputs,
		stdin,
		scan: { dimension, format },
		walk,
	});
}

/** The crate's `Dimension::named` over a lowercased value. */
function dimensionOf(value: string | undefined): Dimension {
	if (value === undefined) throw new Error('--dimension needs a name');
	const found = DIMENSIONS.find((name) => name === value.toLowerCase());
	if (found === undefined) {
		throw new Error(
			`${value} is not a dimension. Try duration, bytes, percent or frequency.`,
		);
	}
	return found;
}
