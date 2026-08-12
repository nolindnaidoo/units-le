# Changelog

The Rust CLI and MCP server.

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versioning: [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-08-12

First release. Core functionality: the grammar, six formats plus a text
scan, both surfaces, and the corpus that pins them.

### Added

- **Quantities, not numbers.** Every finding carries the text the
  document holds *and* that value in a base unit — milliseconds, bytes,
  a ratio, hertz — so `timeout: 30s` and `timeout: 30000` can be
  compared. Both are strings, because re-encoding a byte count through a
  JSON number changes it past 2^53.

- **Refusals as first-class findings**, which is the product rather than
  a feature of it. `ambiguous_unit`, `fractional_bytes`,
  `locale_separator`, `compound_arithmetic`, `si_iec_hazard` and
  `out_of_range`, each with the source text, a named reason and a
  sentence a person can act on. A refusal is never a dropped row and
  never a guess.

  `si_iec_hazard` is the one that answers: `1MB` reports 1000000 bytes
  *and* flags that the writer may have meant 2^20, because SI is what
  the symbol says and picking the other reading would be the guess this
  tool exists not to make.

- **A hand-written grammar**, pinned in one file: plain suffixes (`30s`,
  `300ms`, `1h`, `7d`), compounds (`1h30m`), ISO-8601 (`PT1H30M`,
  `P1DT2H`), SI and IEC byte multiples, the Kubernetes `128Mi` spelling,
  percentages and frequencies. No `byte-unit`, `humantime`,
  `duration-str` or `uom` — each of them resolves the cases this refuses.

  Inside a compound the parts disambiguate each other: `m` alone is
  refused and `m` between `h` and `s` is minutes, which is why
  descending order is required and `30s1h` is not a quantity.

- **Exact decimal arithmetic.** A sign, an integer mantissa and a
  power-of-ten scale — never an `f64`, through which `0.1s` is
  `100.00000000000001` milliseconds. Every conversion is a checked
  integer multiply and an overflow is `out_of_range` rather than a wrap.

- **Six formats and a text scan** — JSON, YAML, TOML, INI, dotenv, CSV,
  and raw text for everything else. Every quantity is a string value, so
  there is no typed/untyped coercion split: a typed `timeout = 30` is
  the one thing that can never be a quantity.

- **Key paths** where the format has one — `cache.ttl`, `limits[0]`,
  `server.timeout`, `TIMEOUT` — and **positions**: 1-based line and
  column, the column in UTF-16 units, found by searching for the source
  text forward-only down the document.

- **The CLI**: JSON reports on stdout one per line, a human summary on
  stderr, and exit codes following grep — 0 quantities found, 1 none
  found, 2 the question was malformed. A refusal does not change the
  exit code unless `--strict`. `--dimension`, `--format`, `--strict`,
  `--stdin`, `--hidden`, `--no-ignore`.

- **The MCP server** (`units-le mcp`) with two tools — `extract_units`,
  which touches no filesystem, and `units_le_scan` — both returning
  `{ ok, data, diagnostics, meta }`, where a refusal is a successful
  answer carrying a reason rather than an error.

### Known limitations

Written down rather than left to be discovered, each pinned by a test.

- **The text scan reads runs inside opaque blobs.** `001d` in a UUID is
  one day, and a base64 hash ending `/2w==` is two weeks — four such
  rows came out of one `bun.lock`. The boundary characters that let them
  through are the same ones that let `-30s` and `ttl=30s` through.
- **A run in a key can take a position.** In `retry_30s: 30s` the value
  matches the digits in the key. The quantity is right; the position is
  a best effort, and forward-only so it can never point above a quantity
  already reported.
- **A value the parser spelled differently from its source** — a JSON
  escape — reports no position rather than a wrong one.
- **An unterminated quote in a CSV file is read to the end of the
  file** rather than refused. That is the `csv` crate's behaviour;
  detecting it would mean writing a second CSV lexer to disagree with
  the first.

[0.1.0]: https://github.com/nolindnaidoo/units-le/releases/tag/crate-v0.1.0
