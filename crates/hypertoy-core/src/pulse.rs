//! Pulse v1: a ring of up to 16 steps, each with a probability, played at a
//! musical rate (steps per beat). Patterns are edited by shape in the UI; a
//! Euclidean preset is just one way to fill the ring.

use crate::rng;

pub const MAX_STEPS: usize = 16;

#[derive(Clone, Debug)]
pub struct Pulse {
    pub enabled: bool,
    pub steps: usize,
    pub prob: [f32; MAX_STEPS],
    /// 1 = quarter notes, 2 = eighths, 3 = eighth triplets, 4 = sixteenths.
    pub steps_per_beat: f64,
    last_index: i64,
}

impl Default for Pulse {
    fn default() -> Self {
        let mut p = Pulse {
            enabled: false,
            steps: 8,
            prob: [0.0; MAX_STEPS],
            steps_per_beat: 2.0,
            last_index: i64::MIN,
        };
        p.set_euclid(3, 8);
        p
    }
}

impl Pulse {
    pub fn set_euclid(&mut self, hits: usize, steps: usize) {
        self.steps = steps.clamp(1, MAX_STEPS);
        let pattern = euclid(hits, self.steps);
        for (i, p) in self.prob.iter_mut().enumerate() {
            *p = if pattern[i] { 1.0 } else { 0.0 };
        }
    }

    /// Step index (unwrapped) of the most recent step boundary.
    pub fn counter(&self) -> i64 {
        self.last_index
    }

    /// Current position on the ring.
    pub fn current_step(&self) -> usize {
        if self.last_index == i64::MIN {
            0
        } else {
            self.last_index.rem_euclid(self.steps as i64) as usize
        }
    }

    /// Call once per sample with the clock's beat. Returns the ring step when a
    /// new step begins and it fires (after its probability roll).
    #[inline]
    pub fn tick(&mut self, beat: f64, seed: u64) -> Option<usize> {
        let idx = (beat * self.steps_per_beat).floor() as i64;
        if idx == self.last_index {
            return None;
        }
        self.last_index = idx;
        if !self.enabled {
            return None;
        }
        let step = idx.rem_euclid(self.steps as i64) as usize;
        let p = self.prob[step];
        if p <= 0.0 {
            None
        } else if p >= 1.0 || rng::unit(rng::hash3(seed, idx as u64, 0x5EED)) < p {
            Some(step)
        } else {
            None
        }
    }
}

/// Evenly spread `hits` over `steps` (Bjorklund-equivalent, rotated so step 0 hits).
pub fn euclid(hits: usize, steps: usize) -> [bool; MAX_STEPS] {
    let mut out = [false; MAX_STEPS];
    let steps = steps.clamp(1, MAX_STEPS);
    let hits = hits.min(steps);
    for (i, slot) in out.iter_mut().enumerate().take(steps) {
        *slot = (i * hits) % steps < hits;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pattern_str(hits: usize, steps: usize) -> String {
        euclid(hits, steps)[..steps]
            .iter()
            .map(|&b| if b { 'x' } else { '.' })
            .collect()
    }

    #[test]
    fn euclid_tresillo_and_cinquillo() {
        assert_eq!(pattern_str(3, 8), "x..x..x.");
        assert_eq!(pattern_str(5, 8), "x.x.xx.x"); // a rotation of cinquillo
        assert_eq!(pattern_str(4, 16), "x...x...x...x...");
    }

    #[test]
    fn fires_three_times_per_bar_of_tresillo() {
        let mut p = Pulse { enabled: true, ..Default::default() };
        // 8 eighth-note steps = 4 beats. Sample the clock finely.
        let mut fired = 0;
        let n = 4000;
        for i in 0..n {
            if p.tick(i as f64 * 4.0 / n as f64, 1).is_some() {
                fired += 1;
            }
        }
        assert_eq!(fired, 3);
    }

    #[test]
    fn probability_is_deterministic() {
        let run = || {
            let mut p = Pulse { enabled: true, ..Default::default() };
            p.prob = [0.5; MAX_STEPS];
            (0..1600).filter(|&i| p.tick(i as f64 / 100.0, 42).is_some()).count()
        };
        let a = run();
        assert_eq!(a, run());
        assert!(a > 0 && a < 32);
    }
}
