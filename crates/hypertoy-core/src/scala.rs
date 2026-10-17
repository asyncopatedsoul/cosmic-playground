//! Scala (`.scl`) scale files: the format of the Huygens-Fokker archive of
//! thousands of tunings. The last pitch listed is the period (usually 2/1).
//!
//! Format: `!` lines are comments; the first other line is a description,
//! the next is the number of pitches, then one pitch per line. A pitch with a
//! `.` is in cents; otherwise it is a ratio `a/b` or a whole number `a`.
//! Anything after the pitch on a line is ignored.

use crate::tuning::{Table, MAX_TONES};

#[derive(Debug, PartialEq, Eq)]
pub enum ScalaError {
    MissingCount,
    BadCount,
    BadPitch(usize),
    WrongCount,
    BadTable,
}

/// Parse `.scl` text into a [`Table`].
pub fn parse(text: &str) -> Result<Table, ScalaError> {
    let mut lines = text.lines().map(str::trim).filter(|l| !l.starts_with('!'));
    // The description line may be blank, so take it before skipping blanks.
    lines.next().ok_or(ScalaError::MissingCount)?;
    let mut lines = lines.filter(|l| !l.is_empty());
    let count: usize = first_token(lines.next().ok_or(ScalaError::MissingCount)?)
        .parse()
        .map_err(|_| ScalaError::BadCount)?;
    if count == 0 || count > MAX_TONES {
        return Err(ScalaError::BadCount);
    }
    let mut tones = [0.0f32; MAX_TONES];
    let mut n = 0;
    for line in lines.by_ref().take(count) {
        tones[n] = pitch_cents(first_token(line)).ok_or(ScalaError::BadPitch(n + 1))?;
        n += 1;
    }
    if n != count {
        return Err(ScalaError::WrongCount);
    }
    let period = tones[n - 1];
    Table::from_cents(&tones[..n - 1], period).ok_or(ScalaError::BadTable)
}

fn first_token(line: &str) -> &str {
    line.split_whitespace().next().unwrap_or("")
}

fn pitch_cents(tok: &str) -> Option<f32> {
    if tok.contains('.') {
        return tok.parse::<f32>().ok().filter(|c| c.is_finite());
    }
    let (a, b) = match tok.split_once('/') {
        Some((a, b)) => (a.parse::<f64>().ok()?, b.parse::<f64>().ok()?),
        None => (tok.parse::<f64>().ok()?, 1.0),
    };
    if a <= 0.0 || b <= 0.0 {
        return None;
    }
    Some((1200.0 * (a / b).log2()) as f32)
}

#[cfg(test)]
mod tests {
    use super::*;

    const MEANTONE: &str = "! meanquar.scl
!
1/4-comma meantone scale. Pietro Aaron's temperament (1523)
 12
!
 76.04900
 193.15686
 310.26471
 5/4
 503.42157
 579.47057
 696.57843
 25/16
 889.73529
 1006.84314
 1082.89214
 2/1
";

    #[test]
    fn parses_meantone() {
        let t = parse(MEANTONE).unwrap();
        assert_eq!(t.tones().len(), 12);
        assert!((t.period - 1200.0).abs() < 1e-3);
        assert!((t.tones()[4] - 386.3137).abs() < 1e-3); // 5/4
        assert!((t.tones()[1] - 76.049).abs() < 1e-3);
    }

    #[test]
    fn tritave_period_and_trailing_text() {
        let t = parse("Bohlen-Pierce\n2\n27/25 first step\n3/1 tritave\n").unwrap();
        assert!((t.period - 1901.955).abs() < 1e-2);
        assert_eq!(t.tones().len(), 2);
    }

    #[test]
    fn errors() {
        assert_eq!(parse(""), Err(ScalaError::MissingCount));
        assert_eq!(parse("x\nmany\n"), Err(ScalaError::BadCount));
        assert_eq!(parse("x\n2\n3/2\n"), Err(ScalaError::WrongCount));
        assert_eq!(parse("x\n1\n-3/2\n"), Err(ScalaError::BadPitch(1)));
    }
}
