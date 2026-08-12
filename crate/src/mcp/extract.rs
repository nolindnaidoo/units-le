//! `extract_units` — content in, quantities out.
//!
//! It touches no filesystem. An agent already has file-read tools;
//! duplicating them here would add a path-traversal surface for no
//! capability. The tool that needs a filesystem is `units_le_scan`.
//!
//! Unlike numbers-le's shared tool this carries positions and key
//! paths, because there is no second implementation to stay
//! byte-identical with — and an agent that has been handed
//! `cache.ttl` does not have to go looking for it.

use serde_json::{Value, json};

use crate::extract::{self, Options, SUPPORTED_FORMATS, resolve_format};

const DEFAULT_MAX_RESULTS: usize = 500;
const MAX_MAX_RESULTS: usize = 5000;

pub(crate) fn definition() -> Value {
    json!({
        "name": "extract_units",
        "description": "Extract every quantity — a number with a unit — from a document, with \
                        the text as written and its value in one base unit: durations in \
                        milliseconds, sizes in bytes, percentages as a ratio, frequencies in \
                        hertz. Parses JSON, YAML, CSV, TOML, INI and dotenv; anything else is \
                        scanned as text, so a format is optional. A quantity it cannot resolve \
                        — a bare `m`, a fractional `1.5KB`, a locale-shaped `1,5s`, an \
                        expression like `1h + 30m`, an SI byte multiple that may have meant the \
                        binary one — is returned with a named reason instead of a guess. A bare \
                        number with no unit is not a finding.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "content": { "type": "string", "description": "The document text to scan." },
                "format": {
                    "type": "string",
                    "enum": SUPPORTED_FORMATS,
                    "description": "Document format. Optional — an unrecognised or absent \
                                    format scans the text directly.",
                },
                "filename": {
                    "type": "string",
                    "description": "Filename used to infer the format when `format` is absent, \
                                    e.g. \"config.toml\".",
                },
                "dimension": {
                    "type": "string",
                    "enum": super::DIMENSIONS,
                    "description": "Report only one dimension. A refusal that names no \
                                    dimension is always kept, because it could have been the \
                                    one asked for.",
                },
                "maxResults": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": MAX_MAX_RESULTS,
                    "default": DEFAULT_MAX_RESULTS,
                    "description": format!(
                        "Cap on returned quantities (default {DEFAULT_MAX_RESULTS}). \
                         meta.truncated reports whether any were dropped."
                    ),
                },
            },
            "required": ["content"],
            "additionalProperties": false,
        },
    })
}

pub(crate) fn run(arguments: &Value) -> Result<Value, String> {
    let content = arguments
        .get("content")
        .and_then(Value::as_str)
        .ok_or_else(|| "content is required and must be a string".to_string())?;
    let max_results = read_max_results(arguments)?;
    let dimension = super::requested_dimension(arguments)?;

    // Never a refusal. An agent that knows nothing about a document
    // still gets its quantities, which is why a format is optional here.
    let format = resolve_format(
        arguments.get("format").and_then(Value::as_str),
        arguments.get("filename").and_then(Value::as_str),
    );

    let diagnostics: Vec<Value> = extract::parse_error(content, format)
        .map(|message| json!({ "severity": "error", "code": "parse-error", "message": message }))
        .into_iter()
        .collect();

    let found = extract::extract(content, format, Options { dimension });
    let refused = found
        .iter()
        .filter(|found| found.quantity.is_refused())
        .count();
    // A quantity is plain data — strings, integers and unit-variant
    // enums, every map keyed by a string and no float anywhere — so
    // there is no input on which `to_value` can fail.
    let mut quantities: Vec<Value> = found
        .into_iter()
        .map(|found| serde_json::to_value(found).expect("a quantity serializes"))
        .collect();

    // The `truncated` flag matters more than the cap: a silently
    // incomplete answer is wrong in the most expensive way, and this is
    // a tool whose whole job is completeness.
    let truncated = quantities.len() > max_results;
    quantities.truncate(max_results);

    let count = quantities.len();
    Ok(super::envelope(
        "extract_units",
        &json!({ "quantities": quantities, "fileType": format, "refused": refused }),
        count,
        &diagnostics,
        truncated,
    ))
}

/// Reject loudly. Nothing is clamped.
///
/// The schema declares `minimum` and `maximum`, so a value outside them
/// is a malformed question rather than an ambitious one — and a cap
/// silently lowered to 5000 returns 5000 rows with `truncated: true` to
/// a caller who asked for everything and has no way to know the number
/// it asked with was ignored. Strict parsing, no silent defaults, the
/// same rule the command line's flags are held to.
fn read_max_results(arguments: &Value) -> Result<usize, String> {
    let refusal = || format!("maxResults must be a whole number between 1 and {MAX_MAX_RESULTS}");

    let Some(raw) = arguments.get("maxResults") else {
        return Ok(DEFAULT_MAX_RESULTS);
    };
    // `as_u64` refuses a string, a fraction and a negative in one test.
    let value = raw.as_u64().ok_or_else(refusal)?;
    let value = usize::try_from(value).map_err(|_| refusal())?;
    if !(1..=MAX_MAX_RESULTS).contains(&value) {
        return Err(refusal());
    }
    Ok(value)
}

#[cfg(test)]
mod tests {
    use serde::Deserialize;

    use super::*;
    use crate::extract::FALLBACK_FORMAT;
    use crate::extract::corpus::document;

    const CASES: &str = include_str!("../../fixtures/mcp-extract-units.json");

    #[derive(Debug, Deserialize)]
    struct Case {
        name: String,
        file: Option<String>,
        content: Option<String>,
        arguments: Value,
        expected: Option<Value>,
        #[serde(rename = "expectedError")]
        expected_error: Option<String>,
    }

    /// The corpus, run against the tool exactly as a caller reaches it.
    #[test]
    fn every_pinned_case_answers_identically() {
        let cases: Vec<Case> = serde_json::from_str(CASES).expect("the corpus is valid JSON");
        assert!(!cases.is_empty(), "the corpus is empty");

        for case in cases {
            let mut arguments = case.arguments.clone();
            let content = case
                .file
                .as_deref()
                .map(document)
                .map(str::to_string)
                .or(case.content);
            if let Some(content) = content {
                arguments["content"] = json!(content);
            }

            match (case.expected, case.expected_error) {
                (_, Some(expected)) => {
                    assert_eq!(
                        run(&arguments).expect_err(&case.name),
                        expected,
                        "{}",
                        case.name
                    );
                }
                (Some(expected), None) => {
                    assert_eq!(
                        run(&arguments).expect(&case.name),
                        expected,
                        "{}",
                        case.name
                    );
                }
                (None, None) => panic!("{} pins neither a result nor an error", case.name),
            }
        }
    }

    #[test]
    fn the_tool_name_is_pinned() {
        assert_eq!(definition()["name"], "extract_units");
    }

    #[test]
    fn the_advertised_enum_matches_the_formats_that_resolve() {
        let definition = definition();
        let advertised: Vec<String> = definition["inputSchema"]["properties"]["format"]["enum"]
            .as_array()
            .expect("an enum")
            .iter()
            .filter_map(|value| value.as_str().map(str::to_string))
            .collect();
        assert_eq!(advertised, SUPPORTED_FORMATS);
    }

    /// Both halves of the contract in one assertion: the text as
    /// written, and the value to compare it with.
    #[test]
    fn a_quantity_carries_its_text_and_its_base() {
        let result =
            run(&json!({ "content": "size: 512MiB", "format": "yaml" })).expect("a result");
        let found = &result["data"]["quantities"][0];
        assert_eq!(found["value"], "512MiB");
        assert_eq!(found["base"], "536870912");
        assert_eq!(found["dimension"], "bytes");
        assert_eq!(found["key"], "size");
        assert_eq!(found["line"], 1);
    }

    /// Both are strings. A base re-encoded through a JSON number would
    /// arrive as whatever the caller's parser prints, which for a byte
    /// count past 2^53 is a different number.
    #[test]
    fn the_text_and_the_base_are_both_strings() {
        let result = run(&json!({ "content": "size: 8PiB", "format": "yaml" })).expect("a result");
        let found = &result["data"]["quantities"][0];
        assert!(found["value"].is_string());
        assert!(found["base"].is_string());
        assert_eq!(found["base"], "9007199254740992");
    }

    #[test]
    fn a_refusal_is_a_successful_answer_with_a_reason() {
        let result = run(&json!({ "content": "cpu: 500m", "format": "yaml" })).expect("a result");
        assert_eq!(result["ok"], true);
        assert_eq!(result["data"]["refused"], 1);
        let found = &result["data"]["quantities"][0];
        assert_eq!(found["reason"], "ambiguous_unit");
        assert!(found["base"].is_null());
        assert!(found["detail"].is_string(), "a reason a person can act on");
    }

    #[test]
    fn an_unknown_format_falls_back_rather_than_failing() {
        let result =
            run(&json!({ "content": "waits 30s", "format": "nonsense" })).expect("a result");
        assert_eq!(result["data"]["fileType"], FALLBACK_FORMAT);
        assert_eq!(result["data"]["quantities"][0]["value"], "30s");
    }

    #[test]
    fn a_dimension_filter_narrows_the_answer() {
        let result = run(&json!({
            "content": "a: 30s\nb: 1MiB",
            "format": "yaml",
            "dimension": "bytes",
        }))
        .expect("a result");
        assert_eq!(result["meta"]["count"], 1);
        assert_eq!(result["data"]["quantities"][0]["value"], "1MiB");
    }

    #[test]
    fn a_broken_document_is_an_unsuccessful_envelope() {
        let result = run(&json!({ "content": "{not json", "format": "json" })).expect("a result");
        assert_eq!(result["ok"], false);
        assert_eq!(result["diagnostics"][0]["code"], "parse-error");
        assert_eq!(result["data"]["quantities"], json!([]));
    }

    #[test]
    fn a_fractional_cap_is_refused() {
        let error = run(&json!({ "content": "x", "maxResults": 1.5 })).expect_err("a refusal");
        assert_eq!(
            error,
            "maxResults must be a whole number between 1 and 5000"
        );
    }

    /// **A cap outside the declared range is refused, not clamped.** A
    /// silently lowered cap answers 5000 rows to a caller who asked for
    /// more and cannot tell that its number was ignored — a truncated
    /// answer believed to be whole, which is the failure this crate is
    /// against everywhere else.
    #[test]
    fn a_cap_outside_the_schema_is_refused_rather_than_clamped() {
        for cap in [0, MAX_MAX_RESULTS + 1, 999_999] {
            let error = run(&json!({ "content": "a: 1h", "maxResults": cap }))
                .expect_err(&format!("{cap} was accepted"));
            assert!(error.contains("between 1 and 5000"), "{error}");
        }
        assert!(run(&json!({ "content": "a: 1h", "maxResults": MAX_MAX_RESULTS })).is_ok());
    }

    /// No refusal on this surface may name a flag: an MCP caller has no
    /// command line to type one on.
    #[test]
    fn the_cap_refusal_speaks_no_command_line() {
        let error = run(&json!({ "content": "x", "maxResults": 999_999 })).expect_err("a refusal");
        assert!(!error.contains("--"), "{error}");
    }

    #[test]
    fn a_cap_reports_that_it_dropped_something() {
        let result = run(&json!({ "content": "a: 1h\nb: 2h", "format": "yaml", "maxResults": 1 }))
            .expect("a result");
        assert_eq!(result["meta"]["truncated"], true);
        assert_eq!(result["meta"]["count"], 1);
    }
}
