# The VS Code extension: plan

**Status: built** (2026-10-04) on option O1: all five parsers transcribed,
held to the crate by the corpus, the differential and a per-reader case table
read back from the crates. AGENTS.md is the record of how it is built.

## Why this one is different

The other crate-only tools got extensions built like the family's: a
TypeScript port of the crate's engine, held to it by the shared corpus and
by a differential that sends generated documents to both MCP servers and
requires identical answers.

`extract_units` puts five Rust parsers into its answer. A document that does
not parse reports that parser's error text verbatim (`parse_error` in
`crate/src/extract/mod.rs`), and which documents yield quantities at all is
that parser's acceptance. An identical npm server has to reproduce all five:

| Reader | Crate | Note |
|---|---|---|
| JSON / JSONC | jsonc-parser 0.33 | already transcribed in ips-le (`src/extract/jsonc.ts`) |
| YAML | saphyr 0.1 + saphyr-parser 0.1 | scalar typing decides what is a string |
| TOML | toml 1.1 + toml_parser 1.1 | errors render as multi-line snippets |
| INI | rust-ini 0.21 | `enabled_escape: false`, after `without_bare_keys` |
| CSV / TSV | csv 1.4 + csv-core 0.1 | `flexible`, no headers |

The relevant paths are roughly 4,000–6,000 lines of TypeScript, mostly YAML
and TOML.

## Options

- **O1 — transcribe all five** (recommended when this resumes). Same
  architecture as the siblings; the differential holds both servers equal on
  malformed input too. The largest of the five builds.
- **O2 — npm parsers, relaxed contract.** `yaml`, `smol-toml` and friends,
  with the differential limited to well-formed documents and blind to error
  text. Breaks the rule that any difference between the servers is a bug.
- **O3 — compile the crate's engine to WebAssembly** for the extension and the
  npm package. Identical by construction; the one extension not built like the
  others.
- **O4 — change the crate first** so the shared tool reports a fixed parse
  message and position instead of the library's text. Removes error wording
  from the contract; YAML and TOML acceptance still need exact ports. A crate
  behaviour change and a new crates.io release, which is its own
  authorization.
