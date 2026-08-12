# units-le — Rust specification

The unit-aware sibling of [numbers-le](https://github.com/nolindnaidoo/numbers-le).
numbers-le answers *what numbers are in here*, and it has no unit
concept. Given `memory: 512MiB` it reports `512` in prose and **nothing
at all** in YAML — where the value is a string rather than a number —
so a quantity either loses its unit or vanishes. Verified against the
binary, not assumed.

This one extracts **quantities** — a number together with its unit — and
reports each one twice: as the document wrote it, and in a base unit so
two of them can be compared.

## The one question

**What does this configuration actually specify, and where two files
disagree, do they?**

`timeout: 30s` in one service and `timeout: 30000` in another are the
same number of milliseconds and nothing about the text says so. `memory:
1GB` and `memory: 1GiB` differ by 7% and look identical at a glance.
That comparison is what a base value is for.

## Who asks it

Someone reconciling configuration across services, or against a document
that states the limits: an SRE before a migration, a reviewer checking a
runbook against what is deployed, an auditor holding a retention policy
next to the config that implements it.

A schema validator does not serve them — it checks that a field is a
string. A duration-parsing library does not either: it resolves `1.5KB`
to 1500 and a bare `m` to whichever unit its author picked, silently,
which is the failure this tool exists to prevent.

## The design spine: a refusal is a finding

**A quantity this cannot resolve is reported with a named reason and no
base value.** It is never a dropped row and it is never a guess.

That is the whole product. Any tool can multiply `30s` by a thousand;
what makes this one usable in a review is that `500m` comes back saying
*I can see a quantity here and I will not tell you what it is, because
`m` is minutes, milliseconds and millicores and I do not know which.*

### The refusal table

| Reason | Example | What is reported | Why |
|---|---|---|---|
| `ambiguous_unit` | `500m`, `10M`, `5k`, `1y`, `100Mb` | no base value | The symbol has more than one reading. `m` is minutes, milliseconds or millicores; `M` is mega- or minutes; `k`/`K`/`G`/`T`/`P` are prefixes with no unit after them; a calendar year has no fixed length; a lowercase `b` is bits by the standard and bytes in most software that writes it. Also `P1Y` and `P1M`, where the ISO month is one letter from `PT1M`, a minute. |
| `fractional_bytes` | `1.5KB`, `1.5KiB` | no base value | Correct arithmetic for SI, a category error for a byte count. **`1.5KiB` is exactly 1536 bytes and is still refused** — the refusal is about the category, not the arithmetic. `1.0KB` is a thousand bytes written oddly and is *not* refused. |
| `locale_separator` | `1,5s`, `1.000s`, `1.2.3s` | no base value | `1,5` is one and a half in one locale and fifteen hundred in another. `1.000` is one or a thousand. This tool does not infer a locale. Narrowed so it bites only the ambiguous shape: a comma anywhere, more than one point, or one-to-three digits not starting with `0` followed by exactly three — so `0.825s` and `2.5s` are read normally. |
| `compound_arithmetic` | `1h + 30m`, `30s*2`, `1h + 30` | no base value | An expression, not a quantity, and this tool does not evaluate one. **`1h30m` is a grammar and is accepted**; the whole expression is one finding, because reporting `1h` and `30m` separately is a true statement about the text and a false one about the value. **An operand with no unit still counts** — `30s*2` and `1h + 30` are the same failure in a shorter form — but *some* operand must carry one, so `2026-08-12` and `1-2` yield nothing at all. A leading sign is part of the number, not an operator: `-30s` is a negative quantity. |
| `si_iec_hazard` | `1MB`, `256KB` | **the SI base value, plus the reason** | The one entry that answers. `MB` is 10^6 by the standard, so that is what is reported; the hazard is that a great deal of software writes `MB` and means 2^20. Reporting nothing would be less useful than reporting the standard answer with the flag attached, and picking 2^20 would be the guess this tool exists not to make. It does **not** count as refused and does not trip `--strict`. |
| `out_of_range` | `99999999999999999999999999999999999PiB` | no base value | The base value does not fit in 128 bits. Refused rather than wrapped: a wrapped byte count is a confident wrong answer. `overflow-checks` is on in release as the backstop behind this check. |

**The ambiguous set, in full** — every symbol that is refused rather
than read, so the list is one a person can check against rather than a
rule they have to derive: `m` `M` `k` `K` `G` `T` `P` `y` `Y` `b` `kb`
`Kb` `mb` `Mb` `gb` `Gb` `tb` `Tb`. A unit test walks the grammar's own
table against this section, so a symbol cannot be accepted or refused
without appearing here.

**A bare number with no unit is not a finding at all.** `timeout: 30`
yields nothing. That is numbers-le's question, and the boundary is what
keeps the two tools distinct.

## Dimensions — exactly four

| Dimension | Base unit | Units read |
|---|---|---|
| `duration` | `milliseconds` | `ns` `us` `µs` `μs` `ms` `s` `sec` `secs` `min` `mins` `h` `hr` `hrs` `d` `day` `days` `w`; compounds (`1h30m`); ISO-8601 (`PT1H30M`, `P1DT2H`, `P2W`, `PT0.5S`) |
| `bytes` | `bytes` | `B`; SI `kB` `KB` `MB` `GB` `TB` `PB`; IEC `KiB` `MiB` `GiB` `TiB` `PiB`; Kubernetes `Ki` `Mi` `Gi` `Ti` `Pi` |
| `percent` | `ratio` | `%` — `15%` is `0.15` |
| `frequency` | `hertz` | `Hz` `kHz` `KHz` `MHz` `GHz` `THz` |

**Case is part of the symbol.** `MB` is a megabyte and `Mb` is a
megabit; folding them would silently multiply by eight, so `Mb` is a
refusal rather than a synonym.

**Physical units are a non-goal, not an omission.** Length, mass,
temperature, angle, force, currency: none of them are read, and none are
planned. See Non-goals.

## Exactness

Every base value is computed as an exact decimal — a sign, an integer
mantissa and a power-of-ten scale — never through an `f64`. `0.1s`
through a double is `100.00000000000001` milliseconds, which is not
wrong by enough to notice and not right by enough to compare, and
comparing is the whole reason a base value exists.

Every conversion is a checked integer multiplication. An overflow is
`out_of_range`, not a wrap.

`value` and `base` are both **strings** in every output, for the reason
numbers-le's values are: re-encoding through a JSON number hands the
reader whatever their parser prints, and a byte count past 2^53 comes
back as a different number.

## Shape

**One crate.** Self-contained: no published `-core`, no shared crate
with the family, and nothing holding this code equal to the similar
files in the sibling repos.

```
crate/
├── src/
│   ├── extract/    pure: the grammar, exact decimals, the six format
│   │               readers, the text scan, positions.
│   ├── walk.rs     ignore-aware tree walking
│   ├── scan.rs     one file end to end — the only path either surface calls
│   ├── cli.rs      the terminal surface
│   └── mcp/        the agent surface
└── fixtures/       the corpus, embedded and run by `cargo test`
```

**`extract/` touches no filesystem.**

## Extraction

### A quantity is a string value

The six formats — json, yaml, toml, ini, env, csv — plus a text scan for
everything else. numbers-le splits them into typed and untyped, because
there the same text is data in JSON and a number in `.env`. There is no
such split here: a unit is spelled out in characters, so `30s` is a
string in every one of these formats. The *typed* value is the one that
is never a quantity — `timeout = 30` is a number with no room for a
unit.

Keys are never read. A key named `timeout_30s` is a name, not a
measurement.

In a structured format the **whole value** is the candidate: `"30s"` is
a quantity and `"wait 30s then retry"` is prose that happens to be in a
config. The text scan is where prose is read.

### The text scan has a grammar

For a format nothing here parses — a Kubernetes manifest, a Terraform
file, a Markdown table of limits, a log — quantities come from scanning
the raw text. Unlike numbers-le's scan this one has a shape to look for,
so `v1.2.3` yields nothing rather than two numbers.

Two rules do the work: a run never begins inside a word (the character
before it is not a letter, a digit, `_`, `.` or `,`) and never ends
inside one. Without the first, `0x1d` reads as one day; without the
second, `5Mac` reads as five mega-somethings.

### The loosest edge: a run inside an opaque blob

**This is the known false-positive class, and it is measured rather than
imagined.** A quantity-shaped run inside content that is not text at all
— a UUID, a base64 hash, a git object name — still reads as a quantity.
`001d` in `f47ac10b-001d-4f2a` is one day. `2w` in
`sha512-…IBazS/2w==` is two weeks.

**Why the boundary rules cannot separate the cases.** A run may begin
where the character before it is not a letter, a digit, `_`, `.` or `,`,
and may end where the character after it is not a letter, a digit or
`_`. Everything else opens a run: `-`, `=`, `/`, `+`, `:`, a space, a
quote. That set is not incidental — it is exactly what lets `-30s` be a
negative duration, `ttl=30s` be a value, `500m` be a cell and
`holds 512MiB.` be prose. A UUID's `-` and a base64 hash's `/` and `=`
are the same characters. **A scan with no parser cannot tell one from
the other**, and narrowing the set would cost real findings to remove
false ones — so the class is reported and written down rather than
suppressed.

**The measurement.** `fixtures/documents/opaque.txt` is 280 lines of
exactly this content — lockfile integrity hashes, container image
digests, git object names, request and tenant UUIDs, content-addressed
asset names, signing material and base64url cursors — generated once
from a fixed seed and checked in. Nothing in it is a quantity, so every
row the scan reports from it is a false one:

> **5 false findings over 280 opaque tokens — 1.8%.**

`extract/fallback.rs` recomputes and prints that on every test run, and
fails both if it rises above 5% and if it reaches zero — the second
because a scan that stopped reporting this class would be a behaviour
change that belongs here and in the CHANGELOG rather than in a quietly
greener test.

For scale on a real tree: run over the `numbers-le` repository on
2026-08-12 it reported 36 quantities in total, four of them from
`bun.lock`.

Every one of these carries its line and column, which is what makes it a
row a reviewer discards rather than a number they trust.

### Key paths

Every format with a shape carries one: `cache.ttl`, `limits[0]`,
`server.timeout` (INI section and key), `TIMEOUT` (dotenv). A multi-
document YAML file indexes its documents, so a key in the second is
`[1].timeout`.

CSV has none — the row and column are already the position, and a
made-up `row2.col3` would be a second, worse spelling of the same fact.
The text scan has none.

### Positions

1-based line and column, the column in **UTF-16 code units** — the
number an editor shows.

A quantity is reported as the text that produced it, so the source is
found by searching for that text, forward-only down the document.
numbers-le has to search by *value*, because it prints `26` for `0x1A`.

Two consequences, both honest: a value the parser spelled differently
from its source (a JSON escape) reports no position rather than a wrong
one, and a run in a *key* can take the match — in `retry_30s: 30s` the
value finds the digits in the key.

## Output contract

**stdout is protocol, stderr is human.** One JSON report per line, one
line per file.

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
      "key": "memory",
      "line": 3,
      "column": 9
    },
    {
      "value": "500m",
      "dimension": null,
      "baseUnit": null,
      "base": null,
      "reason": "ambiguous_unit",
      "detail": "`m` is minutes in one config format, milliseconds in another and millicores in Kubernetes. Write `min`, `ms`, or spell out the core count.",
      "key": "cpu",
      "line": 4,
      "column": 6
    }
  ],
  "diagnostics": [],
  "summary": { "quantities": 2, "refused": 1 }
}
```

`summary.quantities` counts every row, refusals included — a refusal is
a quantity that was found. `summary.refused` counts the rows with no
base value; the `si_iec_hazard` row is not one of them.

There is no `unit` field. The unit is in `value`, where a reader can see
it; a field repeating it would be a second place for the two to
disagree. A refusal names the offending symbol in `detail`.

### Exit codes are the API

Following grep, as the rest of the family does:

- **0** — quantities found.
- **1** — none found. An answer, not an error.
- **2** — the question was malformed.

**A refusal does not change the exit code.** It is a finding, and a tree
full of ambiguous units is a real result. `--strict` is the opt-in for a
pipeline that wants every quantity resolved or the build stopped: it
exits 2 on any refusal, and on any text file that could not be read.

## The CLI surface

```
usage: units-le [options] <file|dir>...
       units-le [options] --stdin [--format <format>]
       units-le mcp
       units-le --version | --help

Options:
  --dimension <name>   report only duration, bytes, percent or frequency
  --format <format>    force a format instead of inferring it from the
                       file name; an unknown name falls back to the text
                       scan rather than failing
  --strict             exit 2 if any quantity was refused, or any text
                       file could not be read
  --stdin              read one document from stdin
  --hidden             walk hidden files and directories too
  --no-ignore          walk files that .gitignore excludes
```

There is no `--json` flag. One mode, nothing to misremember, and the
human summary is a projection of the same reports so the two cannot
drift.

**A format falls back and a dimension does not.** A format nobody
recognises still has an answer — scan the text. A dimension nobody
recognises has none, and quietly reporting all four would answer a
question that was not asked.

**A refusal that names no dimension survives every filter.** A bare
`500m` could be a duration or a byte count — that is why it was refused
— so dropping it under `--dimension bytes` would be this tool deciding
what it just said it could not decide.

## The MCP surface

`units-le mcp` speaks the Model Context Protocol on stdio. Both tools
return the same envelope — `{ ok, data, diagnostics, meta }` — where
`ok` means the check ran, never that the answer was yes.

- **`extract_units`** — content in, quantities out. Touches no
  filesystem. `fixtures/mcp-extract-units.json` pins its answers.
- **`units_le_scan`** — files or directories in, the same reports the
  CLI writes.

A refusal is a successful answer carrying a reason, not an `isError`.
Only a malformed question is an error.

## Non-goals

- **Physical units.** Length, mass, temperature, angle, force. This is a
  decision, not a gap: they belong to a different question — a
  measurement in an experiment, not a limit in a config — and reading
  them would mean taking on unit algebra (`m/s²`), which is what `uom`
  is for. The four dimensions here are the ones that appear in
  configuration.
- **Currency.** `$5.00` is a quantity and its base unit is a policy
  decision about rounding and exchange rates that no extractor should
  be making.
- **Bit units.** `100Mb` is refused rather than read, because the
  standard reading and the common reading differ by eight.
- **It does not convert.** There is no `--to seconds`. A base value is
  offered so a reader can compare; choosing a unit to present is
  presentation.
- **It does not judge.** No "this timeout is too low", no defaults
  database, no rewriting. Which limits are right is the reviewer's call.
- **It does not evaluate arithmetic.** `1h + 30m` is refused, not
  summed.
- **No network, ever.**

## Not in v1

- **Scientific notation in a quantity** (`1e3ms`). The number grammar is
  plain decimal.
- **Long-form unit words** (`30 seconds`, `2 hours`). A quantity is one
  token with no internal space, which is what keeps the text scan from
  reading "5 M" out of a sentence.
- **Source-language readers.** A quantity in code is written as a string
  and the text scan finds it; there is no `u32`-style hazard to protect
  against, because a unit follows its digits rather than preceding them.
- **A baseline file** for accepting known refusals.

## Files that cannot be read

Exit 2 means the *question* was malformed — an unknown flag, an
unrecognised dimension, a path that does not exist. It does not mean one
file in fifty thousand was a PNG.

**A binary file was never a text candidate.** A NUL byte in the first
8 KiB — ripgrep's own test — and the file is not read, produces **no
report line**, and never affects the exit code. It is counted on stderr
(`16 binary files skipped`) so a reader still knows coverage was
narrower than the tree; the MCP scan tool carries the same count as
`data.binaryFiles`.

**A file that looked like text and could not be read** — a permissions
error, or invalid UTF-8 with no NUL byte — is named on stderr, carried
in the report with a `skipped` diagnostic, and left out of the exit code
unless `--strict` is on. What is never allowed is the third option: a
*text* file that silently vanishes from the report, which reads to
whoever ran it as a file that was clean.

## The byte-order mark

A leading BOM is stripped before extraction. Three invisible bytes that
Notepad, Excel and a PowerShell redirect all add; they shift every
column on the first line, and in a structured format they can lose the
document entirely — which is indistinguishable from a file with no
quantities in it.

A BOM anywhere other than the start is a zero-width no-break space and
belongs to the text.
