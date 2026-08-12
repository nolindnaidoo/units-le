//! Exact decimal arithmetic, and the printing of it.
//!
//! **This is the contract, not a detail.** A base value is a claim about
//! a quantity — that `512MiB` is 536870912 bytes — and a claim carried
//! through an `f64` is a claim about a neighbourhood. `0.1s` would come
//! back as `100.00000000000001` milliseconds, which is not wrong by
//! enough to notice and not right by enough to compare, and comparing is
//! the whole reason a base value exists.
//!
//! So a number here is a sign, an integer mantissa, and a power-of-ten
//! scale: `1.5` is `15 / 10^1`. Every unit conversion is an integer
//! multiplication and a shift of that scale, so a base value is exact or
//! it is refused — there is no third answer.
//!
//! Every operation is checked. `overflow-checks` is on in release for
//! the same reason, but as a backstop: a `PiB` count that wrapped would
//! report a confident wrong number of bytes, and this module refuses
//! rather than reaching the backstop.

/// What a unit multiplies by: `value * multiplier / 10^shift`.
///
/// Two fields rather than one rational because every unit in the table
/// is one of these, exactly: a whole number of base units (`1h` is
/// 3600000 ms) or a whole fraction of one (`1%` is `1 / 10^2`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Factor {
    pub(crate) multiplier: u128,
    pub(crate) shift: u32,
}

impl Factor {
    pub(crate) const fn new(multiplier: u128, shift: u32) -> Self {
        Self { multiplier, shift }
    }
}

/// A decimal number: `(-1)^negative * mantissa / 10^scale`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Decimal {
    negative: bool,
    mantissa: u128,
    scale: u32,
}

/// The most digits a literal may carry, mantissa and fraction together.
///
/// `u128` holds 38 decimal digits. A literal longer than that is not a
/// quantity anyone wrote on purpose, and truncating it would be the one
/// thing this module exists to prevent.
const MAX_DIGITS: usize = 38;

impl Decimal {
    /// Parse a literal the lexer has already shaped: an optional sign,
    /// digits, an optional single decimal point.
    ///
    /// `None` means the literal does not fit, **not** that it was
    /// malformed — the caller has already checked the shape, and it
    /// reports a `None` here as an out-of-range refusal.
    pub(crate) fn parse(literal: &str) -> Option<Self> {
        let (negative, digits) = match literal.strip_prefix(['-', '+']) {
            Some(rest) => (literal.starts_with('-'), rest),
            None => (false, literal),
        };
        let (whole, fraction) = digits.split_once('.').unwrap_or((digits, ""));
        if whole.len() + fraction.len() > MAX_DIGITS {
            return None;
        }
        let mantissa: u128 = format!("{whole}{fraction}").parse().ok()?;
        Some(Self {
            negative,
            mantissa,
            scale: u32::try_from(fraction.len()).ok()?,
        })
    }

    /// Whether the value has a fractional part left after the scale is
    /// applied. `1.0` does not; `1.5` does.
    ///
    /// The distinction matters for bytes: `1.0KB` is a thousand bytes
    /// written oddly, and `1.5KB` is a category error.
    pub(crate) fn is_fractional(self) -> bool {
        let Some(divisor) = 10u128.checked_pow(self.scale) else {
            return true;
        };
        !self.mantissa.is_multiple_of(divisor)
    }

    /// Convert into base units. `None` on overflow.
    pub(crate) fn apply(self, factor: Factor) -> Option<Self> {
        Some(Self {
            negative: self.negative,
            mantissa: self.mantissa.checked_mul(factor.multiplier)?,
            scale: self.scale.checked_add(factor.shift)?,
        })
    }

    /// Add two values of the same sign — the compound-duration case,
    /// where `1h30m` is one quantity written in two parts.
    pub(crate) fn checked_add(self, other: Self) -> Option<Self> {
        let scale = self.scale.max(other.scale);
        let left = self.aligned(scale)?;
        let right = other.aligned(scale)?;
        Some(Self {
            negative: self.negative,
            mantissa: left.checked_add(right)?,
            scale,
        })
    }

    fn aligned(self, scale: u32) -> Option<u128> {
        let places = scale.checked_sub(self.scale)?;
        self.mantissa.checked_mul(10u128.checked_pow(places)?)
    }

    /// The value as text, in full, with no trailing zeros.
    ///
    /// Never exponential: a base value is read against a document by a
    /// person, and `5.4e6` is not what they are looking at. Never `-0`
    /// either, which is a distraction rather than a sign.
    pub(crate) fn render(self) -> String {
        let sign = if self.negative && self.mantissa != 0 {
            "-"
        } else {
            ""
        };
        let digits = self.mantissa.to_string();
        let scale = usize::try_from(self.scale).unwrap_or(usize::MAX);
        if scale == 0 {
            return format!("{sign}{digits}");
        }
        // A value smaller than one needs the zeros the mantissa does not
        // carry: `5 / 10^3` is `0.005`.
        let padded = format!("{:0>width$}", digits, width = scale + 1);
        let (whole, fraction) = padded.split_at(padded.len() - scale);
        let fraction = fraction.trim_end_matches('0');
        if fraction.is_empty() {
            return format!("{sign}{whole}");
        }
        format!("{sign}{whole}.{fraction}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parsed(literal: &str) -> Decimal {
        Decimal::parse(literal).expect("a literal the lexer shaped")
    }

    #[test]
    fn a_whole_number_renders_as_itself() {
        assert_eq!(parsed("30").render(), "30");
        assert_eq!(parsed("0").render(), "0");
        assert_eq!(parsed("-7").render(), "-7");
    }

    #[test]
    fn a_fraction_keeps_its_digits_and_drops_its_trailing_zeros() {
        assert_eq!(parsed("1.5").render(), "1.5");
        assert_eq!(parsed("1.500").render(), "1.5");
        assert_eq!(parsed("1.0").render(), "1");
        assert_eq!(parsed("0.0825").render(), "0.0825");
    }

    /// The reason this module exists rather than an `f64`. Through a
    /// double this is `100.00000000000001`.
    #[test]
    fn a_conversion_is_exact_where_a_double_would_not_be() {
        let tenth_of_a_second = parsed("0.1").apply(Factor::new(1_000_000_000, 6));
        assert_eq!(tenth_of_a_second.expect("in range").render(), "100");
    }

    #[test]
    fn a_value_below_one_keeps_its_leading_zeros() {
        let nanosecond = parsed("1").apply(Factor::new(1, 6)).expect("in range");
        assert_eq!(nanosecond.render(), "0.000001");
    }

    #[test]
    fn a_percentage_becomes_a_ratio() {
        let ratio = parsed("15").apply(Factor::new(1, 2)).expect("in range");
        assert_eq!(ratio.render(), "0.15");
    }

    #[test]
    fn a_fractional_value_is_told_from_a_fractionally_written_whole_one() {
        assert!(parsed("1.5").is_fractional());
        assert!(!parsed("1.0").is_fractional());
        assert!(!parsed("2").is_fractional());
    }

    #[test]
    fn parts_of_a_compound_add_exactly() {
        let hour = parsed("1")
            .apply(Factor::new(3_600_000_000_000, 6))
            .expect("in range");
        let half = parsed("30")
            .apply(Factor::new(60_000_000_000, 6))
            .expect("in range");
        assert_eq!(
            hour.checked_add(half).expect("in range").render(),
            "5400000"
        );
    }

    /// The refusal path, not the panic path: an overflow comes back as
    /// `None` and becomes a named refusal upstream.
    #[test]
    fn an_overflowing_conversion_refuses_rather_than_wrapping() {
        let huge = parsed("99999999999999999999999999999999999");
        assert!(huge.apply(Factor::new(1 << 50, 0)).is_none());
    }

    #[test]
    fn a_literal_longer_than_the_mantissa_does_not_parse() {
        assert!(Decimal::parse(&"9".repeat(MAX_DIGITS)).is_some());
        assert!(Decimal::parse(&"9".repeat(MAX_DIGITS + 1)).is_none());
    }

    /// A minus in front of a zero in a report is a reader's wasted
    /// minute.
    #[test]
    fn negative_zero_renders_as_zero() {
        assert_eq!(parsed("-0").render(), "0");
        assert_eq!(parsed("-0.00").render(), "0");
    }
}
