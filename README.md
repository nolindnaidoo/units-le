<h1 align="center">units-le</h1>

<p align="center">
  <b>Extract every quantity in a codebase — the number <i>and</i> its unit</b><br/>
  <i>normalised to one base unit so two configs can be compared, and refused by name when it cannot be</i>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/rustc-1.88+-93450a.svg" alt="MSRV: Rust 1.88+" />
  <img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License: MIT" />
  <img src="https://img.shields.io/badge/status-v0.1.0-lightgrey.svg" alt="Status: v0.1.0" />
</p>

---

## What it does

`timeout: 30s` in one service and `timeout: 30000` in another are the
same number of milliseconds, and nothing about the text says so.
`memory: 1GB` and `memory: 1GiB` differ by 7% and look identical at a
glance. Someone has to reconcile them — before a migration, against a
runbook, against a retention policy that states the limit in words.

A schema validator does not serve them: it checks that a field is a
string. A duration-parsing library does not either — it resolves
`1.5KB` to 1500 and a bare `m` to whichever unit its author picked,
silently, which is the failure this tool exists to prevent.

units-le walks a tree, finds every quantity in it — a number welded to
a unit — and reports each one twice: as the document wrote it, and in
one base unit so two of them can be compared.

```bash
units-le config/
```

```
config/api.yaml:1:10  1h30m  5400000 milliseconds
config/api.yaml:2:9  1MB  1000000 bytes
config/cache.yaml:1:6  512MiB  536870912 bytes
config/cache.yaml:2:6  500m  refused: ambiguous_unit
4 quantities in 2 files
1 quantity refused, each with a reason
```

That is stderr, for a person. stdout is protocol — one JSON report per
line, one line per file:

```json
{
  "schema": 1,
  "file": "config/cache.yaml",
  "format": "yaml",
  "quantities": [
    {
      "value": "512MiB",
      "dimension": "bytes",
      "baseUnit": "bytes",
      "base": "536870912",
      "key": "ttl",
      "line": 1,
      "column": 6
    },
    {
      "value": "500m",
      "dimension": null,
      "baseUnit": null,
      "base": null,
      "reason": "ambiguous_unit",
      "detail": "`m` is minutes in one config format, milliseconds in another and millicores in Kubernetes. Write `min`, `ms`, or spell out the core count.",
      "key": "cpu",
      "line": 2,
      "column": 6
    }
  ],
  "diagnostics": [],
  "summary": { "quantities": 2, "refused": 1 }
}
```

There is no `--json` flag. One mode, nothing to misremember, and the
human summary is a projection of the same reports so the two cannot
drift.

## Install

**Not on crates.io yet.** Build it from this repository:

```bash
git clone https://github.com/nolindnaidoo/units-le
cd units-le/crate
cargo build --release      # target/release/units-le
```

Needs **Rust 1.88+**, which is the version CI checks the declared MSRV
against. No runtime, no network, nothing written.

## A refusal is a finding

This is the whole product. Any tool can multiply `30s` by a thousand;
what makes this one usable in a review is that it will not pretend.

| It sees | Reason | What comes back |
|---|---|---|
| `500m`, `10M`, `5k`, `1y`, `100Mb` | `ambiguous_unit` | no base value — `m` is minutes, milliseconds or Kubernetes millicores; `M` is mega- or minutes; `k`/`K`/`G`/`T`/`P` are prefixes with no unit after them; a calendar year has no fixed length; a lowercase `b` is bits by the standard and bytes in most software that writes it |
| `1.5KB`, `1.5KiB` | `fractional_bytes` | no base value — a byte count has no fractional part. `1.5KiB` is exactly 1536 bytes and is **still** refused: the refusal is about the category, not the arithmetic |
| `1,5s`, `1.000s`, `1.2.3s` | `locale_separator` | no base value — one and a half, or fifteen hundred? This tool does not infer a locale. Narrowed so `0.825s` and `2.5s` read normally |
| `1h + 30m`, `30s*2` | `compound_arithmetic` | no base value — an expression, not a quantity, reported as **one** finding rather than two |
| `1MB`, `256KB` | `si_iec_hazard` | **the base value, plus the reason** — see below |
| `99999…PiB` | `out_of_range` | no base value — it does not fit in 128 bits, and is refused rather than wrapped |

Every one of them keeps its row, its source text, its position and a
sentence a person can act on. A refusal is never a dropped row and
never a guess.

### `si_iec_hazard` annotates; it does not withhold

It is the one reason that still answers. `MB` is 10^6 by the standard,
so `1MB` comes back as **1000000 bytes** *and* carries
`reason: "si_iec_hazard"` — because a great deal of software writes
`MB` and means 2^20. Reporting nothing would be less useful than
reporting the standard answer with the flag attached, and picking 2^20
would be the guess this tool exists not to make.

So it is **not counted in `summary.refused`** and it does **not** trip
`--strict`. A row with `si_iec_hazard` is the only row that carries both
a `base` and a `reason`; every other reason means the base is `null`.

**A bare number with no unit is not a finding at all.** `timeout: 30`
yields nothing here — that is
[numbers-le](https://github.com/nolindnaidoo/numbers-le)'s question, and
the boundary is what keeps the two tools distinct.

## Four dimensions

| Dimension | Base unit | Units read |
|---|---|---|
| `duration` | milliseconds | `ns` `us` `µs` `μs` `ms` `s` `sec` `secs` `min` `mins` `h` `hr` `hrs` `d` `day` `days` `w` · compounds `1h30m` · ISO-8601 `PT1H30M` `P1DT2H` `P2W` `PT0.5S` |
| `bytes` | bytes | `B` · SI `kB` `KB` `MB` `GB` `TB` `PB` · IEC `KiB` `MiB` `GiB` `TiB` `PiB` · Kubernetes `Ki` `Mi` `Gi` `Ti` `Pi` |
| `percent` | ratio | `%` — `15%` is `0.15` |
| `frequency` | hertz | `Hz` `kHz` `KHz` `MHz` `GHz` `THz` |

**Case is part of the symbol.** `MB` is a megabyte and `Mb` is a
megabit; folding them would silently multiply by eight, so `Mb` is
refused rather than treated as a synonym.

**`1h30m` is a grammar and `1h + 30m` is arithmetic.** The first is one
quantity written in two parts. Inside a compound the parts disambiguate
each other — `m` alone is refused, and `m` between `h` and `s` can only
be minutes, because a compound is written largest-first. That ordering
is required rather than assumed, so `30s1h` is not a quantity at all.

**Physical units are a non-goal, not a gap.** Length, mass, temperature
belong to a different question, and reading them would mean unit algebra
(`m/s²`), which is what `uom` is for. See
[`crate/SPEC.md`](crate/SPEC.md).

## Exit codes are the API

Following grep, as the rest of the family does:

- **0** — quantities found.
- **1** — none found. An answer, not an error.
- **2** — the question was malformed: an unknown flag, an unrecognised
  dimension, a path that does not exist.

**A refusal does not change the exit code.** A tree full of ambiguous
units is a real result, and `if units-le config/; then` has to see it as
success. `--strict` is the opt-in for a pipeline that wants every
quantity resolved or the build stopped: it exits 2 on any refusal, and
on any text file that could not be read.

Exit 2 does **not** mean one file in fifty thousand was a PNG. A binary
file — a NUL byte in the first 8 KiB, ripgrep's own test — produces no
report line and never affects the exit code; it is counted on stderr so
a reader still knows coverage was narrower than the tree.

## Options

```
--dimension <name>   report only duration, bytes, percent or frequency
--format <format>    force a format instead of inferring from the name;
                     an unknown name falls back to the text scan
--strict             exit 2 if any quantity was refused, or any text
                     file could not be read
--stdin              read one document from stdin
--hidden             walk hidden files and directories too
--no-ignore          walk files that .gitignore excludes
```

```bash
units-le .                                 # every quantity in the tree
units-le --dimension duration config/      # only the timeouts
units-le --strict config/                  # exit 2 if anything was refused
cat values.yaml | units-le --stdin --format yaml

# the point of the whole thing:
units-le config/ | jq -r '.quantities[] | select(.dimension=="duration") | "\(.key)\t\(.base)"'
```

**A format falls back and a dimension does not.** A format nobody
recognises still has an answer — scan the text. A dimension nobody
recognises has none, and quietly reporting all four would answer a
question that was not asked.

**A refusal that names no dimension survives every filter.** A bare
`500m` could be a duration or a byte count — that is why it was refused
— so dropping it under `--dimension bytes` would be the tool deciding
what it just said it could not decide.

## Formats

JSON, YAML, CSV, TOML, INI and dotenv are parsed. **Everything else is
scanned as text** — a Kubernetes manifest, a Terraform file, a Markdown
table of limits, a log — so the files where quantities actually live
yield them rather than nothing.

Unlike numbers-le's text scan, this one has a shape to look for, so
`v1.2.3` yields nothing rather than two numbers. Every format with a
shape carries a key path — `cache.ttl`, `limits[0]`, `server.timeout`,
`TIMEOUT` — and every finding carries a 1-based line and column, the
column in UTF-16 units, which is the number your editor shows.

**Its false-positive class is measured rather than imagined.** A run
inside an opaque blob still reads as a quantity: `001d` in a UUID is one
day, and a base64 hash ending `/2w==` is two weeks. The boundary
characters that let those through are the same ones that let `-30s` and
`ttl=30s` through. Over `crate/fixtures/documents/opaque.txt` — 280
lines of lockfile hashes, container digests, git object names, UUIDs and
signing material, none of which is a quantity — the scan reports **5
false findings, 1.8%**, and a test prints that number on every run.
Each one carries its line and column, which is what makes it a row you
discard rather than a number you trust.

## As an MCP server

```bash
units-le mcp
```

Two tools, both returning `{ ok, data, diagnostics, meta }`:

- **`extract_units`** — content in, quantities out, with key paths and
  positions. Touches no filesystem.
- **`units_le_scan`** — files or directories in, the same reports the
  CLI writes.

`ok` reports whether the check ran, never whether the answer was yes. A
refusal is a successful answer carrying a reason; only a malformed
question is an error.

## It has no opinions

No "this timeout is too low". No defaults database. No conversion flag,
no rewriting, no arithmetic. It reports what a document says and what
that means in one base unit; which limits are right is the reviewer's
call.

## Development

```bash
cd crate
cargo fmt --all --check
cargo clippy --all-targets -- -D warnings
cargo test --locked
```

Those three are the definition of done and exactly what CI runs.
Architecture and conventions live in [AGENTS.md](AGENTS.md), which
routes to [`crate/AGENTS.md`](crate/AGENTS.md); the product behaviour is
[`crate/SPEC.md`](crate/SPEC.md). Changes are tracked in
[CHANGELOG.md](CHANGELOG.md).

## Testing

256 tests: 198 unit tests inside the modules they cover, and seven
integration suites against the built binary.

| Suite | What it holds | Run |
|---|---|---|
| `contracts` | the exit codes and the stdout contract — the API a shell branches on | `cargo test --test contracts` |
| `coverage_matrix` | every extension, format reader, dimension and reason, reached through the binary | `cargo test --test coverage_matrix` |
| `hazards` | a byte-order mark, invalid UTF-8, a UTF-16 document, a FIFO, permission denied, a symlink loop, a path over 260 characters, several megabytes on one line | `cargo test --test hazards` |
| `platform` | report paths, TZ independence, case folding, reserved Windows names, CRLF, early stdin | `cargo test --test platform` |
| `fuzz` | hostile quantity text against the grammar and the exact decimals — never a panic, never a hang, never an overflow | `UNITS_LE_FUZZ_SECONDS=60 cargo test --release --test fuzz` |
| `budget` | a wall-clock ceiling and three linearity checks | `UNITS_LE_BUDGET=1 cargo test --release --test budget` |
| `scenarios` | documents larger than an editor opens | `UNITS_LE_SCENARIOS=1 cargo test --test scenarios` |

`budget` and `scenarios` are gated because they are timing and size
tests with no business running mid-edit; a skipped one says so by name
rather than reporting a pass.

Line coverage in `crate/src/extract/`, the pure layer, with a **90% floor
enforced per module** in CI — per module rather than on the total,
because a total hides one module sliding while the others carry it:

| Module | Lines | Module | Lines |
|---|---|---|---|
| `corpus.rs` | 98.82% | `locate.rs` | 100.00% |
| `csv.rs` | 96.23% | `mod.rs` | 100.00% |
| `decimal.rs` | 99.07% | `policy.rs` | 100.00% |
| `dotenv.rs` | 100.00% | `position.rs` | 100.00% |
| `fallback.rs` | 98.61% | `toml.rs` | 100.00% |
| `format.rs` | 100.00% | `yaml.rs` | 95.77% |
| `grammar.rs` | 92.01% | `ini.rs` | 100.00% |
| `json.rs` | 100.00% | | |

Reproduce with `cargo llvm-cov` in `crate/`. The floor is a floor and is
never lowered to make a build pass.

## More from the LE Family

Every tool in the family, one page: **[letools.dev](https://letools.dev)**

- **[Paths-LE](https://letools.dev/tools/paths-le)** - Extract file paths from JS/TS imports, JSON, HTML, CSS, TOML, CSV, and .env
- **[String-LE](https://letools.dev/tools/string-le)** - Extract string values for i18n from JSON, YAML, CSV, TOML, INI, and .env
- **[Numbers-LE](https://letools.dev/tools/numbers-le)** - Extract numeric values from JSON, YAML, CSV, TOML, INI, and .env
- **[EnvSync-LE](https://letools.dev/tools/envsync-le)** - Spot missing keys across your .env files, with a markdown report
- **[Regex-LE](https://letools.dev/tools/regex-le)** - Find, test, and validate regular expressions with ReDoS screening
- **[Secrets-LE](https://letools.dev/tools/secrets-le)** - Detect and sanitize credentials locally, before you commit
- **[Colors-LE](https://letools.dev/tools/colors-le)** - Extract and analyze colors from CSS, SCSS, LESS, Stylus, HTML, JS/TS, and SVG
- **[URLs-LE](https://letools.dev/tools/urls-le)** - Extract URLs from documentation, configs, and code
- **[Dates-LE](https://letools.dev/tools/dates-le)** - Extract and analyze dates from logs, configs, and code
- **[Scrape-LE](https://letools.dev/tools/scrape-le)** - Check whether a page is scrapeable before the scraper is written

## Also by nolindnaidoo

**Rust** — pixelcoords and pixelactions are one loop: pixelcoords
answers *where*, pixelactions *acts* there. The LE crates are the
terminal half of the family.

- **[pixelcoords](https://github.com/nolindnaidoo/pixelcoords)** — Freeze your screen, mark regions, get pixel-exact coordinates and crops
  [pixelcoords.dev](https://pixelcoords.dev) · [crates.io](https://crates.io/crates/pixelcoords) · [docs.rs](https://docs.rs/pixelcoords)
- **[pixelactions](https://github.com/nolindnaidoo/pixelactions)** — Consume human-verified coordinates, perform the interaction, confirm it landed
  [pixelactions.dev](https://pixelactions.dev) · [crates.io](https://crates.io/crates/pixelactions)
- **[numbers-le](https://github.com/nolindnaidoo/numbers-le/tree/main/crate)** — Find every hardcoded number in a codebase so a person can check them
  [crates.io](https://crates.io/crates/numbers-le)
- **[paths-le](https://github.com/nolindnaidoo/paths-le/tree/main/crate)** — Find every path in a codebase and report whether it still points at anything
  [crates.io](https://crates.io/crates/paths-le)
- **[secrets-le](https://github.com/nolindnaidoo/secrets-le/tree/main/crate)** — Find hardcoded credentials, and never print one
  [crates.io](https://crates.io/crates/secrets-le)
- **[urls-le](https://github.com/nolindnaidoo/urls-le/tree/main/crate)** — Extract every URL from a codebase, with its protocol and exact position
  [crates.io](https://crates.io/crates/urls-le)
- **[regex-le](https://github.com/nolindnaidoo/regex-le/tree/main/crate)** — Find every regex in a codebase and report which can be driven into catastrophic backtracking
  [crates.io](https://crates.io/crates/regex-le)
- **[string-le](https://github.com/nolindnaidoo/string-le/tree/main/crate)** — Get every string in a codebase out where a person can read them
  [crates.io](https://crates.io/crates/string-le)
- **[envsync-le](https://github.com/nolindnaidoo/envsync-le/tree/main/crate)** — Compare the dotenv files in a tree and say which keys are missing from which
  [crates.io](https://crates.io/crates/envsync-le)
- **[colors-le](https://github.com/nolindnaidoo/colors-le/tree/main/crate)** — Find every colour in a codebase, and say which are not in your palette
  [crates.io](https://crates.io/crates/colors-le)
- **[scrape-le](https://github.com/nolindnaidoo/scrape-le/tree/main/crate)** — Check whether a page is scrapeable before the scraper is written
  [crates.io](https://crates.io/crates/scrape-le)

**Contact Developer** — [nolindnaidoo.com](https://nolindnaidoo.com) · [GitHub](https://github.com/nolindnaidoo) · [LinkedIn](https://www.linkedin.com/in/nolindnaidoo/)

## License

MIT © [nolindnaidoo](https://github.com/nolindnaidoo) — see [LICENSE](LICENSE).
