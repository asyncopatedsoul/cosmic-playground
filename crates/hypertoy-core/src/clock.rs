/// A beat clock advanced once per audio sample. Beat position is the single
/// musical time base: Pulses, orbits and visuals all read it.
#[derive(Clone, Debug)]
pub struct Clock {
    pub sample_rate: f64,
    pub bpm: f64,
    pub beat: f64,
}

impl Clock {
    pub fn new(sample_rate: f64, bpm: f64) -> Self {
        Clock { sample_rate, bpm, beat: 0.0 }
    }

    /// Beats that elapse during one sample.
    #[inline]
    pub fn beats_per_sample(&self) -> f64 {
        self.bpm / 60.0 / self.sample_rate
    }

    #[inline]
    pub fn advance(&mut self) {
        self.beat += self.beats_per_sample();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn one_second_at_120_bpm_is_two_beats() {
        let mut c = Clock::new(48_000.0, 120.0);
        for _ in 0..48_000 {
            c.advance();
        }
        assert!((c.beat - 2.0).abs() < 1e-6);
    }
}
