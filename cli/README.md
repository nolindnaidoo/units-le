# units-le

Find every quantity in a codebase, a number welded to a unit, and report it
twice: the text the document actually holds, and that value in one base
unit so two of them can be compared.

```bash
npx units-le .
npx units-le --dimension duration deploy/ > timeouts.jsonl
kubectl get deploy -o yaml | npx units-le --stdin --format yaml
```

The command it installs is `units-le`, the same command line as the Rust
crate [`units-le`](https://crates.io/crates/units-le), and it behaves
identically: same flags, same walk, same answers, same output, same exit
codes. Install whichever toolchain you already have.

## What it reports

Four dimensions, each in one base unit: duration in milliseconds, bytes in
bytes, percent as a ratio, frequency in hertz. Base values are exact
decimals. JSON, YAML, CSV, TOML, INI and dotenv are parsed and give each
quantity its key path. Anything else is scanned as text, so a Kubernetes
manifest or a Markdown table of limits yields its quantities rather than
nothing.

**It refuses rather than guesses.** A bare `m`, a fractional `1.5KB`, a
locale-shaped `1,5s` and an expression like `1h + 30m` are each reported
with a named reason and no base value. A refusal is a finding, never a
dropped row, and `--dimension` keeps one that names no dimension, because
it could have been the one you asked for.

A bare number with no unit is not a finding at all: that is
[`numbers-le`](https://www.npmjs.com/package/numbers-le)'s question.

Directories are walked the way ripgrep walks them: `.gitignore`, `.ignore`
and hidden files are respected unless you pass `--no-ignore` or `--hidden`.
A binary file, a NUL byte in its first 8 KiB, is counted and skipped.

## Output

stdout carries one JSON report per file whenever it is piped or redirected,
and nothing when it is a terminal. stderr lists every quantity.

```text
$ units-le config.yaml
config.yaml:2:12  30s  30000 milliseconds
config.yaml:3:10  512MiB  536870912 bytes
config.yaml:4:11  10MB  10000000 bytes
config.yaml:6:8  500m  refused: ambiguous_unit
4 quantities in 1 file
1 quantity refused, each with a reason
```

## Exit codes

They follow grep:

- **0**: quantities found.
- **1**: none found.
- **2**: the question was malformed, a directory could not be walked, or
  `--strict` and a quantity was refused or a file could not be read.

## For agents

`units-le mcp` serves the Model Context Protocol on stdio with two tools:
`extract_units` for a document's text and `units_le_scan` for files and
directories. Hosts that want the document tool alone can install
[`units-le-mcp`](https://www.npmjs.com/package/units-le-mcp).

`units-le --help` lists every option.

MIT licensed. Part of [letools](https://letools.dev/tools/units-le).
