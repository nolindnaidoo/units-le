# units-le-mcp

<p align="center">
  <a href="https://marketplace.visualstudio.com/items?itemName=nolindnaidoo.units-le">
    <img src="https://img.shields.io/badge/Install%20from-VS%20Code-blue?style=for-the-badge&logo=visualstudiocode" alt="Install from VS Code Marketplace" />
  </a>
  <a href="https://open-vsx.org/extension/nolindnaidoo/units-le">
    <img src="https://img.shields.io/open-vsx/dt/nolindnaidoo/units-le?style=for-the-badge&label=Open%20VSX&color=blue" alt="Open VSX downloads" />
  </a>
  <a href="https://www.npmjs.com/package/units-le-mcp">
    <img src="https://img.shields.io/npm/v/units-le-mcp?style=for-the-badge&label=MCP%20server&color=blue&logo=npm" alt="units-le-mcp on npm" />
  </a>
  <a href="https://letools.dev/tools/units-le">
    <img src="https://img.shields.io/badge/LE%20Tools-letools.dev-blue?style=for-the-badge" alt="LE Tools" />
  </a>
</p>

An [MCP](https://modelcontextprotocol.io) server that finds every quantity in
a document — a number welded to a unit — and returns it twice: as the document
wrote it, and in one base unit so two of them can be compared. Durations come
back in milliseconds, sizes in bytes, percentages as a ratio, frequencies in
hertz, each with its line, column and key path. It is the engine behind the
[Units-LE](https://letools.dev/tools/units-le) editor extension, exposed as a
tool an agent can call.

**A quantity it cannot read unambiguously comes back with a named reason,
never a guess.** A bare `500m` is minutes in one config format, milliseconds in
another and millicores in Kubernetes, so it is returned as `ambiguous_unit`
rather than as any of them. `1.5KB`, `1,5s` and `1h + 30m` are refused the same
way. `1MB` is returned as 10^6 bytes, with a flag saying the writer may have
meant 2^20. **A bare number with no unit is not a finding.**

No dependencies, no network calls, no filesystem access. Content goes in,
structured results come out.

## Use it

Point any MCP host at `npx units-le-mcp`.

**Claude Code**

```bash
claude mcp add units-le -- npx -y units-le-mcp
```

**Anything with a JSON config** — Cursor, Windsurf, Claude Desktop:

```json
{
  "mcpServers": {
    "units-le": {
      "command": "npx",
      "args": ["-y", "units-le-mcp"]
    }
  }
}
```

**VS Code** needs nothing here. Install the extension instead — it
carries this server and registers it for you:
[VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=nolindnaidoo.units-le)
· [Open VSX](https://open-vsx.org/extension/nolindnaidoo/units-le)

**No Node?** The same `extract_units` tool ships in a static Rust binary:
`cargo install units-le`, then `units-le mcp`
([crates.io](https://crates.io/crates/units-le)). The two servers answer
identically — one corpus runs against both, and a differential test feeds both
thousands of generated documents in every format, broken ones included, and
compares every answer, parser errors and all. The binary additionally offers
`units_le_scan`, which walks a tree; **this server reads no files**.

Prefer a global install to `npx` on every launch:

```bash
npm install -g units-le-mcp
```

No environment variables, no API key, no configuration of its own. To check it
before wiring it into anything:

```bash
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | npx -y units-le-mcp
```

If that prints the tool name, the server works.

## The tool

### `extract_units`

| argument | type | |
|---|---|---|
| `content` | string | **required.** The document text. |
| `format` | `json` `jsonc` `yaml` `csv` `tsv` `toml` `ini` `env` | Optional. Anything else, or nothing, scans the text directly. |
| `filename` | string | Used to infer the format when `format` is absent, e.g. `config.toml`. |
| `dimension` | `duration` `bytes` `percent` `frequency` | Report only one. A refusal that names no dimension is always kept. |
| `maxResults` | number | Default `500`, from 1 to `5000`. |

Refusals are `ambiguous_unit`, `fractional_bytes`, `locale_separator`,
`compound_arithmetic` and `out_of_range`, each with a sentence a person can
act on; `si_iec_hazard` accompanies a value rather than replacing it. A
structured document that does not parse is a diagnostic in its parser's own
words, and `ok` is `false` while one is present:

```json
{
  "ok": true,
  "data": {
    "quantities": [
      {
        "value": "1h30m",
        "dimension": "duration",
        "baseUnit": "milliseconds",
        "base": "5400000",
        "key": "cache.ttl",
        "line": 2,
        "column": 8
      },
      {
        "value": "500m",
        "dimension": null,
        "baseUnit": null,
        "base": null,
        "reason": "ambiguous_unit",
        "detail": "`m` is minutes in one config format, milliseconds in another and millicores in Kubernetes. Write `min`, `ms`, or spell out the core count.",
        "key": "cpu",
        "line": 3,
        "column": 6
      }
    ],
    "fileType": "yaml",
    "refused": 1
  },
  "diagnostics": [],
  "meta": {
    "tool": "extract_units",
    "count": 2,
    "truncated": false
  }
}
```

## Also in the MCP registry

`io.github.nolindnaidoo/units-le` —
[registry.modelcontextprotocol.io](https://registry.modelcontextprotocol.io)

## Fifteen more like it

One tool each, same shape: content in, structured data out, no network and no
filesystem. Every one is on npm as `<name>-mcp` and in the MCP registry as
`io.github.nolindnaidoo/<name>`.

| Package | Tool | Does |
|---|---|---|
| [`urls-le-mcp`](https://www.npmjs.com/package/urls-le-mcp) | `extract_urls` | URLs, with protocol and position |
| [`colors-le-mcp`](https://www.npmjs.com/package/colors-le-mcp) | `extract_colors` | colors from stylesheets and code |
| [`dates-le-mcp`](https://www.npmjs.com/package/dates-le-mcp) | `extract_dates` | dates and timestamps |
| [`numbers-le-mcp`](https://www.npmjs.com/package/numbers-le-mcp) | `extract_numbers` | numeric values |
| [`paths-le-mcp`](https://www.npmjs.com/package/paths-le-mcp) | `extract_paths` | file and directory paths |
| [`string-le-mcp`](https://www.npmjs.com/package/string-le-mcp) | `extract_strings` | string values |
| [`regex-le-mcp`](https://www.npmjs.com/package/regex-le-mcp) | `extract_patterns` | regexes, with a ReDoS verdict |
| [`secrets-le-mcp`](https://www.npmjs.com/package/secrets-le-mcp) | `detect_secrets` | credentials, masked — never the value |
| [`envsync-le-mcp`](https://www.npmjs.com/package/envsync-le-mcp) | `compare_env_files` | dotenv key drift, names only |
| [`scrape-le-mcp`](https://www.npmjs.com/package/scrape-le-mcp) | `analyze_robots_txt` | whether a path may be crawled |
| [`unicode-le-mcp`](https://www.npmjs.com/package/unicode-le-mcp) | `detect_unicode_risks` | Unicode that hides meaning, as codepoints |
| [`i18n-le-mcp`](https://www.npmjs.com/package/i18n-le-mcp) | `check_catalogues` | translation catalogues, keys only |
| [`ids-le-mcp`](https://www.npmjs.com/package/ids-le-mcp) | `extract_ids` | UUIDs, ULIDs and Snowflakes, with the time inside |
| [`ips-le-mcp`](https://www.npmjs.com/package/ips-le-mcp) | `extract_ips` | IP addresses, CIDR blocks and MACs, normalized |
| [`versions-le-mcp`](https://www.npmjs.com/package/versions-le-mcp) | `compare_versions` | dependency constraints that disagree across manifests |

Every tool in the family, one page: **[letools.dev](https://letools.dev)**

## Built by

**[Nolin Naidoo](https://nolindnaidoo.com)** — Chief Engineer, AI/ML & Platform
Architecture. [nolindnaidoo.com](https://nolindnaidoo.com) ·
[GitHub](https://github.com/nolindnaidoo) ·
[LinkedIn](https://www.linkedin.com/in/nolindnaidoo/)

### Also from the same workshop

Twelve Rust tools built the same way: small, single-purpose, and driven by a
machine rather than a person. pixelcoords and pixelactions make up one loop —
pixelcoords answers *where*, pixelactions *acts* there. The ten LE crates are
the terminal half of the extensions they sit in: the same detection, held to
the extension's own corpus, and an exit code instead of a results editor.

| | | |
|---|---|---|
| **[pixelcoords](https://github.com/nolindnaidoo/pixelcoords)** | Freeze your screen, mark regions, get pixel-exact coordinates and crops | [site](https://pixelcoords.dev) · [crates.io](https://crates.io/crates/pixelcoords) · [docs.rs](https://docs.rs/pixelcoords) |
| **[pixelactions](https://github.com/nolindnaidoo/pixelactions)** | Consume human-verified coordinates, perform the interaction, confirm it landed | [site](https://pixelactions.dev) · [crates.io](https://crates.io/crates/pixelactions) · [docs.rs](https://docs.rs/pixelactions) |
| **[paths-le](https://github.com/nolindnaidoo/paths-le/tree/main/crate)** | Find every path in a codebase and report whether it still points at anything | [crates.io](https://crates.io/crates/paths-le) |
| **[secrets-le](https://github.com/nolindnaidoo/secrets-le/tree/main/crate)** | Find hardcoded credentials, and never print one | [crates.io](https://crates.io/crates/secrets-le) |
| **[urls-le](https://github.com/nolindnaidoo/urls-le/tree/main/crate)** | Extract every URL from a codebase, with its protocol and exact position | [crates.io](https://crates.io/crates/urls-le) |
| **[regex-le](https://github.com/nolindnaidoo/regex-le/tree/main/crate)** | Find every regex in a codebase and report which can be driven into catastrophic backtracking | [crates.io](https://crates.io/crates/regex-le) |
| **[string-le](https://github.com/nolindnaidoo/string-le/tree/main/crate)** | Get every string in a codebase out where a person can read them | [crates.io](https://crates.io/crates/string-le) |
| **[numbers-le](https://github.com/nolindnaidoo/numbers-le/tree/main/crate)** | Find every hardcoded number in a codebase so a person can check them | [crates.io](https://crates.io/crates/numbers-le) |
| **[envsync-le](https://github.com/nolindnaidoo/envsync-le/tree/main/crate)** | Compare the dotenv files in a tree and say which keys are missing from which | [crates.io](https://crates.io/crates/envsync-le) |
| **[colors-le](https://github.com/nolindnaidoo/colors-le/tree/main/crate)** | Find every colour in a codebase, and say which are not in your palette | [crates.io](https://crates.io/crates/colors-le) |
| **[dates-le](https://github.com/nolindnaidoo/dates-le/tree/main/crate)** | Extract every date and timestamp, and the exact instant each one resolves to | [crates.io](https://crates.io/crates/dates-le) |
| **[scrape-le](https://github.com/nolindnaidoo/scrape-le/tree/main/crate)** | Check whether a page is scrapeable before the scraper is written | [crates.io](https://crates.io/crates/scrape-le) |

## Licence

MIT © [Nolin Naidoo](https://nolindnaidoo.com)
