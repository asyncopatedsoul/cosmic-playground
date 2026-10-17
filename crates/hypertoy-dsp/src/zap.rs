//! Zap: tiny one-shot sound recipes that use the parameter layout of ZzFX
//! (Frank Force's MIT-licensed micro sound generator,
//! <https://github.com/KilledByAPixel/ZzFX>), so a recipe copied from the ZzFX
//! designer pastes straight in.
//!
//! This is an independent implementation, not a port: it renders per sample
//! from triggers so it follows the engine clock, it takes randomness from the
//! engine's seeded hash instead of `Math.random`, and the result sounds close
//! to ZzFX, not identical.
//!
//! Recipe slots (ZzFX order and defaults):
//! ```text
//!  0 volume 1          7 shapeCurve 1      14 modulation 0
//!  1 randomness .05    8 slide 0           15 bitCrush 0
//!  2 frequency 220     9 deltaSlide 0      16 delay 0
//!  3 attack 0         10 pitchJump 0       17 sustainVolume 1
//!  4 sustain 0        11 pitchJumpTime 0   18 decay 0
//!  5 release .1       12 repeatTime 0      19 tremolo 0
//!  6 shape 0          13 noise 0           20 filter 0
//! ```
//! Shapes: 0 sine, 1 triangle, 2 saw, 3 tan, 4 noisy sine (sin(t^2)).
//! `filter` > 0 is a highpass at that cutoff, < 0 a lowpass at |filter|.

use crate::Noise;
use core::f32::consts::{PI, TAU};

pub const RECIPE_LEN: usize = 21;
pub const DEFAULTS: [f32; RECIPE_LEN] = [
    1.0, 0.05, 220.0, 0.0, 0.0, 0.1, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0,
];
/// Recipe ranges, clamped on load so pasted recipes can't blow anything up.
const RANGES: [(f32, f32); RECIPE_LEN] = [
    (0.0, 2.0),       // volume
    (0.0, 1.0),       // randomness
    (0.0, 10_000.0),  // frequency
    (0.0, 3.0),       // attack
    (0.0, 3.0),       // sustain
    (0.0, 3.0),       // release
    (0.0, 4.0),       // shape
    (0.0, 10.0),      // shapeCurve
    (-100.0, 100.0),  // slide
    (-100.0, 100.0),  // deltaSlide
    (-5000.0, 5000.0), // pitchJump
    (0.0, 3.0),       // pitchJumpTime
    (0.0, 3.0),       // repeatTime
    (0.0, 10.0),      // noise
    (-100.0, 100.0),  // modulation
    (0.0, 1.0),       // bitCrush
    (0.0, 1.0),       // delay
    (0.0, 1.0),       // sustainVolume
    (0.0, 3.0),       // decay
    (0.0, 1.0),       // tremolo
    (-10_000.0, 10_000.0), // filter
];
const VOICES: usize = 3;
/// ZzFX's overall loudness.
const MASTER: f32 = 0.3;

pub fn sanitize(recipe: &[f32]) -> [f32; RECIPE_LEN] {
    core::array::from_fn(|i| {
        let v = recipe.get(i).copied().unwrap_or(DEFAULTS[i]);
        let (lo, hi) = RANGES[i];
        if v.is_finite() { v.clamp(lo, hi) } else { DEFAULTS[i] }
    })
}

#[derive(Clone, Copy, Default)]
struct Voice {
    live: bool,
    i: u32,
    len: u32,
    a: u32,
    d: u32,
    s: u32,
    phase: f32,
    /// Radians per sample.
    freq: f32,
    slide: f32,
    start_freq: f32,
    start_slide: f32,
    jump_at: u32,
    repeat: u32,
    held: f32,
    amp: f32,
    // 2-pole state-variable filter.
    f_lo: f32,
    f_band: f32,
}

#[derive(Clone)]
pub struct Zap {
    pub recipe: [f32; RECIPE_LEN],
    voices: [Voice; VOICES],
    next: usize,
    echo: Vec<f32>,
    echo_w: usize,
    noise: Noise,
    sr: f32,
}

impl Zap {
    pub fn new(sr: f32, seed: u32) -> Self {
        Zap {
            recipe: DEFAULTS,
            voices: [Voice::default(); VOICES],
            next: 0,
            echo: vec![0.0; sr as usize + 1],
            echo_w: 0,
            noise: Noise::new(seed),
            sr,
        }
    }

    pub fn set_recipe(&mut self, recipe: &[f32]) {
        self.recipe = sanitize(recipe);
    }

    /// Start a sound. `freq` overrides the recipe's frequency (e.g. a
    /// Tuning-snapped law frequency); `roll` in [0, 1) drives `randomness`.
    pub fn trigger(&mut self, vel: f32, freq: Option<f32>, roll: f32) {
        let r = &self.recipe;
        let sr = self.sr;
        let secs = |x: f32| (x * sr) as u32;
        let hz = freq.unwrap_or(r[2]).clamp(0.0, 10_000.0);
        let rand = 1.0 + r[1] * (2.0 * roll - 1.0);
        let f = hz * rand * TAU / sr;
        let slide = r[8] * 500.0 * TAU / (sr * sr);
        let (a, d, s, rel) = (secs(r[3]).max(9), secs(r[18]), secs(r[4]), secs(r[5]));
        let v = &mut self.voices[self.next];
        self.next = (self.next + 1) % VOICES;
        *v = Voice {
            live: true,
            len: a + d + s + rel,
            a,
            d,
            s,
            freq: f,
            slide,
            start_freq: f,
            start_slide: slide,
            jump_at: secs(r[11]),
            repeat: secs(r[12]),
            amp: vel.clamp(0.0, 1.0) * r[0] * MASTER,
            ..Voice::default()
        };
    }

    #[inline]
    pub fn tick(&mut self) -> f32 {
        let r = self.recipe;
        let sr = self.sr;
        let delta_slide = r[9] * 500.0 * TAU / (sr * sr * sr);
        let jump = r[10] * TAU / sr;
        let crush_hold = (r[15] * 100.0) as u32;
        let mod_rate = r[14] * TAU / sr;
        // Filter coefficient (Chamberlin SVF), fixed per recipe.
        let cutoff = r[20].abs().clamp(10.0, sr * 0.2);
        let fc = 2.0 * (PI * cutoff / sr).sin();
        let mut sum = 0.0;
        for v in self.voices.iter_mut().filter(|v| v.live) {
            let i = v.i;
            // Wave.
            let t = v.phase;
            let mut w = match r[6] as u32 {
                1 => 1.0 - 4.0 * ((t / TAU).round() - t / TAU).abs(),
                2 => 1.0 - ((2.0 * t / TAU).rem_euclid(2.0)),
                3 => t.tan().clamp(-1.0, 1.0),
                4 => (t * t).sin(),
                _ => t.sin(),
            };
            w = w.signum() * w.abs().powf(r[7]);
            // Envelope: attack, decay to sustainVolume, sustain, release.
            let sv = r[17];
            let env = if i < v.a {
                i as f32 / v.a as f32
            } else if i < v.a + v.d {
                1.0 - (i - v.a) as f32 / v.d.max(1) as f32 * (1.0 - sv)
            } else if i < v.a + v.d + v.s {
                sv
            } else {
                sv * (1.0 - (i - v.a - v.d - v.s) as f32 / (v.len - v.a - v.d - v.s).max(1) as f32)
            };
            let trem = if v.repeat > 0 { 1.0 - r[19] + r[19] * (TAU * i as f32 / v.repeat as f32).sin() } else { 1.0 };
            let mut y = w * env * trem;
            // Bit crush: sample-and-hold.
            if crush_hold > 1 {
                if i % crush_hold == 0 {
                    v.held = y;
                }
                y = v.held;
            }
            // Filter.
            if r[20] != 0.0 {
                let hi = y - v.f_lo - 0.5 * v.f_band;
                v.f_band += fc * hi;
                v.f_lo += fc * v.f_band;
                y = if r[20] > 0.0 { hi } else { v.f_lo };
            }
            sum += y * v.amp;
            // Pitch: slide, modulation, noise.
            v.slide += delta_slide;
            v.freq += v.slide;
            let f = v.freq * (mod_rate * i as f32).cos();
            v.phase += f * (1.0 + r[13] * self.noise.next());
            v.phase = v.phase.rem_euclid(TAU * 64.0);
            v.i += 1;
            if v.jump_at > 0 && i == v.jump_at {
                v.freq += jump;
            }
            if v.repeat > 0 && v.i % v.repeat == 0 {
                v.freq = v.start_freq;
                v.slide = v.start_slide;
            }
            if v.i >= v.len {
                v.live = false;
            }
        }
        // Echo.
        let delay = (r[16] * sr) as usize;
        if delay > 0 && delay < self.echo.len() {
            let len = self.echo.len();
            let wet = self.echo[(self.echo_w + len - delay) % len];
            self.echo[self.echo_w] = sum;
            self.echo_w = (self.echo_w + 1) % len;
            sum += wet * 0.5;
        }
        if sum.is_finite() { sum } else { 0.0 }
    }

    pub fn active(&self) -> bool {
        self.voices.iter().any(|v| v.live)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn play(recipe: &[f32], secs: f32) -> Vec<f32> {
        let mut z = Zap::new(48_000.0, 1);
        z.set_recipe(recipe);
        z.trigger(1.0, None, 0.5);
        (0..(secs * 48_000.0) as usize).map(|_| z.tick()).collect()
    }

    #[test]
    fn default_recipe_is_a_short_blip_at_220() {
        let out = play(&[], 0.5);
        let peak = out.iter().fold(0.0f32, |m, x| m.max(x.abs()));
        assert!(peak > 0.2 && peak <= 0.31, "{peak}");
        // 0.1 s release, then silence.
        assert!(out[6_000..].iter().all(|&x| x == 0.0));
        let crossings = out[..4_000].windows(2).filter(|w| w[0] <= 0.0 && w[1] > 0.0).count();
        let hz = crossings as f32 * 48_000.0 / 4_000.0;
        assert!((hz - 220.0).abs() < 15.0, "{hz}");
    }

    #[test]
    fn freq_override_and_slide() {
        let mut z = Zap::new(48_000.0, 1);
        z.trigger(1.0, Some(880.0), 0.5);
        let out: Vec<f32> = (0..2_400).map(|_| z.tick()).collect();
        let crossings = out.windows(2).filter(|w| w[0] <= 0.0 && w[1] > 0.0).count();
        assert!((crossings as f32 * 20.0 - 880.0).abs() < 45.0);
        // An upward slide ends higher than it starts.
        let up = play(&[1.0, 0.0, 220.0, 0.0, 0.3, 0.0, 0.0, 1.0, 20.0], 0.3);
        let early = up[..2_400].windows(2).filter(|w| w[0] <= 0.0 && w[1] > 0.0).count();
        let late = up[12_000..14_400].windows(2).filter(|w| w[0] <= 0.0 && w[1] > 0.0).count();
        assert!(late > early * 2, "{early} -> {late}");
    }

    #[test]
    fn wild_recipes_stay_finite_and_bounded() {
        let wild = [2.0, 1.0, 9999.0, 0.0, 3.0, 3.0, 3.0, 0.0, 100.0, 100.0, 5000.0, 0.1, 0.05, 10.0, 100.0, 1.0, 0.9, 1.0, 0.0, 1.0, -50.0];
        let out = play(&wild, 1.0);
        assert!(out.iter().all(|x| x.is_finite() && x.abs() < 4.0));
        let junk = sanitize(&[f32::NAN, f32::INFINITY, -1.0]);
        assert_eq!((junk[0], junk[1], junk[2]), (1.0, 0.05, 0.0));
    }

    #[test]
    fn same_roll_same_sound() {
        let a = play(&[1.0, 0.5], 0.2);
        assert_eq!(a, play(&[1.0, 0.5], 0.2));
    }
}
