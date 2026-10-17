//! Pulse: a toy's automation heart. Either a ring of up to 16 steps, each with
//! a probability, played at a musical rate (steps per beat), or a scripted
//! [`Pattern`] in mini-notation. Patterns are edited by shape in the UI; a
//! Euclidean preset is just one way to fill the ring.
//!
//! A scripted pattern's cycle lasts as long as the ring would
//! (`steps / steps_per_beat` beats), so the rate controls still apply.

use crate::pattern::{Event, Pattern, MAX_EVENTS};
use crate::rng;

pub const MAX_STEPS: usize = 16;

/// One firing of the Pulse.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Hit {
    /// Ring step, or the event's index within its cycle for a pattern.
    pub step: usize,
    /// 0..1. Ring steps fire at 1; patterns carry their own velocity.
    pub vel: f32,
    /// Scale degree from a pattern like `"0 2 4"`; `None` for plain triggers.
    pub degree: Option<f32>,
}

#[derive(Clone, Debug)]
pub struct Pulse {
    pub enabled: bool,
    pub steps: usize,
    pub prob: [f32; MAX_STEPS],
    /// 1 = quarter notes, 2 = eighths, 3 = eighth triplets, 4 = sixteenths.
    pub steps_per_beat: f64,
    last_index: i64,
    pattern: Option<Pattern>,
    events: [Event; MAX_EVENTS],
    n_events: usize,
    next_event: usize,
    cycle: i64,
    last_event: usize,
}

impl Default for Pulse {
    fn default() -> Self {
        let mut p = Pulse {
            enabled: false,
            steps: 8,
            prob: [0.0; MAX_STEPS],
            steps_per_beat: 2.0,
            last_index: i64::MIN,
            pattern: None,
            events: [Event::EMPTY; MAX_EVENTS],
            n_events: 0,
            next_event: 0,
            cycle: i64::MIN,
            last_event: 0,
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

    /// Replace the ring with a scripted pattern, or go back to the ring with `None`.
    pub fn set_pattern(&mut self, pattern: Option<Pattern>) {
        self.pattern = pattern;
        self.cycle = i64::MIN;
        self.n_events = 0;
        self.next_event = 0;
        self.last_event = 0;
    }

    pub fn is_scripted(&self) -> bool {
        self.pattern.is_some()
    }

    /// Step index (unwrapped) of the most recent step boundary.
    pub fn counter(&self) -> i64 {
        self.last_index
    }

    /// Current position on the ring (or within the pattern's cycle).
    pub fn current_step(&self) -> usize {
        if self.pattern.is_some() {
            self.last_event
        } else if self.last_index == i64::MIN {
            0
        } else {
            self.last_index.rem_euclid(self.steps as i64) as usize
        }
    }

    /// Length of one cycle in beats.
    pub fn cycle_beats(&self) -> f64 {
        self.steps as f64 / self.steps_per_beat.max(0.01)
    }

    /// Call once per sample with the clock's beat. Returns a [`Hit`] when a
    /// step or event begins and it fires (after its probability roll).
    #[inline]
    pub fn tick(&mut self, beat: f64, seed: u64) -> Option<Hit> {
        if self.pattern.is_some() {
            return self.tick_pattern(beat, seed);
        }
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
        let hit = Hit { step, vel: 1.0, degree: None };
        if p <= 0.0 {
            None
        } else if p >= 1.0 || rng::unit(rng::hash3(seed, idx as u64, 0x5EED)) < p {
            Some(hit)
        } else {
            None
        }
    }

    fn tick_pattern(&mut self, beat: f64, seed: u64) -> Option<Hit> {
        let pos = beat / self.cycle_beats();
        let cycle = pos.floor() as i64;
        if cycle != self.cycle {
            let first = self.cycle == i64::MIN;
            self.cycle = cycle;
            self.n_events = self.pattern.as_ref().unwrap().query(cycle, &mut self.events);
            self.next_event = 0;
            // Joining mid-cycle: skip what already passed.
            if first {
                while self.next_event < self.n_events && self.events[self.next_event].onset < pos - 1e-9 {
                    self.next_event += 1;
                }
            }
        }
        while self.next_event < self.n_events && self.events[self.next_event].onset <= pos {
            let i = self.next_event;
            let e = self.events[i];
            self.next_event += 1;
            self.last_event = i;
            if !self.enabled {
                continue;
            }
            // Key the roll by onset time so every client agrees.
            let key = (e.onset * 65_536.0).round() as i64 as u64;
            if e.chance < 1.0 && rng::unit(rng::hash3(seed, key, 0xC4A)) >= e.chance {
                continue;
            }
            let degree = if e.value.is_nan() { None } else { Some(e.value) };
            return Some(Hit { step: i, vel: e.vel, degree });
        }
        None
    }
}

/// Evenly spread `hits` over `steps` (Bjorklund-equivalent, rotated so step 0 hits).
pub fn euclid(hits: usize, steps: usize) -> [bool; MAX_STEPS] {
    let mut out = [false; MAX_STEPS];
    let steps = steps.clamp(1, MAX_STEPS);
    let on = euclid_n(hits, steps);
    for (i, slot) in out.iter_mut().enumerate().take(steps) {
        *slot = on(i);
    }
    out
}

/// Euclidean membership test for any length: is step `i` a hit?
pub fn euclid_n(hits: usize, steps: usize) -> impl Fn(usize) -> bool {
    let steps = steps.max(1);
    let hits = hits.min(steps);
    move |i| (i * hits) % steps < hits
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

    fn hits(src: &str, beats: f64, seed: u64) -> Vec<(f64, Hit)> {
        let mut p = Pulse { enabled: true, ..Default::default() };
        p.set_pattern(Some(Pattern::parse(src).unwrap()));
        let n = (beats * 1000.0) as usize;
        (0..n)
            .filter_map(|i| {
                let beat = i as f64 / 1000.0;
                p.tick(beat, seed).map(|h| ((beat * 1000.0).round() / 1000.0, h))
            })
            .collect()
    }

    #[test]
    fn pattern_plays_on_the_ring_cycle() {
        // Default ring: 8 steps at 2 per beat = a 4-beat cycle.
        let h = hits("x . x [x x]", 8.0, 1);
        let beats: Vec<f64> = h.iter().map(|x| x.0).collect();
        assert_eq!(beats, [0.0, 2.0, 3.0, 3.5, 4.0, 6.0, 7.0, 7.5]);
        assert_eq!(h[0].1.vel, 0.8);
    }

    #[test]
    fn pattern_degrees_and_deterministic_chance() {
        let h = hits("0 2 <4 7> 9", 8.0, 1);
        let d: Vec<f32> = h.iter().map(|x| x.1.degree.unwrap()).collect();
        assert_eq!(d, [0.0, 2.0, 4.0, 9.0, 0.0, 2.0, 7.0, 9.0]);
        let a = hits("x*8?", 40.0, 9);
        assert_eq!(a, hits("x*8?", 40.0, 9));
        assert!(a.len() > 20 && a.len() < 60, "{}", a.len());
        assert_ne!(a, hits("x*8?", 40.0, 10));
    }

    #[test]
    fn joining_mid_cycle_skips_past_events() {
        let mut p = Pulse { enabled: true, ..Default::default() };
        p.set_pattern(Some(Pattern::parse("x x x x").unwrap()));
        let fired = (2500..4000).filter(|&i| p.tick(i as f64 / 1000.0, 0).is_some()).count();
        assert_eq!(fired, 1); // only the event at beat 3
    }

    #[test]
    fn back_to_the_ring() {
        let mut p = Pulse { enabled: true, ..Default::default() };
        p.set_pattern(Some(Pattern::parse("x").unwrap()));
        assert!(p.is_scripted());
        p.set_pattern(None);
        let fired = (0..4000).filter(|&i| p.tick(i as f64 / 1000.0, 1).is_some()).count();
        assert_eq!(fired, 3);
    }
}
