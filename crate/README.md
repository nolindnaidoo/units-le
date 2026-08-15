<p align="center">
  <img src="https://raw.githubusercontent.com/nolindnaidoo/units-le/main/assets/icon.png" alt="units-le logo" width="96" height="96"/>
</p>

<h1 align="center">units-le</h1>

<p align="center">
  <b>Extract every quantity in a codebase — the number <i>and</i> its unit</b><br/>
  <i>normalised to one base unit so two configs can be compared, and refused by name when it cannot be</i>
</p>

<p align="center">
  <a href="https://crates.io/crates/units-le">
    <img src="https://img.shields.io/crates/v/units-le.svg" alt="units-le on crates.io" />
  </a>
  <a href="https://crates.io/crates/units-le">
    <img src="https://img.shields.io/crates/d/units-le.svg" alt="crates.io downloads" />
  </a>
  <a href="https://github.com/nolindnaidoo/units-le/actions/workflows/ci-crate.yml">
    <img src="https://github.com/nolindnaidoo/units-le/actions/workflows/ci-crate.yml/badge.svg" alt="Build Status" />
  </a>
  <img src="https://img.shields.io/badge/rustc-1.88+-93450a.svg" alt="MSRV: Rust 1.88+" />
  <a href="https://github.com/nolindnaidoo/units-le/blob/main/LICENSE">
    <img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License: MIT" />
  </a>
  <a href="https://letools.dev/tools/units-le">
    <img src="https://img.shields.io/badge/web-letools.dev-00A0FF.svg" alt="letools.dev" />
  </a>
</p>

<p align="center">
  <img src="https://raw.githubusercontent.com/nolindnaidoo/units-le/main/assets/demo.gif" alt="units-le demo — the real binary, recorded by assets/demo.tape" width="100%"/>
</p>

> **Useful?** A star is how other developers find it —
> [★ GitHub](https://github.com/nolindnaidoo/units-le) ·
> [letools.dev/tools/units-le](https://letools.dev/tools/units-le)

`timeout: 30s` in one service and `timeout: 30000` in another are the
same number of milliseconds, and nothing about the text says so.
`memory: 1GB` and `memory: 1GiB` differ by 7% and look identical at a
glance. Someone has to reconcile them — before a migration, against a
runbook, against a retention policy that says the limit in words.

A schema validator does not serve them: it checks that a field is a
string. A duration-parsing library does not either — it resolves `1.5KB`
to 1500 and a bare `m` to whichever unit its author picked, silently.

```bash
units-le config/
```

```
config/api.yaml:1:6  1h30m  5400000 milliseconds
config/api.yaml:2:7  1MB  1000000 bytes
config/cache.yaml:1:9  512MiB  536870912 bytes
config/cache.yaml:2:6  500m  refused: ambiguous_unit
4 quantities in 2 files
1 quantity refused, each with a reason
```

**Exit codes follow grep** — `0` quantities found, `1` none found, `2`
the question was malformed. Finding none is an answer, not an error.

## A refusal is a finding

This is the whole product. Any tool can multiply `30s` by a thousand;
what makes this one usable in a review is that it will not pretend.

| It sees | It says |
|---|---|
| `500m` | `ambiguous_unit` — minutes, milliseconds, or Kubernetes millicores? |
| `1.5KB` | `fractional_bytes` — a byte count has no fractional part |
| `1,5s` | `locale_separator` — one and a half, or fifteen hundred? |
| `1h + 30m`, `30s*2` | `compound_arithmetic` — an expression, not a quantity |
| `1MB` | `si_iec_hazard` — **1000000 bytes**, and the writer may have meant 2^20 |
| `99999…PiB` | `out_of_range` — refused rather than wrapped |

Every one of them keeps its row, its source text, its position and a
sentence a person can act on:

```json
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
```

**`si_iec_hazard` is the one that still answers.** `MB` is 10^6 by the
standard, so that is what it reports — the hazard is that a great deal
of software writes `MB` and means 2^20. Reporting nothing would be less
useful; picking 2^20 would be the guess this exists not to make.

**A bare number with no unit is not a finding at all.** `timeout: 30`
yields nothing here — that is
[numbers-le](https://github.com/nolindnaidoo/numbers-le)'s question, and
the boundary is what keeps the two tools distinct.

## Sixty seconds

```bash
units-le .                                 # every quantity in the tree, as JSON
units-le --dimension duration config/      # only the timeouts
units-le --strict config/                  # exit 2 if anything was refused
cat values.yaml | units-le --stdin --format yaml

# the point of the whole thing:
units-le config/ | jq -r '.quantities[] | select(.dimension=="duration") | "\(.key)\t\(.base)"'
```

## Install

| Route | Command | Worth knowing |
|---|---|---|
| **crates.io** | `cargo install units-le` | Needs **Rust 1.88+**. |
| **From source** | `git clone https://github.com/nolindnaidoo/units-le`<br>`cd units-le/crate && cargo build --release` | The same build CI runs. |

No runtime, no network, nothing written.

## Four dimensions

| Dimension | Base unit | Read |
|---|---|---|
| `duration` | milliseconds | `30s` `300ms` `5min` `1h` `7d` `1w` · compounds `1h30m` · ISO-8601 `PT1H30M` `P1DT2H` |
| `bytes` | bytes | `512B` · SI `2GB` · IEC `512MiB` · Kubernetes `128Mi` |
| `percent` | ratio | `15%` → `0.15` |
| `frequency` | hertz | `60Hz` `44.1kHz` `2.4GHz` |

**Case is part of the symbol.** `MB` is a megabyte and `Mb` is a
megabit; folding them would silently multiply by eight, so `Mb` is
refused rather than treated as a synonym.

**Physical units are a non-goal, not a gap.** Length, mass, temperature
belong to a different question, and reading them would mean unit algebra
(`m/s²`), which is what `uom` is for. See SPEC.md.

## `1h30m` is a grammar. `1h + 30m` is arithmetic.

The first is one quantity written in two parts and is read as 5400000
milliseconds. The second is refused — as **one** finding, not two,
because reporting `1h` and `30m` separately is a true statement about the
text and a false one about the value.

Inside a compound the parts disambiguate each other. `m` on its own is
refused; `m` between `h` and `s` can only be minutes, because a compound
is written largest-first. That ordering is required rather than assumed,
so `30s1h` is not a quantity at all.

An operand with no unit is still an operand, so `30s*2` and `1h + 30`
are refused too — reporting `30s` for a line that says twice that is the
same wrong answer in a shorter form. Some operand has to carry a unit,
which is why `2026-08-12` and `1-2` yield nothing at all.

## Exactness is the contract

Base values are computed as exact decimals — a sign, an integer mantissa
and a power-of-ten scale — never through a float. Through an `f64`,
`0.1s` is `100.00000000000001` milliseconds: not wrong by enough to
notice, not right by enough to compare, and comparing is the whole
reason a base value exists.

Every conversion is a checked integer multiply, so an overflowing `PiB`
count is `out_of_range` rather than a wrapped number that looks fine.

That is also why `value` and `base` are both **strings** in the JSON.
Re-encoding through a JSON number hands you whatever your parser prints,
and a byte count past 2^53 comes back as a different number.

## Formats

JSON, JSONC, YAML, CSV, TSV, TOML, INI and dotenv are parsed.
**Everything else is scanned as text** — a Kubernetes manifest, a
Terraform file, a Markdown table of limits, a log, and `.conf` and
`.cfg`, which are almost never INI — so the files where quantities
actually live yield them rather than nothing.

Unlike numbers-le's text scan, this one has a shape to look for, so
`v1.2.3` yields nothing rather than two numbers. Its known
false-positive class is **measured** rather than left to be discovered:
a run inside an opaque blob still reads as a quantity — `001d` in a
UUID is one day, and a base64 hash ending `/2w==` is two weeks. Over
`fixtures/documents/opaque.txt`, 280 lines of lockfile hashes, container
digests, git object names and UUIDs with not one quantity among them,
the rate is **5 false findings — 1.8%**, recomputed and printed on every
test run. Each is reported with its line and column, which is what makes
it a row you discard rather than a number you trust.

Every format with a shape carries a key path — `cache.ttl`,
`limits[0]`, `server.timeout`, `TIMEOUT` — and every finding carries a
1-based line and column, the column in UTF-16 units, which is the number
your editor shows.

## It has no opinions

No "this timeout is too low". No defaults database. No conversion flag,
no rewriting, no arithmetic. It reports what a document says and what
that means in one base unit; which limits are right is the reviewer's
call.

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

**A format falls back and a dimension does not.** A format nobody
recognises still has an answer — scan the text. A dimension nobody
recognises has none.

**A refusal that names no dimension survives every filter.** A bare
`500m` could be a duration or a byte count — that is why it was refused
— so dropping it under `--dimension bytes` would be the tool deciding
what it just said it could not decide.

## As an MCP server

```bash
units-le mcp
```

Two tools, both returning `{ ok, data, diagnostics, meta }`:

- **`extract_units`** — content in, quantities out, with key paths and
  positions. Touches no filesystem.
- **`units_le_scan`** — files or directories in, the same reports the
  CLI writes.

A refusal is a successful answer carrying a reason, never an error. Only
a malformed question is an error.

## Documentation

| What | Where |
|---|---|
| What this tool is allowed to say — scope, output contract, refusals, non-goals | [SPEC.md](https://github.com/nolindnaidoo/units-le/blob/main/crate/SPEC.md) |
| How the code is written and held together — architecture, invariants, the gates | [AGENTS.md](https://github.com/nolindnaidoo/units-le/blob/main/crate/AGENTS.md) |
| What changed | [CHANGELOG.md](https://github.com/nolindnaidoo/units-le/blob/main/crate/CHANGELOG.md) |
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

MIT — see [LICENSE](LICENSE).
