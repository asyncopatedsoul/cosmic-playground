//! The world's Tuning. Pitches that come from physics snap to the nearest
//! scale tone, so there are no wrong notes by default; `wild` turns snapping off.

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

#[derive(Clone, Debug)]
pub struct Tuning {
    pub root_hz: f32,
    pub scale: Scale,
    pub wild: bool,
}

pub fn midi_to_hz(midi: f32) -> f32 {
    440.0 * 2f32.powf((midi - 69.0) / 12.0)
}

impl Default for Tuning {
    fn default() -> Self {
        Tuning { root_hz: midi_to_hz(60.0), scale: Scale::MajorPentatonic, wild: false }
    }
}

impl Tuning {
    /// Snap a frequency to the nearest scale tone (any octave). Identity when wild.
    pub fn snap(&self, hz: f32) -> f32 {
        if self.wild || hz <= 0.0 {
            return hz;
        }
        let cents = 1200.0 * (hz / self.root_hz).log2();
        let octave = (cents / 1200.0).floor();
        let within = cents - octave * 1200.0;
        let mut best = 0.0;
        let mut best_d = f32::MAX;
        for &s in self.scale.cents().iter().chain(core::iter::once(&1200.0)) {
            let d = (within - s).abs();
            if d < best_d {
                best_d = d;
                best = s;
            }
        }
        self.root_hz * 2f32.powf(octave + best / 1200.0)
    }

    /// Frequency of scale degree `deg` (0 = root; wraps into higher/lower octaves).
    pub fn degree(&self, deg: i32) -> f32 {
        let cents = self.scale.cents();
        let n = cents.len() as i32;
        let octave = deg.div_euclid(n);
        let idx = deg.rem_euclid(n) as usize;
        self.root_hz * 2f32.powf(octave as f32 + cents[idx] / 1200.0)
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
        let t = Tuning { scale: Scale::JustPentatonic, ..Default::default() };
        assert!(close(t.degree(3) / t.degree(0), 1.5));
    }
}
