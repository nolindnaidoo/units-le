//! The crates the shared TypeScript parsers transcribe, answering for a
//! list of documents in one canonical form, so the transcriptions can be
//! checked against the originals.
use std::io::Read;

use jsonc_parser::ast::{ObjectPropName, Value as Node};
use jsonc_parser::{CollectOptions, ParseOptions, parse_to_ast};
use saphyr::{LoadableYamlNode, Scalar, Yaml};
use serde_json::{Value, json};

fn bits(value: f64) -> String {
    format!("{:016x}", value.to_bits())
}

fn yaml(node: &Yaml<'_>) -> Value {
    match node {
        Yaml::Value(Scalar::Null) => json!(["n"]),
        Yaml::Value(Scalar::Boolean(value)) => json!(["b", value]),
        Yaml::Value(Scalar::Integer(value)) => json!(["i", value.to_string()]),
        Yaml::Value(Scalar::FloatingPoint(value)) => json!(["f", bits(value.into_inner())]),
        Yaml::Value(Scalar::String(value)) => json!(["s", value]),
        Yaml::Sequence(items) => json!(["q", items.iter().map(yaml).collect::<Vec<_>>()]),
        Yaml::Mapping(entries) => json!([
            "m",
            entries.iter().map(|(k, v)| json!([yaml(k), yaml(v)])).collect::<Vec<_>>()
        ]),
        Yaml::Tagged(tag, inner) => json!(["t", tag.handle, tag.suffix, yaml(inner)]),
        Yaml::Alias(_) => json!(["a"]),
        Yaml::BadValue => json!(["x"]),
        Yaml::Representation(..) => json!(["r"]),
    }
}

fn toml_value(value: &toml::Value) -> Value {
    match value {
        toml::Value::String(text) => json!(["s", text]),
        toml::Value::Integer(number) => json!(["i", number.to_string()]),
        toml::Value::Float(number) => json!(["f", bits(*number)]),
        toml::Value::Boolean(value) => json!(["b", value]),
        toml::Value::Datetime(_) => json!(["d"]),
        toml::Value::Array(items) => json!(["q", items.iter().map(toml_value).collect::<Vec<_>>()]),
        toml::Value::Table(table) => json!([
            "m",
            table.iter().map(|(k, v)| json!([k, toml_value(v)])).collect::<Vec<_>>()
        ]),
    }
}

fn utf16(text: &str, byte: usize) -> usize {
    text[..byte].encode_utf16().count()
}

fn json_node(text: &str, node: &Node) -> Value {
    match node {
        Node::StringLit(literal) => json!(["s", literal.value, utf16(text, literal.range.start)]),
        Node::NumberLit(literal) => json!(["n", literal.value, utf16(text, literal.range.start)]),
        Node::Array(array) => json!([
            "q",
            array.elements.iter().map(|e| json_node(text, e)).collect::<Vec<_>>()
        ]),
        Node::Object(object) => json!([
            "m",
            object
                .properties
                .iter()
                .map(|p| {
                    let name = match &p.name {
                        ObjectPropName::String(s) => s.value.to_string(),
                        ObjectPropName::Word(w) => w.value.to_string(),
                    };
                    json!([name, json_node(text, &p.value)])
                })
                .collect::<Vec<_>>()
        ]),
        _ => json!(["o"]),
    }
}

fn jsonc(text: &str, loose: bool) -> Value {
    let options = ParseOptions {
        allow_comments: loose,
        allow_loose_object_property_names: false,
        allow_trailing_commas: loose,
        allow_missing_commas: false,
        allow_single_quoted_strings: false,
        allow_hexadecimal_numbers: false,
        allow_unary_plus_numbers: false,
    };
    match parse_to_ast(text, &CollectOptions::default(), &options) {
        Ok(result) => json!({ "ok": result.value.as_ref().map(|v| json_node(text, v)) }),
        Err(error) => json!({ "error": error.to_string() }),
    }
}

fn without_bare_keys(text: &str) -> String {
    text.lines()
        .filter(|line| {
            let trimmed = line.trim();
            trimmed.is_empty()
                || line.starts_with(char::is_whitespace)
                || trimmed.starts_with(';')
                || trimmed.starts_with('#')
                || trimmed.starts_with('[')
                || trimmed.contains('=')
                || trimmed.contains(':')
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn ini(text: &str) -> Value {
    let options = ini::ParseOption { enabled_escape: false, ..ini::ParseOption::default() };
    match ini::Ini::load_from_str_opt(&without_bare_keys(text), options) {
        Ok(parsed) => json!({
            "ok": parsed
                .iter()
                .map(|(section, props)| json!([
                    section,
                    props.iter().map(|(k, v)| json!([k, v])).collect::<Vec<_>>()
                ]))
                .collect::<Vec<_>>()
        }),
        Err(error) => json!({ "error": error.to_string() }),
    }
}

fn csv_rows(text: &str, delimiter: u8) -> Value {
    let rows: Result<Vec<Vec<String>>, String> = csv::ReaderBuilder::new()
        .delimiter(delimiter)
        .has_headers(false)
        .flexible(true)
        .from_reader(text.as_bytes())
        .records()
        .map(|r| r.map(|row| row.iter().map(str::to_string).collect()).map_err(|e| e.to_string()))
        .collect();
    match rows {
        Ok(rows) => json!({ "ok": rows }),
        Err(error) => json!({ "error": error }),
    }
}

fn trim_around_quotes(text: &str) -> Result<String, String> {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    let mut at_field_start = true;

    while let Some(character) = chars.next() {
        if at_field_start && (character == ' ' || character == '\t') {
            let mut held = String::from(character);
            while let Some(&next) = chars.peek() {
                if next == ' ' || next == '\t' {
                    held.push(next);
                    chars.next();
                } else {
                    break;
                }
            }
            if chars.peek() != Some(&'"') {
                out.push_str(&held);
            }
            at_field_start = false;
            continue;
        }

        if character == '"' && at_field_start {
            out.push('"');
            at_field_start = false;
            let mut closed = false;
            while let Some(inner) = chars.next() {
                out.push(inner);
                if inner == '"' {
                    if chars.peek() == Some(&'"') {
                        out.push(chars.next().expect("peeked"));
                        continue;
                    }
                    while matches!(chars.peek(), Some(' ' | '\t')) {
                        chars.next();
                    }
                    closed = true;
                    break;
                }
            }
            if !closed {
                return Err("Failed to parse CSV: quoted field is never closed".to_string());
            }
            continue;
        }

        out.push(character);
        at_field_start = matches!(character, ',' | '\n' | '\r');
    }
    Ok(out)
}

fn main() {
    let mut input = String::new();
    std::io::stdin().read_to_string(&mut input).expect("stdin");
    let cases: Vec<Value> = serde_json::from_str(&input).expect("a JSON list");
    let answers: Vec<Value> = cases
        .iter()
        .map(|case| {
            let text = case["text"].as_str().expect("text");
            match case["format"].as_str().expect("format") {
                "yaml" => match Yaml::load_from_str(text) {
                    Ok(docs) => json!({ "ok": docs.iter().map(yaml).collect::<Vec<_>>() }),
                    Err(error) => json!({ "error": error.to_string() }),
                },
                "toml" => match text.parse::<toml::Table>() {
                    Ok(table) => json!({ "ok": toml_value(&toml::Value::Table(table)) }),
                    Err(error) => json!({ "error": error.to_string() }),
                },
                "json" => jsonc(text, false),
                "jsonc" => jsonc(text, true),
                "ini" => ini(text),
                "csv" => csv_rows(text, b','),
                "tsv" => csv_rows(text, b'\t'),
                "csvtrim" => match trim_around_quotes(text) {
                    Ok(trimmed) => csv_rows(&trimmed, b','),
                    Err(error) => json!({ "error": error }),
                },
                other => panic!("no format {other}"),
            }
        })
        .collect();
    println!("{}", serde_json::to_string(&answers).expect("answers serialize"));
}
