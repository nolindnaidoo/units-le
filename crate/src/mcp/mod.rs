//! The agent surface: the same extraction over the Model Context
//! Protocol on stdio, so a model can ask what a config actually
//! specifies rather than being handed the file and multiplying by 1024
//! itself.
//!
//! Two rules the family's MCP surfaces established:
//!
//! - **An empty answer is not an error.** A document with no quantities
//!   comes back as an ordinary result carrying `ok: true` — the scan
//!   ran. Only a malformed question is a protocol error.
//! - **Refusals speak the caller's vocabulary.** An MCP caller has no
//!   command line, so no message here mentions a flag.
//!
//! Read-only by construction: nothing on this surface writes.

pub(crate) mod extract;

use std::io::{BufRead, Write};
use std::path::PathBuf;
use std::process::ExitCode;

use serde_json::{Value, json};

use crate::extract::{Dimension, Options, resolve_format};
use crate::scan::{self, ScanOptions};
use crate::walk::{self, WalkOptions};

const PROTOCOL_VERSION: &str = "2025-06-18";

/// JSON-RPC error codes, from the spec.
const INVALID_PARAMS: i64 = -32602;
const METHOD_NOT_FOUND: i64 = -32601;

pub(crate) fn serve() -> ExitCode {
    let stdin = std::io::stdin();
    let mut stdout = std::io::stdout();
    for line in stdin.lock().lines() {
        let Ok(line) = line else {
            return ExitCode::from(2);
        };
        if line.trim().is_empty() {
            continue;
        }
        let Ok(request) = serde_json::from_str::<Value>(&line) else {
            // A frame that is not JSON has no id to answer against;
            // dropping it is the only honest option.
            continue;
        };
        let Some(response) = handle(&request) else {
            continue; // a notification: no reply
        };
        if writeln!(stdout, "{response}").is_err() || stdout.flush().is_err() {
            return ExitCode::from(2);
        }
    }
    ExitCode::SUCCESS
}

fn handle(request: &Value) -> Option<Value> {
    let id = request.get("id").cloned();
    let method = request.get("method")?.as_str()?;
    // Notifications carry no id and get no reply.
    id.as_ref()?;

    let result = match method {
        "initialize" => Ok(json!({
            "protocolVersion": PROTOCOL_VERSION,
            "capabilities": { "tools": {} },
            "serverInfo": { "name": "units-le", "version": env!("CARGO_PKG_VERSION") },
        })),
        "tools/list" => Ok(json!({ "tools": tool_definitions() })),
        "tools/call" => call_tool(request.get("params")),
        "ping" => Ok(json!({})),
        other => Err((
            METHOD_NOT_FOUND,
            format!("this server does not implement {other}"),
        )),
    };

    Some(match result {
        Ok(result) => json!({ "jsonrpc": "2.0", "id": id, "result": result }),
        Err((code, message)) => json!({
            "jsonrpc": "2.0",
            "id": id,
            "error": { "code": code, "message": message },
        }),
    })
}

fn tool_definitions() -> Value {
    json!([
        extract::definition(),
        {
            "name": "units_le_scan",
            "description": "Extract every quantity from files or directories, with the file it \
                            came from, its key path, and where it can be located its line and \
                            column. Reads the filesystem; never writes to it, and never resolves \
                            a quantity it could not read.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "a file or directory to read" },
                    "paths": {
                        "type": "array",
                        "items": { "type": "string" },
                        "description": "several files or directories, instead of `path`",
                    },
                    "format": {
                        "type": "string",
                        "description": "Force a format for every file instead of inferring one \
                                        per file name. An unrecognised name falls back to a \
                                        text scan.",
                    },
                    "dimension": {
                        "type": "string",
                        "enum": DIMENSIONS,
                        "description": "Report only one dimension. A refusal that names no \
                                        dimension is always kept, because it could have been \
                                        the one asked for.",
                    },
                    "hidden": {
                        "type": "boolean",
                        "default": false,
                        "description": "Walk hidden files and directories too.",
                    },
                    "ignored": {
                        "type": "boolean",
                        "default": false,
                        "description": "Walk files excluded by .gitignore too.",
                    },
                },
            },
        },
    ])
}

/// The dimension names both tools offer, taken from the enum so the
/// schema cannot advertise one the filter does not know.
pub(crate) const DIMENSIONS: [&str; 4] = [
    Dimension::Duration.name(),
    Dimension::Bytes.name(),
    Dimension::Percent.name(),
    Dimension::Frequency.name(),
];

/// Protocol failures (no tool named, an unknown tool) are JSON-RPC
/// errors; a tool that fails on its arguments returns a result carrying
/// `isError`, so a model reads the reason and reacts rather than
/// concluding the server is broken.
fn call_tool(params: Option<&Value>) -> Result<Value, (i64, String)> {
    let params = params.ok_or((INVALID_PARAMS, "no tool call was supplied".to_string()))?;
    let name = params
        .get("name")
        .and_then(Value::as_str)
        .ok_or((INVALID_PARAMS, "the tool call named no tool".to_string()))?;
    let arguments = params
        .get("arguments")
        .cloned()
        .unwrap_or_else(|| json!({}));

    match name {
        "extract_units" => Ok(match extract::run(&arguments) {
            Ok(result) => tool_result(&result),
            Err(message) => tool_failure(&message),
        }),
        "units_le_scan" => Ok(match scan_tool(&arguments) {
            Ok(result) => tool_result(&result),
            Err(message) => tool_failure(&message),
        }),
        other => Err((
            INVALID_PARAMS,
            format!("this server offers no tool named {other}"),
        )),
    }
}

fn scan_tool(arguments: &Value) -> Result<Value, String> {
    let inputs = requested_paths(arguments)?;
    let flag = |name: &str| {
        arguments
            .get(name)
            .and_then(Value::as_bool)
            .unwrap_or(false)
    };
    let walk_options = WalkOptions {
        hidden: flag("hidden"),
        respect_ignore: !flag("ignored"),
    };
    let options = ScanOptions {
        extract: Options {
            dimension: requested_dimension(arguments)?,
        },
        format: arguments
            .get("format")
            .and_then(Value::as_str)
            .map(|name| resolve_format(Some(name), None)),
    };

    let targets = walk::collect(&inputs, &walk_options)?;
    let scanned = targets
        .iter()
        .map(|target| scan::scan_file(target, options))
        .collect();
    // A binary file was never a text candidate, so it gets no report —
    // but the count is carried, because an agent reading `reports` as
    // the whole tree would otherwise be wrong about coverage.
    let (read, binary) = scan::partition(scanned);
    // Summed off the typed reports rather than read back out of the
    // JSON. A lookup by field name answers `None` for a field that was
    // renamed, and a total that silently fell to zero is exactly the
    // shape of a clean audit that never ran.
    let quantities: usize = read.iter().map(|report| report.summary.quantities).sum();
    let refused: usize = read.iter().map(|report| report.summary.refused).sum();
    // A report is plain data — strings, integers and unit-variant enums,
    // every map keyed by a string and no float anywhere — so there is no
    // input on which `to_value` can fail.
    let reports: Vec<Value> = read
        .iter()
        .map(|report| serde_json::to_value(report).expect("a report serializes"))
        .collect();

    let mut diagnostics: Vec<Value> = read
        .iter()
        .filter(|report| report.was_skipped())
        .map(|report| {
            warning(
                "unreadable",
                &format!(
                    "{} could not be read, so this scan does not cover it",
                    report.file
                ),
            )
        })
        .collect();
    if refused > 0 {
        // An agent treating these as resolved values needs to know how
        // many of them are not.
        diagnostics.push(warning(
            "refused",
            &format!(
                "{refused} quantities were reported without a base value; each carries the \
                 reason it could not be resolved"
            ),
        ));
    }

    Ok(envelope(
        "units_le_scan",
        &json!({
            "reports": reports,
            "quantities": quantities,
            "refused": refused,
            "binaryFiles": binary,
        }),
        // The findings, not the files. `meta.count` means one thing
        // across both tools, and the file count is `reports.len()`.
        quantities,
        &diagnostics,
        false,
    ))
}

/// The dimension filter, shared by both tools. An unrecognised name is
/// a refusal rather than a silent "all four", for the same reason the
/// command line refuses one: there is nothing to fall back to.
pub(crate) fn requested_dimension(arguments: &Value) -> Result<Option<Dimension>, String> {
    let Some(name) = arguments.get("dimension") else {
        return Ok(None);
    };
    let name = name
        .as_str()
        .ok_or_else(|| "dimension must be a string".to_string())?;
    Dimension::named(&name.to_lowercase())
        .map(Some)
        .ok_or_else(|| {
            format!(
                "{name} is not a dimension. It is one of {}.",
                DIMENSIONS.join(", ")
            )
        })
}

fn requested_paths(arguments: &Value) -> Result<Vec<PathBuf>, String> {
    if let Some(path) = arguments.get("path").and_then(Value::as_str) {
        return Ok(vec![PathBuf::from(path)]);
    }
    if let Some(items) = arguments.get("paths").and_then(Value::as_array) {
        let paths: Vec<PathBuf> = items
            .iter()
            .filter_map(|item| item.as_str().map(PathBuf::from))
            .collect();
        if paths.is_empty() {
            return Err("the list of paths was empty".to_string());
        }
        return Ok(paths);
    }
    Err("no file or directory was supplied to read".to_string())
}

/// The one result shape every tool returns: `{ ok, data, diagnostics,
/// meta }`.
///
/// **`ok` reports whether the check ran, not whether the answer is
/// yes.** A file full of ambiguous units is the answer, not a failure
/// to produce one — conflating the two would have a model report a
/// broken tool when what it actually learned is that the config is
/// ambiguous.
///
/// **`count` is the number of quantities the answer carries**, in every
/// tool. One envelope is worth having only if one reader can read it,
/// and a field that counted findings in one tool and files in another
/// gave that reader a smaller number that looked entirely plausible.
/// The file count is `data.reports.len()`, where a tool has files.
pub(crate) fn envelope(
    tool: &str,
    data: &Value,
    count: usize,
    diagnostics: &[Value],
    truncated: bool,
) -> Value {
    let ok = !diagnostics
        .iter()
        .any(|diagnostic| diagnostic["severity"].as_str() == Some("error"));
    json!({
        "ok": ok,
        "data": data,
        "diagnostics": diagnostics,
        "meta": { "tool": tool, "count": count, "truncated": truncated },
    })
}

/// An MCP tool result: the envelope as text (what a model reads) and
/// the same envelope structured.
fn tool_result(envelope: &Value) -> Value {
    // A `Value` is already valid JSON: rendering one can only fail on a
    // non-finite float, and `serde_json::Number` cannot hold one.
    let text = serde_json::to_string_pretty(envelope).expect("an envelope serializes");
    json!({
        "content": [{ "type": "text", "text": text }],
        "structuredContent": envelope,
        "isError": false,
    })
}

fn warning(code: &str, message: &str) -> Value {
    json!({ "severity": "warning", "code": code, "message": message })
}

/// The tool could not run on the arguments given. `isError` so a model
/// reads the message and corrects itself.
fn tool_failure(message: &str) -> Value {
    json!({
        "content": [{ "type": "text", "text": message }],
        "isError": true,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::TempTree;

    fn request(method: &str, params: &Value) -> Value {
        json!({ "jsonrpc": "2.0", "id": 1, "method": method, "params": params })
    }

    fn call(name: &str, arguments: &Value) -> Value {
        handle(&request(
            "tools/call",
            &json!({ "name": name, "arguments": arguments }),
        ))
        .expect("a reply")
    }

    #[test]
    fn initialize_answers_with_the_protocol_version() {
        let response = handle(&request("initialize", &json!({}))).expect("a reply");
        assert_eq!(response["result"]["protocolVersion"], PROTOCOL_VERSION);
        assert_eq!(response["result"]["serverInfo"]["name"], "units-le");
    }

    #[test]
    fn tools_list_offers_both_tools() {
        let response = handle(&request("tools/list", &json!({}))).expect("a reply");
        let tools = response["result"]["tools"].as_array().expect("tools");
        let names: Vec<&str> = tools.iter().filter_map(|t| t["name"].as_str()).collect();
        assert_eq!(names, ["extract_units", "units_le_scan"]);
    }

    #[test]
    fn a_notification_gets_no_reply() {
        let notification = json!({ "jsonrpc": "2.0", "method": "initialized" });
        assert!(handle(&notification).is_none());
    }

    #[test]
    fn an_unknown_method_is_a_protocol_error() {
        let response = handle(&request("does/not/exist", &json!({}))).expect("a reply");
        assert_eq!(response["error"]["code"], METHOD_NOT_FOUND);
    }

    #[test]
    fn an_unknown_tool_is_a_protocol_error() {
        let response = call("units_le_convert", &json!({}));
        assert_eq!(response["error"]["code"], INVALID_PARAMS);
    }

    /// A bad argument is the tool failing on what it was given, not the
    /// server breaking — so it comes back as a result carrying isError.
    #[test]
    fn a_missing_argument_is_a_tool_failure_not_a_protocol_error() {
        let response = call("units_le_scan", &json!({}));
        assert!(response.get("error").is_none(), "{response}");
        assert_eq!(response["result"]["isError"], true);
        assert!(
            response["result"]["content"][0]["text"]
                .as_str()
                .expect("a message")
                .contains("no file or directory")
        );
    }

    #[test]
    fn the_content_tool_answers_with_a_quantity_and_its_base() {
        let response = call(
            "extract_units",
            &json!({ "content": "ttl: 30s", "format": "yaml" }),
        );
        let envelope = &response["result"]["structuredContent"];
        assert_eq!(envelope["meta"]["tool"], "extract_units");
        assert_eq!(envelope["data"]["quantities"][0]["value"], "30s");
        assert_eq!(envelope["data"]["quantities"][0]["base"], "30000");
        assert_eq!(
            envelope["data"]["quantities"][0]["baseUnit"],
            "milliseconds"
        );
        assert_eq!(envelope["ok"], true);
        assert_eq!(response["result"]["isError"], false);
    }

    /// The content tool reaches no filesystem — the property that lets
    /// an agent call it anywhere, and it must not regress.
    #[test]
    fn the_content_tool_needs_no_filesystem() {
        let response = call("extract_units", &json!({ "content": "waits 30s" }));
        let envelope = &response["result"]["structuredContent"];
        assert_eq!(envelope["data"]["quantities"][0]["value"], "30s");
        assert!(envelope["data"].get("exists").is_none());
    }

    /// An empty answer is the scan running and finding nothing.
    #[test]
    fn a_document_with_no_quantities_is_an_ordinary_result() {
        let response = call("extract_units", &json!({ "content": "no units here" }));
        let envelope = &response["result"]["structuredContent"];
        assert_eq!(response["result"]["isError"], false);
        assert_eq!(envelope["ok"], true);
        assert_eq!(envelope["meta"]["count"], 0);
    }

    /// A refusal is data, not a failure: the tool ran and answered.
    #[test]
    fn a_refusal_comes_back_as_a_successful_answer() {
        let response = call("extract_units", &json!({ "content": "cpu: 500m" }));
        let envelope = &response["result"]["structuredContent"];
        assert_eq!(envelope["ok"], true);
        assert_eq!(response["result"]["isError"], false);
        assert_eq!(
            envelope["data"]["quantities"][0]["reason"],
            "ambiguous_unit"
        );
        assert!(envelope["data"]["quantities"][0]["base"].is_null());
    }

    #[test]
    fn an_unknown_dimension_is_a_tool_failure_that_names_the_four() {
        let response = call(
            "extract_units",
            &json!({ "content": "ttl: 30s", "dimension": "length" }),
        );
        assert_eq!(response["result"]["isError"], true);
        let message = response["result"]["content"][0]["text"]
            .as_str()
            .expect("a message");
        for name in DIMENSIONS {
            assert!(message.contains(name), "{message}");
        }
    }

    #[test]
    fn the_scan_tool_reports_what_it_found() {
        let tree = TempTree::new("mcp-scan");
        tree.write("config.toml", "ttl = \"30s\"\n");
        let response = call(
            "units_le_scan",
            &json!({ "path": tree.path().to_string_lossy() }),
        );
        let envelope = &response["result"]["structuredContent"];
        assert_eq!(response["result"]["isError"], false);
        assert_eq!(envelope["ok"], true);
        assert_eq!(envelope["data"]["quantities"], 1);
    }

    #[test]
    fn the_scan_tool_carries_positions_and_key_paths() {
        let tree = TempTree::new("mcp-positions");
        tree.write("a.yaml", "cache:\n  ttl: 30s\n");
        let response = call(
            "units_le_scan",
            &json!({ "path": tree.path().to_string_lossy() }),
        );
        let found = &response["result"]["structuredContent"]["data"]["reports"][0]["quantities"][0];
        assert_eq!(found["value"], "30s");
        assert_eq!(found["key"], "cache.ttl");
        assert_eq!(found["line"], 2);
    }

    /// The count that tells an agent how much of the answer is a
    /// question.
    #[test]
    fn the_scan_tool_says_how_many_were_refused() {
        let tree = TempTree::new("mcp-refused");
        tree.write("a.yaml", "cpu: 500m\nttl: 30s\n");
        let response = call(
            "units_le_scan",
            &json!({ "path": tree.path().to_string_lossy() }),
        );
        let envelope = &response["result"]["structuredContent"];
        assert_eq!(envelope["data"]["refused"], 1);
        assert_eq!(envelope["diagnostics"][0]["code"], "refused");
        assert_eq!(envelope["ok"], true, "a refusal is not a broken tool");
    }

    /// Refusals speak the caller's vocabulary: an MCP caller has no
    /// command line, so no message may name a flag.
    #[test]
    fn no_message_mentions_a_command_line_flag() {
        let definitions = serde_json::to_string(&tool_definitions()).expect("serializes");
        assert!(!definitions.contains("--"), "{definitions}");

        let tree = TempTree::new("mcp-vocabulary");
        tree.write("a.yaml", "cpu: 500m\n");
        for arguments in [
            json!({}),
            json!({ "paths": [] }),
            json!({ "path": "/no/such/place-xyz" }),
            json!({ "path": tree.path().to_string_lossy(), "dimension": "length" }),
            json!({ "path": tree.path().to_string_lossy() }),
        ] {
            let rendered =
                serde_json::to_string(&call("units_le_scan", &arguments)).expect("serializes");
            assert!(!rendered.contains("--"), "{rendered}");
        }
    }

    /// **`meta.count` counts the same thing in both tools.** It used to
    /// be quantities in one and report lines in the other, so a caller
    /// writing one reader for the envelope — which is the whole point of
    /// there being one envelope — read a file count as a finding count
    /// and got a smaller number that looked plausible.
    #[test]
    fn meta_count_is_the_findings_in_the_answer_for_both_tools() {
        let tree = TempTree::new("mcp-count");
        tree.write("a.yaml", "ttl: 30s\nmem: 512MiB\n");
        tree.write("b.env", "TTL=1h\n");

        let scanned = call(
            "units_le_scan",
            &json!({ "path": tree.path().to_string_lossy() }),
        );
        let envelope = &scanned["result"]["structuredContent"];
        assert_eq!(
            envelope["data"]["reports"]
                .as_array()
                .expect("reports")
                .len(),
            2
        );
        assert_eq!(
            envelope["meta"]["count"], envelope["data"]["quantities"],
            "the scan tool counts something other than its findings"
        );
        assert_eq!(envelope["meta"]["count"], 3);

        let content = call("extract_units", &json!({ "content": "a: 30s\nb: 1MiB" }));
        let envelope = &content["result"]["structuredContent"];
        assert_eq!(
            envelope["meta"]["count"],
            envelope["data"]["quantities"]
                .as_array()
                .expect("rows")
                .len()
        );
    }

    /// Every tool returns the same envelope, so a caller writes one
    /// reader for both.
    #[test]
    fn every_tool_returns_the_same_envelope_shape() {
        let tree = TempTree::new("mcp-envelope");
        tree.write("a.md", "x");
        let results = [
            call("extract_units", &json!({ "content": "x" })),
            call(
                "units_le_scan",
                &json!({ "path": tree.path().to_string_lossy() }),
            ),
        ];
        for result in results {
            let envelope = &result["result"]["structuredContent"];
            assert!(envelope["ok"].is_boolean(), "{envelope}");
            assert!(!envelope["data"].is_null(), "{envelope}");
            assert!(envelope["diagnostics"].is_array(), "{envelope}");
            assert!(envelope["meta"]["tool"].is_string(), "{envelope}");
            assert!(envelope["meta"]["count"].is_number(), "{envelope}");
            assert!(envelope["meta"]["truncated"].is_boolean(), "{envelope}");
        }
    }
}
