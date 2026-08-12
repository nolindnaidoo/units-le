//! The unit grammar, and the refusals.
//!
//! One pinned grammar in one file, hand-written. The crates that would
//! have done this — `byte-unit`, `humantime`, `duration-str`, `uom` —
//! each resolve the cases this tool exists to refuse: `1.5KB` becomes
//! 1500, a bare `m` becomes minutes or millis depending on whose
//! opinion you took. A dependency that guesses is a dependency that
//! decides the audit.
//!
//! **A refusal is a finding.** It carries the source text, a named
//! reason and a sentence a person can act on, and it occupies a row in
//! the report exactly as an accepted quantity does. It is never a
//! dropped row, and it is never a guess. The one thing this tool must
//! never do is normalise something it could not read.
//!
//! **A bare number is not a finding at all.** `timeout: 30` yields
//! nothing here — that is numbers-le's question, and the boundary is
//! what keeps the two tools distinct.

use serde::{Deserialize, Serialize};

use super::decimal::{Decimal, Factor};

/// The four dimensions v1 reads. Physical units — length, mass,
/// temperature — are a non-goal, not an omission; see SPEC.md.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum Dimension {
    Duration,
    Bytes,
    Percent,
    Frequency,
}

/// What a base value is counted in. One per dimension, which is why it
/// is derived rather than stored: two fields that must agree are two
/// fields that can disagree.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum BaseUnit {
    Milliseconds,
    Bytes,
    Ratio,
    Hertz,
}

impl Dimension {
    pub(crate) const ALL: [Self; 4] = [Self::Duration, Self::Bytes, Self::Percent, Self::Frequency];

    /// The name a caller may ask for, and the name reported back.
    pub(crate) const fn name(self) -> &'static str {
        match self {
            Self::Duration => "duration",
            Self::Bytes => "bytes",
            Self::Percent => "percent",
            Self::Frequency => "frequency",
        }
    }

    pub(crate) fn named(name: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|kind| kind.name() == name)
    }

    pub(crate) const fn base_unit(self) -> BaseUnit {
        match self {
            Self::Duration => BaseUnit::Milliseconds,
            Self::Bytes => BaseUnit::Bytes,
            Self::Percent => BaseUnit::Ratio,
            Self::Frequency => BaseUnit::Hertz,
        }
    }
}

impl BaseUnit {
    /// The name a base value is written next to, on the human half and
    /// in the report. One spelling, so the two cannot drift.
    pub(crate) const fn name(self) -> &'static str {
        match self {
            Self::Milliseconds => "milliseconds",
            Self::Bytes => "bytes",
            Self::Ratio => "ratio",
            Self::Hertz => "hertz",
        }
    }
}

/// Why a quantity has no base value — or, for `SiIecHazard` alone, what
/// is true about one that has.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum Reason {
    /// A unit symbol with more than one reading: `m`, `M`, `k`, `Mb`.
    AmbiguousUnit,
    /// A fraction of a byte. Correct arithmetic for SI, a category
    /// error for a byte count.
    FractionalBytes,
    /// A separator whose meaning is the writer's locale: `1,5s`,
    /// `1.000s`.
    LocaleSeparator,
    /// An expression rather than a quantity: `1h + 30m`. Note that
    /// `1h30m` is a grammar and is accepted.
    CompoundArithmetic,
    /// An SI byte multiple in a world that frequently means the binary
    /// one. **The only reason that accompanies a base value**: `MB` is
    /// 10^6 by the standard and this reports it, flags the hazard, and
    /// does not resolve which the writer meant.
    SiIecHazard,
    /// The base value does not fit. Refused rather than wrapped.
    OutOfRange,
}

impl Reason {
    /// Every reason, so a test can assert the corpus pins each one and
    /// the vocabulary cannot grow a value nothing checks.
    #[cfg_attr(not(test), expect(dead_code, reason = "the list is a test fixture"))]
    pub(crate) const ALL: [Self; 6] = [
        Self::AmbiguousUnit,
        Self::FractionalBytes,
        Self::LocaleSeparator,
        Self::CompoundArithmetic,
        Self::SiIecHazard,
        Self::OutOfRange,
    ];
}

/// One quantity, as found.
///
/// `value` is the source text — the evidence. `base` is the normalised
/// comparison, and both are **strings**, for the reason numbers-le's
/// values are: re-encoding through a JSON number hands the reader
/// whatever their parser prints, which is the one thing this crate
/// exists to control.
///
/// There is no `unit` field. The unit is in `value`, where a reader can
/// see it; a field repeating it would be a second place for the two to
/// disagree. A refusal names the offending symbol in `detail` instead.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub(crate) struct Quantity {
    pub(crate) value: String,
    pub(crate) dimension: Option<Dimension>,
    #[serde(rename = "baseUnit")]
    pub(crate) base_unit: Option<BaseUnit>,
    pub(crate) base: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) reason: Option<Reason>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) detail: Option<String>,
}

const HAZARD_DETAIL: &str = "reported as SI — 10^6 bytes to the megabyte — because that is what the symbol says. The \
     writer may have meant 2^20; the IEC spelling (KiB, MiB, GiB) is the one that cannot be \
     read two ways.";

impl Quantity {
    /// Whether this row carries no base value. The `si_iec_hazard` row
    /// is not one of these: it has a base, and a warning about it.
    pub(crate) fn is_refused(&self) -> bool {
        self.base.is_none()
    }

    fn refused(value: &str, dimension: Option<Dimension>, reason: Reason, detail: String) -> Self {
        Self {
            value: value.to_string(),
            dimension,
            base_unit: dimension.map(Dimension::base_unit),
            base: None,
            reason: Some(reason),
            detail: Some(detail),
        }
    }

    fn resolved(value: &str, dimension: Dimension, base: Decimal, hazard: bool) -> Self {
        Self {
            value: value.to_string(),
            dimension: Some(dimension),
            base_unit: Some(dimension.base_unit()),
            base: Some(base.render()),
            reason: hazard.then_some(Reason::SiIecHazard),
            detail: hazard.then(|| HAZARD_DETAIL.to_string()),
        }
    }
}

/// One unit symbol, exactly as it must be written.
///
/// **Case is part of the symbol.** `MB` is a megabyte and `Mb` is a
/// megabit; folding the two would silently multiply by eight. Every
/// accepted spelling is a row here, so what is accepted is a list a
/// person can read rather than a rule they have to derive.
struct Unit {
    symbol: &'static str,
    dimension: Dimension,
    factor: Factor,
    /// An SI byte multiple, which a great deal of software writes when
    /// it means the binary one.
    hazard: bool,
}

/// The scale every duration shares: a nanosecond, as a power of ten
/// under a millisecond. One scale for all of them is what lets the
/// compound rule compare two units' magnitudes.
const NS: u32 = 6;

const fn duration(symbol: &'static str, nanoseconds: u128) -> Unit {
    Unit {
        symbol,
        dimension: Dimension::Duration,
        factor: Factor::new(nanoseconds, NS),
        hazard: false,
    }
}

const fn size(symbol: &'static str, bytes: u128, hazard: bool) -> Unit {
    Unit {
        symbol,
        dimension: Dimension::Bytes,
        factor: Factor::new(bytes, 0),
        hazard,
    }
}

const fn hertz(symbol: &'static str, cycles: u128) -> Unit {
    Unit {
        symbol,
        dimension: Dimension::Frequency,
        factor: Factor::new(cycles, 0),
        hazard: false,
    }
}

const MICROSECOND: u128 = 1_000;
const MILLISECOND: u128 = 1_000_000;
const SECOND: u128 = 1_000 * MILLISECOND;
const MINUTE: u128 = 60 * SECOND;
const HOUR: u128 = 60 * MINUTE;
const DAY: u128 = 24 * HOUR;
const WEEK: u128 = 7 * DAY;

const KIB: u128 = 1024;
const MIB: u128 = 1024 * KIB;
const GIB: u128 = 1024 * MIB;
const TIB: u128 = 1024 * GIB;
const PIB: u128 = 1024 * TIB;

/// Every symbol this grammar accepts. Nothing resolves that is not
/// here, and a symbol here is unambiguous by construction — the ones
/// that are not live in `AMBIGUOUS`.
const UNITS: [Unit; 41] = [
    duration("ns", 1),
    duration("us", MICROSECOND),
    duration("µs", MICROSECOND),
    duration("μs", MICROSECOND),
    duration("ms", MILLISECOND),
    duration("s", SECOND),
    duration("sec", SECOND),
    duration("secs", SECOND),
    duration("min", MINUTE),
    duration("mins", MINUTE),
    duration("h", HOUR),
    duration("hr", HOUR),
    duration("hrs", HOUR),
    duration("d", DAY),
    duration("day", DAY),
    duration("days", DAY),
    duration("w", WEEK),
    size("B", 1, false),
    size("kB", 1_000, true),
    size("KB", 1_000, true),
    size("MB", 1_000_000, true),
    size("GB", 1_000_000_000, true),
    size("TB", 1_000_000_000_000, true),
    size("PB", 1_000_000_000_000_000, true),
    size("KiB", KIB, false),
    size("MiB", MIB, false),
    size("GiB", GIB, false),
    size("TiB", TIB, false),
    size("PiB", PIB, false),
    // Kubernetes writes its binary multiples without the trailing B.
    size("Ki", KIB, false),
    size("Mi", MIB, false),
    size("Gi", GIB, false),
    size("Ti", TIB, false),
    size("Pi", PIB, false),
    hertz("Hz", 1),
    hertz("kHz", 1_000),
    hertz("KHz", 1_000),
    hertz("MHz", 1_000_000),
    hertz("GHz", 1_000_000_000),
    hertz("THz", 1_000_000_000_000),
    Unit {
        symbol: "%",
        dimension: Dimension::Percent,
        factor: Factor::new(1, 2),
        hazard: false,
    },
];

/// Strictly, a lowercase `b` is bits. In practice `500mb` is written by
/// people who mean megabytes, so the symbol carries two readings
/// whatever the standard says — and this refuses rather than picking
/// the one that is right most of the time.
const BITS_OR_BYTES: &str = "a lowercase `b` is bits by the standard and bytes in most of the software that writes it, \
     and the two differ by eight. Write `MB` for bytes or `Mbit` for bits.";

/// The symbols with more than one reading, and what the readings are.
/// "Ambiguous" without naming the alternatives is not actionable, so
/// every row carries the sentence that goes in `detail`.
const AMBIGUOUS: [(&str, &str); 18] = [
    (
        "m",
        "`m` is minutes in one config format, milliseconds in another and millicores in \
         Kubernetes. Write `min`, `ms`, or spell out the core count.",
    ),
    (
        "M",
        "`M` is mega- in one config format and minutes in another. Write `MB`, `Mi` or `min`.",
    ),
    (
        "k",
        "`k` is a prefix with no unit after it: a thousand of what? Write `kB`, `Ki` or `kHz`.",
    ),
    (
        "K",
        "`K` is a prefix with no unit after it: a thousand of what? Write `KB`, `Ki` or `KHz`.",
    ),
    (
        "G",
        "`G` is a prefix with no unit after it. Write `GB`, `Gi` or `GHz`.",
    ),
    (
        "T",
        "`T` is a prefix with no unit after it. Write `TB`, `Ti` or `THz`.",
    ),
    (
        "P",
        "`P` is a prefix with no unit after it. Write `PB` or `Pi`.",
    ),
    (
        "y",
        "a calendar year has no fixed length. Write the number of days.",
    ),
    (
        "Y",
        "a calendar year has no fixed length. Write the number of days.",
    ),
    ("b", BITS_OR_BYTES),
    ("kb", BITS_OR_BYTES),
    ("Kb", BITS_OR_BYTES),
    ("mb", BITS_OR_BYTES),
    ("Mb", BITS_OR_BYTES),
    ("gb", BITS_OR_BYTES),
    ("Gb", BITS_OR_BYTES),
    ("tb", BITS_OR_BYTES),
    ("Tb", BITS_OR_BYTES),
];

/// What a symbol turned out to be.
enum Symbol {
    Known(&'static Unit),
    /// More than one reading, with the sentence that says which.
    Ambiguous(&'static str),
    /// Not a unit this grammar knows, so the token is not a quantity.
    Unknown,
}

fn resolve(symbol: &str) -> Symbol {
    if let Some(unit) = UNITS.iter().find(|unit| unit.symbol == symbol) {
        return Symbol::Known(unit);
    }
    AMBIGUOUS
        .iter()
        .find(|(candidate, _)| *candidate == symbol)
        .map_or(Symbol::Unknown, |(_, detail)| Symbol::Ambiguous(detail))
}

/// One `number, symbol` pair. `1h30m` is two of them.
struct Part<'a> {
    number: &'a str,
    symbol: &'a str,
}

/// Read one whole value — a config value, a CSV cell — as a quantity.
///
/// `None` means there is no unit here, and no unit means this is not
/// this tool's question.
pub(crate) fn read_value(text: &str) -> Option<Quantity> {
    let token = text.trim();
    if token.is_empty() {
        return None;
    }
    expression(token).or_else(|| read(token))
}

/// Read one token: no whitespace, no operators.
pub(crate) fn read(token: &str) -> Option<Quantity> {
    if let Some(rest) = token.strip_prefix('P') {
        return iso8601(token, rest);
    }
    let parts = lex(token)?;
    let (first, rest) = parts.split_first()?;
    if rest.is_empty() {
        return simple(token, first);
    }
    compound(token, &parts)
}

/// `1h + 30m` — an expression, not a quantity.
///
/// Refused rather than evaluated, and refused as **one** finding: the
/// failure worth preventing is a scan reporting `1h` and `30m` as two
/// independent quantities, which is a true statement about the text and
/// a false one about the value.
fn expression(token: &str) -> Option<Quantity> {
    let segments: Vec<&str> = token.split(['+', '-', '*', '/']).collect();
    if segments.len() < 2 {
        return None;
    }
    if !segments.iter().all(|part| read(part.trim()).is_some()) {
        return None;
    }
    Some(Quantity::refused(
        token,
        None,
        Reason::CompoundArithmetic,
        "this is arithmetic, not a quantity, and this tool does not evaluate it. `1h30m` is one \
         duration written in two parts and is read; `1h + 30m` is a sum."
            .to_string(),
    ))
}

/// Split a token into `number, symbol` pairs.
///
/// A trailing number with no symbol (`1h30`) is not a quantity: the
/// grammar is pairs, and half a pair is a typo this will not complete.
fn lex(token: &str) -> Option<Vec<Part<'_>>> {
    let mut parts = Vec::new();
    let mut rest = token;
    while !rest.is_empty() {
        let number_end = number_prefix(rest, parts.is_empty());
        if number_end == 0 {
            return None;
        }
        let (number, tail) = rest.split_at(number_end);
        let symbol_end = symbol_prefix(tail);
        if symbol_end == 0 {
            return None;
        }
        let (symbol, tail) = tail.split_at(symbol_end);
        parts.push(Part { number, symbol });
        rest = tail;
    }
    (!parts.is_empty()).then_some(parts)
}

/// How many bytes of `text` are the number at its head.
///
/// A comma is taken **into** the number rather than ending it, so that
/// `1,5s` arrives as one token and is refused by name. Ending the
/// number at the comma would have reported `1` and thrown the rest
/// away, which is the silent wrong answer this whole module is against.
pub(crate) fn number_prefix(text: &str, allow_sign: bool) -> usize {
    let mut length = 0;
    let mut digits = 0;
    for (index, character) in text.char_indices() {
        let signed = index == 0 && allow_sign && matches!(character, '+' | '-');
        if !signed && !matches!(character, '0'..='9' | '.' | ',') {
            break;
        }
        digits += usize::from(character.is_ascii_digit());
        length = index + character.len_utf8();
    }
    if digits == 0 { 0 } else { length }
}

/// How many bytes of `text` are the unit symbol at its head: a run of
/// letters, or a single `%`.
pub(crate) fn symbol_prefix(text: &str) -> usize {
    if text.starts_with('%') {
        return 1;
    }
    text.char_indices()
        .take_while(|(_, character)| character.is_alphabetic())
        .map(|(index, character)| index + character.len_utf8())
        .last()
        .unwrap_or(0)
}

/// One number, one symbol.
fn simple(token: &str, part: &Part<'_>) -> Option<Quantity> {
    let unit = match resolve(part.symbol) {
        Symbol::Unknown => return None,
        Symbol::Ambiguous(detail) => {
            return Some(Quantity::refused(
                token,
                None,
                Reason::AmbiguousUnit,
                detail.to_string(),
            ));
        }
        Symbol::Known(unit) => unit,
    };

    if let Some(detail) = separator_hazard(part.number) {
        return Some(Quantity::refused(
            token,
            Some(unit.dimension),
            Reason::LocaleSeparator,
            detail,
        ));
    }
    let Some(number) = Decimal::parse(part.number) else {
        return Some(out_of_range(token, unit.dimension));
    };
    if unit.dimension == Dimension::Bytes && number.is_fractional() {
        return Some(Quantity::refused(
            token,
            Some(Dimension::Bytes),
            Reason::FractionalBytes,
            "a byte count cannot have a fractional part, and whether the arithmetic is even \
             right depends on whether the multiple is 1000 or 1024. Write the whole number of \
             bytes."
                .to_string(),
        ));
    }
    let Some(base) = number.apply(unit.factor) else {
        return Some(out_of_range(token, unit.dimension));
    };
    Some(Quantity::resolved(token, unit.dimension, base, unit.hazard))
}

/// `1h30m` — one duration written in parts.
///
/// **The parts disambiguate each other.** `m` alone is refused, and `m`
/// between `h` and `s` can only be minutes: a compound is written
/// largest-first, and milliseconds ahead of seconds would not be. The
/// ordering is required rather than assumed, so `30s1h` is not a
/// quantity at all.
fn compound(token: &str, parts: &[Part<'_>]) -> Option<Quantity> {
    let mut total: Option<Decimal> = None;
    let mut previous = u128::MAX;

    for part in parts {
        let unit = compound_unit(part.symbol)?;
        if unit.factor.multiplier >= previous {
            return None;
        }
        previous = unit.factor.multiplier;
        if let Some(detail) = separator_hazard(part.number) {
            return Some(Quantity::refused(
                token,
                Some(Dimension::Duration),
                Reason::LocaleSeparator,
                detail,
            ));
        }
        let scaled = Decimal::parse(part.number).and_then(|number| number.apply(unit.factor));
        let summed = match (total, scaled) {
            (_, None) => None,
            (None, Some(scaled)) => Some(scaled),
            (Some(running), Some(scaled)) => running.checked_add(scaled),
        };
        let Some(summed) = summed else {
            return Some(out_of_range(token, Dimension::Duration));
        };
        total = Some(summed);
    }

    Some(Quantity::resolved(
        token,
        Dimension::Duration,
        total?,
        false,
    ))
}

/// A duration symbol as it reads *inside* a compound, where `m` is
/// minutes.
fn compound_unit(symbol: &str) -> Option<&'static Unit> {
    let wanted = if symbol == "m" { "min" } else { symbol };
    match resolve(wanted) {
        Symbol::Known(unit) if unit.dimension == Dimension::Duration => Some(unit),
        _ => None,
    }
}

/// ISO-8601: `PT1H30M`, `P1DT2H`, `PT0.5S`.
///
/// `P1Y` and `P1M` are refused. A calendar year and a calendar month
/// have no fixed length, and `P1M` differs from `PT1M` — one minute —
/// by a single letter, which is ambiguity in its most expensive form.
fn iso8601(token: &str, rest: &str) -> Option<Quantity> {
    let mut total: Option<Decimal> = None;
    let mut components = 0;
    let mut in_time = false;
    let mut cursor = rest;

    while !cursor.is_empty() {
        if let Some(tail) = cursor.strip_prefix('T') {
            in_time = true;
            cursor = tail;
            continue;
        }
        let number_end = number_prefix(cursor, false);
        if number_end == 0 {
            return None;
        }
        let (number, tail) = cursor.split_at(number_end);
        let designator = tail.chars().next()?;
        let Some(factor) = iso_factor(designator, in_time) else {
            return calendar_refusal(token, designator);
        };
        // The standard makes a comma its own decimal separator, so
        // `PT1,5S` is not a locale guess — it is what the format says.
        let number = number.replace(',', ".");
        if number.matches('.').count() > 1 {
            return None;
        }
        let scaled = Decimal::parse(&number).and_then(|value| value.apply(factor));
        let summed = match (total, scaled) {
            (_, None) => None,
            (None, Some(scaled)) => Some(scaled),
            (Some(running), Some(scaled)) => running.checked_add(scaled),
        };
        let Some(summed) = summed else {
            return Some(out_of_range(token, Dimension::Duration));
        };
        total = Some(summed);
        components += 1;
        cursor = &tail[designator.len_utf8()..];
    }

    if components == 0 {
        return None;
    }
    Some(Quantity::resolved(
        token,
        Dimension::Duration,
        total?,
        false,
    ))
}

fn iso_factor(designator: char, in_time: bool) -> Option<Factor> {
    let nanoseconds = match (designator, in_time) {
        ('W', false) => WEEK,
        ('D', false) => DAY,
        ('H', true) => HOUR,
        ('M', true) => MINUTE,
        ('S', true) => SECOND,
        _ => return None,
    };
    Some(Factor::new(nanoseconds, NS))
}

/// `P1Y` and `P1M`, which parse and cannot be resolved. Anything else
/// unrecognised is simply not an ISO duration.
fn calendar_refusal(token: &str, designator: char) -> Option<Quantity> {
    if !matches!(designator, 'Y' | 'M') {
        return None;
    }
    Some(Quantity::refused(
        token,
        Some(Dimension::Duration),
        Reason::AmbiguousUnit,
        "a calendar year or month has no fixed length, and `P1M` is a month where `PT1M` is a \
         minute. Write the number of days, or move the component after the `T`."
            .to_string(),
    ))
}

/// A number whose separators only mean something once you know who
/// wrote it.
fn separator_hazard(number: &str) -> Option<String> {
    if number.contains(',') {
        return Some(
            "`1,5` is one and a half where a comma is the decimal point, and fifteen hundred \
             where it groups thousands. This tool does not infer a locale."
                .to_string(),
        );
    }
    if number.matches('.').count() > 1 {
        return Some(
            "more than one decimal point, so the separators are grouping something rather than \
             marking a fraction. This tool does not infer a locale."
                .to_string(),
        );
    }
    let (whole, fraction) = number.split_once('.')?;
    let whole = whole.trim_start_matches(['+', '-']);
    // A thousands group is one to three digits, then exactly three, and
    // never starts with a lone zero — which is what tells `1.500` from
    // `0.825`. The first is one and a half or fifteen hundred depending
    // on the writer; the second is unambiguous either way.
    let grouped = (1..=3).contains(&whole.len()) && !whole.starts_with('0') && fraction.len() == 3;
    grouped.then(|| {
        "`1.000` is one where a point is the decimal separator, and a thousand where it groups \
         thousands. This tool does not infer a locale."
            .to_string()
    })
}

fn out_of_range(token: &str, dimension: Dimension) -> Quantity {
    Quantity::refused(
        token,
        Some(dimension),
        Reason::OutOfRange,
        "the base value does not fit in 128 bits. Refused rather than wrapped, because a wrapped \
         count is a confident wrong answer."
            .to_string(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn base(token: &str) -> String {
        read(token)
            .unwrap_or_else(|| panic!("{token} is not a quantity"))
            .base
            .unwrap_or_else(|| panic!("{token} was refused"))
    }

    fn refusal(token: &str) -> Reason {
        read(token)
            .unwrap_or_else(|| panic!("{token} is not a quantity"))
            .reason
            .unwrap_or_else(|| panic!("{token} was accepted"))
    }

    #[test]
    fn a_plain_duration_normalises_to_milliseconds() {
        assert_eq!(base("30s"), "30000");
        assert_eq!(base("300ms"), "300");
        assert_eq!(base("1h"), "3600000");
        assert_eq!(base("1d"), "86400000");
        assert_eq!(base("5min"), "300000");
        assert_eq!(base("1w"), "604800000");
    }

    #[test]
    fn a_sub_millisecond_duration_keeps_its_fraction() {
        assert_eq!(base("1ns"), "0.000001");
        assert_eq!(base("500us"), "0.5");
    }

    /// The grammar, not arithmetic: the parts disambiguate each other,
    /// so the `m` refused on its own is minutes here.
    #[test]
    fn a_compound_duration_is_one_quantity() {
        assert_eq!(base("1h30m"), "5400000");
        assert_eq!(base("1m30s"), "90000");
        assert_eq!(base("1d2h3m4s"), "93784000");
    }

    /// Descending order is required rather than assumed, which is what
    /// makes `m` inside a compound unambiguous.
    #[test]
    fn a_compound_out_of_order_is_not_a_quantity() {
        assert!(read("30s1h").is_none());
        assert!(read("1h2h").is_none());
    }

    #[test]
    fn an_iso_duration_is_read() {
        assert_eq!(base("PT1H30M"), "5400000");
        assert_eq!(base("P1D"), "86400000");
        assert_eq!(base("P1DT2H"), "93600000");
        assert_eq!(base("PT0.5S"), "500");
        assert_eq!(base("P2W"), "1209600000");
    }

    /// The standard's own decimal separator, which is not a locale
    /// guess: inside an ISO duration a comma has one meaning.
    #[test]
    fn an_iso_duration_may_use_a_comma_for_its_fraction() {
        assert_eq!(base("PT1,5S"), "1500");
    }

    #[test]
    fn byte_units_are_si_or_iec_by_their_spelling() {
        assert_eq!(base("512MiB"), "536870912");
        assert_eq!(base("1GiB"), "1073741824");
        assert_eq!(base("128Mi"), "134217728");
        assert_eq!(base("2GB"), "2000000000");
        assert_eq!(base("512B"), "512");
    }

    #[test]
    fn a_percentage_is_a_ratio() {
        assert_eq!(base("15%"), "0.15");
        assert_eq!(base("100%"), "1");
        assert_eq!(base("0.5%"), "0.005");
    }

    #[test]
    fn a_frequency_is_hertz() {
        assert_eq!(base("2.4GHz"), "2400000000");
        assert_eq!(base("44.1kHz"), "44100");
        assert_eq!(base("60Hz"), "60");
    }

    /// The boundary that keeps this tool and numbers-le distinct.
    #[test]
    fn a_bare_number_is_not_a_finding() {
        for token in ["30", "0.5", "-7", "0"] {
            assert!(read(token).is_none(), "{token}");
        }
    }

    #[test]
    fn a_symbol_this_grammar_does_not_know_is_not_a_finding() {
        for token in ["30x", "5foo", "10kg", "3.5in", "1e3"] {
            assert!(read(token).is_none(), "{token}");
        }
    }

    #[test]
    fn an_ambiguous_symbol_is_refused_by_name() {
        for token in ["500m", "30m", "10M", "5k", "4G", "2T", "1y", "100Mb", "8b"] {
            assert_eq!(refusal(token), Reason::AmbiguousUnit, "{token}");
        }
    }

    /// A refusal names no dimension when the unit is what could not be
    /// read — there is nothing to name.
    #[test]
    fn an_ambiguous_symbol_names_no_dimension() {
        let found = read("500m").expect("a quantity");
        assert!(found.dimension.is_none());
        assert!(found.base_unit.is_none());
        assert!(found.detail.expect("a detail").contains("millicores"));
    }

    #[test]
    fn a_fraction_of_a_byte_is_refused() {
        for token in ["1.5KB", "0.5MiB", "2.25GB"] {
            assert_eq!(refusal(token), Reason::FractionalBytes, "{token}");
        }
    }

    /// The refusal is about the category, not the arithmetic: `1.5KiB`
    /// is exactly 1536 bytes and is still refused, while `1.0KB` is a
    /// thousand bytes written oddly and is not.
    #[test]
    fn a_fractional_byte_count_is_refused_even_where_it_divides_evenly() {
        assert_eq!(refusal("1.5KiB"), Reason::FractionalBytes);
        assert_eq!(base("1.0KB"), "1000");
    }

    #[test]
    fn a_locale_separator_is_refused() {
        for token in ["1,5s", "1.000s", "1,000ms", "1.500h", "1.2.3s"] {
            assert_eq!(refusal(token), Reason::LocaleSeparator, "{token}");
        }
    }

    /// The narrowing that keeps the locale rule from swallowing real
    /// fractions: a leading zero is never a thousands group.
    #[test]
    fn a_plain_fraction_is_not_a_locale_hazard() {
        assert_eq!(base("0.825s"), "825");
        assert_eq!(base("2.5s"), "2500");
        assert_eq!(base("12.25h"), "44100000");
    }

    #[test]
    fn arithmetic_is_refused_as_one_finding() {
        for token in ["1h + 30m", "1h+30m", "30s*2s", "1h - 5m"] {
            let found = read_value(token).unwrap_or_else(|| panic!("{token}"));
            assert_eq!(found.reason, Some(Reason::CompoundArithmetic), "{token}");
            assert_eq!(found.value, token, "the whole expression is the finding");
        }
    }

    /// A negative quantity is a quantity, not a subtraction.
    #[test]
    fn a_leading_sign_is_not_an_operator() {
        assert_eq!(base("-30s"), "-30000");
        assert_eq!(read_value("-30s").expect("a quantity").reason, None);
    }

    /// SI is what the symbol says, so it is reported; that the writer
    /// may have meant 2^20 is a flag on the answer, not a reason to
    /// withhold one.
    #[test]
    fn an_si_byte_multiple_is_reported_and_flagged() {
        let found = read("1MB").expect("a quantity");
        assert_eq!(found.base, Some("1000000".to_string()));
        assert_eq!(found.reason, Some(Reason::SiIecHazard));
        assert!(!found.is_refused(), "a hazard is not a refusal");
    }

    #[test]
    fn an_iec_byte_multiple_carries_no_hazard() {
        for token in ["1MiB", "1Mi", "1B"] {
            assert_eq!(read(token).expect("a quantity").reason, None, "{token}");
        }
    }

    #[test]
    fn a_calendar_component_in_an_iso_duration_is_refused() {
        assert_eq!(refusal("P1Y"), Reason::AmbiguousUnit);
        assert_eq!(refusal("P1M"), Reason::AmbiguousUnit);
        assert_eq!(base("PT1M"), "60000", "the same letter after the T");
    }

    #[test]
    fn an_unparseable_iso_duration_is_not_a_quantity() {
        for token in ["P", "PT", "PX", "P1", "Pfoo"] {
            assert!(read(token).is_none(), "{token}");
        }
    }

    /// Refused rather than wrapped. In release the profile turns a
    /// missed check into a crash; this is the check.
    #[test]
    fn a_quantity_too_large_to_hold_is_refused() {
        let huge = "99999999999999999999999999999999999PiB";
        assert_eq!(refusal(huge), Reason::OutOfRange);
    }

    #[test]
    fn case_is_part_of_the_symbol() {
        assert_eq!(base("1MB"), "1000000");
        assert_eq!(refusal("1Mb"), Reason::AmbiguousUnit);
        assert!(read("1mib").is_none(), "IEC is spelled MiB");
    }

    #[test]
    fn a_value_is_trimmed_before_it_is_read() {
        assert_eq!(read_value("  30s  ").expect("a quantity").value, "30s");
        assert!(read_value("   ").is_none());
    }

    /// Every dimension answers with its own name and base unit, and
    /// both mappings are total — a dimension with no base unit would
    /// serialise a null nobody could read.
    #[test]
    fn every_dimension_names_a_base_unit_and_a_name() {
        for dimension in Dimension::ALL {
            assert_eq!(Dimension::named(dimension.name()), Some(dimension));
            let _: BaseUnit = dimension.base_unit();
        }
        assert!(Dimension::named("length").is_none());
    }

    /// Every symbol resolves to exactly one reading. A symbol in both
    /// tables would be accepted or refused depending on lookup order,
    /// which is the kind of bug that only shows up in someone's config.
    #[test]
    fn no_symbol_is_both_known_and_ambiguous() {
        for unit in &UNITS {
            assert!(
                !AMBIGUOUS.iter().any(|(symbol, _)| *symbol == unit.symbol),
                "{} is in both tables",
                unit.symbol
            );
        }
    }

    /// **Does this crate read what it claims to read?**
    ///
    /// Driven off `UNITS` and `AMBIGUOUS` themselves rather than off a
    /// list beside them, because a list beside them is a list that
    /// drifts. Every accepted spelling has to resolve to the dimension
    /// its row declares, every refused one has to come back as
    /// `ambiguous_unit`, and **every symbol in both tables has to appear
    /// in SPEC.md** — a symbol the grammar accepts and the spec does not
    /// mention is a promise nobody made and nobody can check.
    ///
    /// The marker line is not decoration: `cargo test <filter>` exits 0
    /// when the filter matches nothing, so CI greps for it rather than
    /// trusting a green run.
    #[test]
    fn coverage_matrix_every_unit_spelling_is_reachable_and_documented() {
        const SPEC: &str = include_str!("../../SPEC.md");

        for unit in &UNITS {
            let token = format!("1{}", unit.symbol);
            let found = read(&token).unwrap_or_else(|| panic!("{token} is not a quantity"));
            assert_eq!(
                found.dimension,
                Some(unit.dimension),
                "{} resolves to the wrong dimension",
                unit.symbol
            );
            assert!(found.base.is_some(), "{} has no base value", unit.symbol);
            assert_eq!(
                found.reason.is_some(),
                unit.hazard,
                "{} carries a reason its row does not declare",
                unit.symbol
            );
            assert!(
                SPEC.contains(&format!("`{}`", unit.symbol)),
                "{} is accepted and SPEC.md does not name it",
                unit.symbol
            );
        }

        for (symbol, detail) in AMBIGUOUS {
            let token = format!("1{symbol}");
            assert_eq!(refusal(&token), Reason::AmbiguousUnit, "{symbol}");
            assert!(
                !detail.is_empty(),
                "{symbol} is refused without saying what the readings are"
            );
            assert!(
                SPEC.contains(&format!("`{symbol}`")),
                "{symbol} is refused and SPEC.md does not name it"
            );
        }

        eprintln!(
            "coverage-matrix: {} unit spellings and {} ambiguous symbols, all reachable and \
             documented",
            UNITS.len(),
            AMBIGUOUS.len()
        );
    }

    /// Durations share one scale so their magnitudes can be compared,
    /// which is what the compound ordering rule rests on.
    #[test]
    fn every_duration_shares_the_nanosecond_scale() {
        for unit in UNITS.iter().filter(|u| u.dimension == Dimension::Duration) {
            assert_eq!(unit.factor.shift, NS, "{}", unit.symbol);
        }
    }
}
