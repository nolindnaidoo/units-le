/**
 * The command line's help text and the flags it names.
 *
 * Word for word the Rust CLI's, because both install as `units-le` and a
 * person reading `--help` cannot tell which one they have.
 * `scripts/check-cli-parity.ts` compares the two outputs, and `cli.test.ts`
 * holds FLAGS equal to the flags this text names.
 */

export const USAGE = `usage: units-le [options] <file|dir>...
       units-le [options] --stdin [--format <format>]
       units-le mcp
       units-le --version | --help

Finds every quantity in a tree — a number welded to a unit — and reports
it twice: the text the document actually holds, and that value in one
base unit so two of them can be compared. JSON, YAML, CSV, TOML, INI and
dotenv are parsed; anything else is scanned as text, so a Kubernetes
manifest or a Markdown table of limits yields its quantities rather than
nothing.

Four dimensions: duration (milliseconds), bytes (bytes), percent (a
ratio), frequency (hertz).

What it will not do is guess. A bare \`m\`, a fractional \`1.5KB\`, a
locale-shaped \`1,5s\` and an expression like \`1h + 30m\` are each reported
with a named reason and no base value. A refusal is a finding, never a
dropped row.

A bare number with no unit is not a finding at all — that is numbers-le's
question.

One JSON report per line on stdout when it is piped or redirected, human
summary on stderr. At a terminal stdout stays silent.

Options:
  --dimension <name>   report only duration, bytes, percent or frequency.
                       A refusal that names no dimension is always kept:
                       it could have been the one you asked for
  --format <format>    force a format instead of inferring it from the
                       file name; an unknown name falls back to the text
                       scan rather than failing
  --strict             exit 2 if any quantity was refused, or any text
                       file could not be read
  --stdin              read one document from stdin
  --hidden             walk hidden files and directories too
  --no-ignore          walk files that .gitignore excludes

A binary file — a NUL byte in its first 8 KiB, ripgrep's own test — is
never a text candidate: it produces no report line, is counted on stderr,
and never fails the run.

Exit codes follow grep: 0 quantities found · 1 none found · 2 malformed
question. Finding none is an answer, not an error.`;

export const FLAGS: readonly string[] = Object.freeze([
	'--dimension',
	'--format',
	'--strict',
	'--stdin',
	'--hidden',
	'--no-ignore',
]);
