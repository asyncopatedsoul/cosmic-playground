//! The world's Tuning. Pitches that come from physics snap to the nearest
//! scale tone, so there are no wrong notes by default; `wild` turns snapping off.
//!
//! A Tuning is a root plus a [`Table`]: scale tones in cents within a period
//! (1200 cents for octave scales). Presets come from [`Scale`]; any other
//! table (Tonal-built, n-EDO, a Scala file) is loaded with [`Table::from_cents`].

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Scale {
    MajorPentatonic,
    MinorPentatonic,
    /// Pentatonic from the harmonic series: 1, 9/8, 5/4, 3/2, 5/3.
    JustPentatonic,
    Major,
    Dorian,
    Chromatic,
}

impl Scale {
    pub fn from_id(id: u32) -> Scale {
        match id {
            1 => Scale::MinorPentatonic,
            2 => Scale::JustPentatonic,
            3 => Scale::Major,
            4 => Scale::Dorian,
            5 => Scale::Chromatic,
            _ => Scale::MajorPentatonic,
        }
    }

    /// Scale tones in cents above the root, within one octave.
    pub fn cents(self) -> &'static [f32] {
        match self {
            Scale::MajorPentatonic => &[0.0, 200.0, 400.0, 700.0, 900.0],
            Scale::MinorPentatonic => &[0.0, 300.0, 500.0, 700.0, 1000.0],
            Scale::JustPentatonic => &[0.0, 203.91, 386.31, 701.96, 884.36],
            Scale::Major => &[0.0, 200.0, 400.0, 500.0, 700.0, 900.0, 1100.0],
            Scale::Dorian => &[0.0, 200.0, 300.0, 500.0, 700.0, 900.0, 1000.0],
            Scale::Chromatic => &[
                0.0, 100.0, 200.0, 300.0, 400.0, 500.0, 600.0, 700.0, 800.0, 900.0, 1000.0, 1100.0,
            ],
        }
    }
}

/// Most tones a table holds (enough for 53-EDO plus headroom).
pub const MAX_TONES: usize = 64;

/// Scale tones in cents, ascending from 0, within `period` cents.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Table {
    cents: [f32; MAX_TONES],
    len: usize,
    pub period: f32,
}

impl Table {
    pub fn from_scale(s: Scale) -> Table {
        Table::from_cents(s.cents(), 1200.0).expect("presets are valid")
    }

    /// Build a table from tones (cents above the root) and a period. Tones are
    /// folded into [0, period), sorted and de-duplicated; the root is always included.
    pub fn from_cents(tones: &[f32], period: f32) -> Option<Table> {
        if !period.is_finite() || period < 10.0 || period > 4800.0 {
            return None;
        }
        let mut t = Table { cents: [0.0; MAX_TONES], len: 1, period };
        for &c in tones {
            if !c.is_finite() {
                return None;
            }
            let c = c.rem_euclid(period);
            if t.len < MAX_TONES && !t.tones().iter().any(|&x| (x - c).abs() < 0.01) {
                t.cents[t.len] = c;
                t.len += 1;
            }
        }
        t.cents[..t.len].sort_by(|a, b| a.partial_cmp(b).unwrap());
        Some(t)
    }

    /// `n` equal divisions of the octave.
    pub fn edo(n: usize) -> Option<Table> {
        if n == 0 || n > MAX_TONES {
            return None;
        }
        let tones: [f32; MAX_TONES] = core::array::from_fn(|i| i as f32 * 1200.0 / n as f32);
        Table::from_cents(&tones[..n], 1200.0)
    }

    pub fn tones(&self) -> &[f32] {
        &self.cents[..self.len]
    }
}

#[derive(Clone, Debug)]
pub struct Tuning {
    pub root_hz: f32,
    pub table: Table,
    pub wild: bool,
}

pub fn midi_to_hz(midi: f32) -> f32 {
    440.0 * 2f32.powf((midi - 69.0) / 12.0)
}

impl Default for Tuning {
    fn default() -> Self {
        Tuning::new(midi_to_hz(60.0), Scale::MajorPentatonic, false)
    }
}

impl Tuning {
    pub fn new(root_hz: f32, scale: Scale, wild: bool) -> Self {
        Tuning { root_hz, table: Table::from_scale(scale), wild }
    }

    /// Snap a frequency to the nearest scale tone (any period). Identity when wild.
    pub fn snap(&self, hz: f32) -> f32 {
        if self.wild || hz <= 0.0 || !hz.is_finite() {
            return hz;
        }
        let period = self.table.period;
        let cents = 1200.0 * (hz / self.root_hz).log2();
        let k = (cents / period).floor();
        let within = cents - k * period;
        let mut best = 0.0;
        let mut best_d = f32::MAX;
        for &s in self.table.tones().iter().chain(core::iter::once(&period)) {
            let d = (within - s).abs();
            if d < best_d {
                best_d = d;
                best = s;
            }
        }
        self.root_hz * 2f32.powf((k * period + best) / 1200.0)
    }

    /// Frequency of scale degree `deg` (0 = root; wraps into higher/lower periods).
    pub fn degree(&self, deg: i32) -> f32 {
        let tones = self.table.tones();
        let n = tones.len() as i32;
        let k = deg.div_euclid(n);
        let idx = deg.rem_euclid(n) as usize;
        self.root_hz * 2f32.powf((k as f32 * self.table.period + tones[idx]) / 1200.0)
    }

    /// The scale degree whose tone is nearest `hz` (ignores `wild`).
    pub fn nearest_degree(&self, hz: f32) -> i32 {
        if hz <= 0.0 || !hz.is_finite() {
            return 0;
        }
        let tones = self.table.tones();
        let n = tones.len() as i32;
        let cents = 1200.0 * (hz / self.root_hz).log2();
        let k = (cents / self.table.period).floor() as i32;
        let within = cents - k as f32 * self.table.period;
        let mut best = (0, f32::MAX);
        for (i, &s) in tones.iter().chain(core::iter::once(&self.table.period)).enumerate() {
            let d = (within - s).abs();
            if d < best.1 {
                best = (i as i32, d);
            }
        }
        k * n + best.0
    }

    /// `hz` moved by `steps` scale degrees (from its nearest degree).
    pub fn transpose(&self, hz: f32, steps: f32) -> f32 {
        self.degree(self.nearest_degree(hz) + steps.round() as i32)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn close(a: f32, b: f32) -> bool {
        (a - b).abs() / b < 1e-3
    }

    #[test]
    fn snaps_to_pentatonic() {
        let t = Tuning::default(); // C major pentatonic
        // F4 (349.2) is not in the scale; E4 (329.6) and G4 (392.0) are.
        let f = t.snap(midi_to_hz(65.0));
        assert!(close(f, midi_to_hz(64.0)) || close(f, midi_to_hz(67.0)));
        // Already in scale stays put, across octaves.
        assert!(close(t.snap(midi_to_hz(43.0)), midi_to_hz(43.0)));
        assert!(close(t.snap(midi_to_hz(81.0)), midi_to_hz(81.0)));
    }

    #[test]
    fn wild_does_not_snap() {
        let t = Tuning { wild: true, ..Default::default() };
        assert_eq!(t.snap(333.0), 333.0);
    }

    #[test]
    fn degrees_wrap_octaves() {
        let t = Tuning::default();
        assert!(close(t.degree(0), midi_to_hz(60.0)));
        assert!(close(t.degree(5), midi_to_hz(72.0)));
        assert!(close(t.degree(-5), midi_to_hz(48.0)));
    }

    #[test]
    fn just_fifth_is_three_halves() {
        let t = Tuning::new(midi_to_hz(60.0), Scale::JustPentatonic, false);
        assert!(close(t.degree(3) / t.degree(0), 1.5));
    }

    #[test]
    fn nearest_degree_and_transpose() {
        let t = Tuning::default();
        assert_eq!(t.nearest_degree(midi_to_hz(60.0)), 0);
        assert_eq!(t.nearest_degree(midi_to_hz(71.9)), 5); // just under C5 rounds up to the octave
        assert_eq!(t.nearest_degree(midi_to_hz(48.0)), -5);
        assert!(close(t.transpose(midi_to_hz(60.0), 2.0), midi_to_hz(64.0)));
    }

    #[test]
    fn edo_31_steps_and_snaps() {
        let t = Tuning { table: Table::edo(31).unwrap(), ..Default::default() };
        assert_eq!(t.table.tones().len(), 31);
        assert!(close(t.degree(31), t.root_hz * 2.0));
        let step = 2f32.powf(1.0 / 31.0);
        assert!(close(t.snap(t.root_hz * step * 1.002), t.root_hz * step));
    }

    #[test]
    fn non_octave_period() {
        // Bohlen-Pierce: 13 equal steps of the tritave (3:1, ~1901.96 cents).
        let bp = 1200.0 * 3f32.log2();
        let tones: Vec<f32> = (0..13).map(|i| i as f32 * bp / 13.0).collect();
        let t = Tuning { table: Table::from_cents(&tones, bp).unwrap(), ..Default::default() };
        assert!(close(t.degree(13), t.root_hz * 3.0));
    }

    #[test]
    fn table_folds_sorts_and_dedups() {
        let t = Table::from_cents(&[700.0, 1400.0, -500.0, 0.0, 700.0], 1200.0).unwrap();
        assert_eq!(t.tones(), &[0.0, 200.0, 700.0]);
        assert!(Table::from_cents(&[f32::NAN], 1200.0).is_none());
        assert!(Table::from_cents(&[], 0.0).is_none());
    }
}
