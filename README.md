<p align="center">
  <img src="https://raw.githubusercontent.com/nolindnaidoo/units-le/main/assets/icon.png" alt="Units-LE logo" width="96" height="96"/>
</p>
<h1 align="center">Units-LE</h1>
<p align="center">
  <b>Extract every quantity in a codebase — the number <i>and</i> its unit</b><br/>
  <i>normalised to one base unit so two configs can be compared, and refused by name when it cannot be</i>
</p>

<p align="center">
  <a href="https://crates.io/crates/units-le">
    <img src="https://img.shields.io/crates/v/units-le?style=for-the-badge&label=Rust%20CLI&color=blue&logo=rust" alt="units-le on crates.io" />
  </a>
  <a href="https://crates.io/crates/units-le">
    <img src="https://img.shields.io/crates/d/units-le?style=for-the-badge&label=Downloads&color=blue" alt="crates.io downloads" />
  </a>
  <a href="https://github.com/nolindnaidoo/units-le/actions/workflows/ci-crate.yml">
    <img src="https://img.shields.io/github/actions/workflow/status/nolindnaidoo/units-le/ci-crate.yml?branch=main&style=for-the-badge&label=CI&color=blue&logo=githubactions&logoColor=white" alt="CI" />
  </a>
  <a href="https://github.com/nolindnaidoo/units-le/blob/main/crate/Cargo.toml">
    <img src="https://img.shields.io/badge/rustc-1.88+-blue?style=for-the-badge&logo=rust" alt="MSRV: Rust 1.88+" />
  </a>
  <a href="https://github.com/nolindnaidoo/units-le/blob/main/LICENSE">
    <img src="https://img.shields.io/badge/license-MIT-blue?style=for-the-badge" alt="MIT licensed" />
  </a>
  <a href="https://letools.dev/tools/units-le">
    <img src="https://img.shields.io/badge/LE%20Tools-letools.dev-blue?style=for-the-badge" alt="LE Tools" />
  </a>
</p>

---

<p align="center">
  <img src="https://raw.githubusercontent.com/nolindnaidoo/units-le/main/assets/demo.gif" alt="Units-LE demo — the real binary, recorded by assets/demo.tape" style="max-width: 100%; height: auto;" />
</p>

> **Useful?** A star is how other developers find it —
> [★ GitHub](https://github.com/nolindnaidoo/units-le) ·
> [letools.dev/tools/units-le](https://letools.dev/tools/units-le)

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

```bash
cargo install units-le
```

Or build it from this repository:

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

## Documentation

| What | Where |
|---|---|
| What the tool is allowed to say — scope, output contract, refusals, non-goals | [`crate/SPEC.md`](crate/SPEC.md) |
| How the code is written and held together — architecture, invariants, the gates | [`crate/AGENTS.md`](crate/AGENTS.md) |
| The crate's own front page | [`crate/README.md`](crate/README.md) |
| What changed | [CHANGELOG.md](CHANGELOG.md) · [`crate/CHANGELOG.md`](crate/CHANGELOG.md) |
| The tool's page, and the other fifteen | [letools.dev/tools/units-le](https://letools.dev/tools/units-le) |

## More from the LE family

Sixteen single-purpose tools for the work in front of every model. Each ships
a Rust CLI and an MCP server. One page: **[letools.dev](https://letools.dev)**

**Get it out**

- **[String-LE](https://letools.dev/tools/string-le)** — Extract every string in a codebase, with its position, so a person can read them
- **[Numbers-LE](https://letools.dev/tools/numbers-le)** — Extract every hardcoded number in a codebase, so a person can check them
- **[Units-LE](https://letools.dev/tools/units-le)** — Extract every quantity with its unit, normalized, and refuse the ambiguous ones by name
- **[Dates-LE](https://letools.dev/tools/dates-le)** — Extract every date and timestamp, and the exact instant each one resolves to
- **[IDs-LE](https://letools.dev/tools/ids-le)** — Extract every UUID, ULID, NanoID, ObjectId and Snowflake, and decode the time inside
- **[IPs-LE](https://letools.dev/tools/ips-le)** — Extract every IP address, CIDR block and MAC, normalized and classified by scope
- **[URLs-LE](https://letools.dev/tools/urls-le)** — Extract every URL in a codebase, with its protocol and exact position
- **[Paths-LE](https://letools.dev/tools/paths-le)** — Extract every file path in a codebase, and say whether it still points at anything
- **[Colors-LE](https://letools.dev/tools/colors-le)** — Extract every color in a codebase, and say which ones are not in your palette

**Check it**

- **[Regex-LE](https://letools.dev/tools/regex-le)** — Find every regex in a codebase, and report which can be driven into catastrophic backtracking
- **[Versions-LE](https://letools.dev/tools/versions-le)** — Find where one dependency is constrained differently across a repository's manifests
- **[i18n-LE](https://letools.dev/tools/i18n-le)** — Identify the i18n library a project uses, then audit its catalogs by that library's rules
- **[Scrape-LE](https://letools.dev/tools/scrape-le)** — Check whether a page is scrapeable before the scraper is written, and say when it cannot tell

**Guard it**

- **[Secrets-LE](https://letools.dev/tools/secrets-le)** — Find hardcoded credentials in a codebase, and never print one into the report
- **[EnvSync-LE](https://letools.dev/tools/envsync-le)** — Compare the dotenv files in a tree, and say which keys are missing from which
- **[Unicode-LE](https://letools.dev/tools/unicode-le)** — Find the Unicode that hides meaning — bidi controls, invisibles, homoglyphs, mixed scripts

Each stands on its own: no shared crate, no published core. Where two of them
agree, it is because the same answer was right twice.

**Contact** — [nolindnaidoo.com](https://nolindnaidoo.com) · [GitHub](https://github.com/nolindnaidoo) · [LinkedIn](https://www.linkedin.com/in/nolindnaidoo/)

## Also by nolindnaidoo

**Rust** — pixelcoords and pixelactions are one loop: pixelcoords answers
*where*, pixelactions *acts* there. Their own tools, their own voice — not
part of the LE family.

- **[pixelcoords](https://github.com/nolindnaidoo/pixelcoords)** — Freeze your screen, mark regions, get pixel-exact coordinates and crops
  [pixelcoords.dev](https://pixelcoords.dev) · [crates.io](https://crates.io/crates/pixelcoords) · [docs.rs](https://docs.rs/pixelcoords)
- **[pixelactions](https://github.com/nolindnaidoo/pixelactions)** — Consume human-verified coordinates, perform the interaction, confirm it landed
  [pixelactions.dev](https://pixelactions.dev) · [crates.io](https://crates.io/crates/pixelactions) · [docs.rs](https://docs.rs/pixelactions)

## License

MIT © [nolindnaidoo](https://github.com/nolindnaidoo) — see [LICENSE](LICENSE).
