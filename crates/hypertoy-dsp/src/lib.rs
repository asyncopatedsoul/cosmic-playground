//! hypertoy-dsp: allocation-free audio nodes. Every buffer is allocated in
//! `new`; nothing in a `tick` allocates, so these are safe in the audio callback.
//!
//! - The nodes below: our hand-tuned string, bell, bubble, filter, reverb, limiter.
//! - [`units`]: the same nodes wrapped for fundsp graphs.
//! - [`patch`]: allow-listed node graphs built into a fundsp `Net` (patch voices).
//! - [`zap`]: ZzFX-compatible one-shot sound recipes.

pub mod patch;
pub mod units;
pub mod zap;

use core::f32::consts::{PI, TAU};

/// Tiny offset that keeps feedback paths out of subnormal range.
const ANTI_DENORMAL: f32 = 1e-18;

#[derive(Clone, Copy, Debug, Default)]
pub struct Noise(u32);

impl Noise {
    pub fn new(seed: u32) -> Self {
        Noise(seed.max(1))
    }

    /// White noise in [-1, 1].
    #[inline]
    pub fn next(&mut self) -> f32 {
        let mut x = self.0;
        x ^= x << 13;
        x ^= x >> 17;
        x ^= x << 5;
        self.0 = x;
        (x as f32 / u32::MAX as f32) * 2.0 - 1.0
    }
}

pub const PLUCK_MAX: usize = 4096;

/// Karplus-Strong plucked string. Re-plucking adds energy to the ringing
/// string instead of cutting it, like plucking a real one.
#[derive(Clone)]
pub struct Pluck {
    buf: Vec<f32>,
    w: usize,
    delay: f32,
    feedback: f32,
    lp: f32,
    lp_a: f32,
    exc_left: u32,
    exc_amp: f32,
    exc_lp: f32,
    exc_a: f32,
    noise: Noise,
    sr: f32,
}

impl Pluck {
    pub fn new(sr: f32, seed: u32) -> Self {
        Pluck {
            buf: vec![0.0; PLUCK_MAX],
            w: 0,
            delay: 100.0,
            feedback: 0.99,
            lp: 0.0,
            lp_a: 0.6,
            exc_left: 0,
            exc_amp: 0.0,
            exc_lp: 0.0,
            exc_a: 0.5,
            noise: Noise::new(seed),
            sr,
        }
    }

    /// `brightness` 0..1 sets the loop filter; `t60` is the decay time in seconds.
    pub fn set(&mut self, freq: f32, brightness: f32, t60: f32) {
        let f = freq.clamp(20.0, self.sr * 0.25);
        self.lp_a = 0.25 + 0.7 * brightness.clamp(0.0, 1.0);
        // A one-pole lowpass delays low frequencies by (1-a)/a samples; compensate.
        let filter_delay = (1.0 - self.lp_a) / self.lp_a;
        self.delay = (self.sr / f - filter_delay).clamp(2.0, (PLUCK_MAX - 2) as f32);
        self.feedback = 10f32.powf(-3.0 / (t60.max(0.05) * f));
    }

    pub fn pluck(&mut self, energy: f32) {
        self.exc_left = self.delay as u32;
        self.exc_amp = energy.clamp(0.0, 1.0);
        // Harder plucks are brighter.
        self.exc_a = 0.15 + 0.85 * self.exc_amp;
    }

    #[inline]
    pub fn tick(&mut self) -> f32 {
        let rp = self.w as f32 - self.delay + PLUCK_MAX as f32;
        let i0 = rp as usize;
        let frac = rp - i0 as f32;
        let a = self.buf[i0 % PLUCK_MAX];
        let b = self.buf[(i0 + 1) % PLUCK_MAX];
        let y = a + (b - a) * frac;
        self.lp += self.lp_a * (y - self.lp);
        let mut x = self.lp * self.feedback + ANTI_DENORMAL;
        if self.exc_left > 0 {
            self.exc_left -= 1;
            let n = self.noise.next();
            self.exc_lp += self.exc_a * (n - self.exc_lp);
            x += self.exc_lp * self.exc_amp;
        }
        self.buf[self.w] = x;
        self.w = (self.w + 1) % PLUCK_MAX;
        y
    }
}

/// Two-operator FM bell with inharmonic 1:1.4 ratio and decaying index.
#[derive(Clone, Copy, Debug, Default)]
pub struct Bell {
    pc: f32,
    pm: f32,
    inc_c: f32,
    inc_m: f32,
    amp: f32,
    index: f32,
    decay_amp: f32,
    decay_index: f32,
}

impl Bell {
    pub fn trigger(&mut self, freq: f32, energy: f32, decay_s: f32, sr: f32) {
        self.inc_c = freq / sr;
        self.inc_m = freq * 1.4 / sr;
        self.amp = energy;
        self.index = 1.2 + 3.0 * energy;
        self.decay_amp = 0.001f32.powf(1.0 / (decay_s * sr));
        self.decay_index = 0.001f32.powf(1.0 / (decay_s * 0.35 * sr));
    }

    #[inline]
    pub fn tick(&mut self) -> f32 {
        if self.amp < 1e-5 {
            return 0.0;
        }
        let m = (TAU * self.pm).sin() * self.index;
        let y = (TAU * self.pc + m).sin() * self.amp;
        self.pc = (self.pc + self.inc_c).fract();
        self.pm = (self.pm + self.inc_m).fract();
        self.amp *= self.decay_amp;
        self.index *= self.decay_index;
        y
    }
}

/// A bubble: a short sine whose pitch rises as the bubble shrinks (Minnaert).
#[derive(Clone, Copy, Debug, Default)]
pub struct Bubble {
    phase: f32,
    freq: f32,
    chirp: f32,
    amp: f32,
    decay: f32,
}

impl Bubble {
    pub fn trigger(&mut self, freq: f32, energy: f32, sr: f32) {
        self.freq = freq;
        self.chirp = 1.0 + 4.0 / sr;
        self.amp = energy;
        self.decay = 0.001f32.powf(1.0 / (0.14 * sr));
        self.phase = 0.0;
    }

    #[inline]
    pub fn tick(&mut self, sr: f32) -> f32 {
        if self.amp < 1e-5 {
            return 0.0;
        }
        let y = (TAU * self.phase).sin() * self.amp;
        self.phase = (self.phase + self.freq / sr).fract();
        self.freq *= self.chirp;
        self.amp *= self.decay;
        y
    }
}

/// Topology-preserving state-variable filter (bandpass output).
#[derive(Clone, Copy, Debug, Default)]
pub struct Svf {
    a1: f32,
    a2: f32,
    a3: f32,
    ic1: f32,
    ic2: f32,
}

impl Svf {
    pub fn set(&mut self, freq: f32, q: f32, sr: f32) {
        let g = (PI * freq.clamp(20.0, sr * 0.45) / sr).tan();
        let k = 1.0 / q.max(0.1);
        self.a1 = 1.0 / (1.0 + g * (g + k));
        self.a2 = g * self.a1;
        self.a3 = g * self.a2;
    }

    #[inline]
    pub fn bandpass(&mut self, x: f32) -> f32 {
        let v3 = x - self.ic2;
        let v1 = self.a1 * self.ic1 + self.a2 * v3;
        let v2 = self.ic2 + self.a2 * self.ic1 + self.a3 * v3;
        self.ic1 = 2.0 * v1 - self.ic1 + ANTI_DENORMAL;
        self.ic2 = 2.0 * v2 - self.ic2 + ANTI_DENORMAL;
        v1
    }
}

struct Comb {
    buf: Vec<f32>,
    i: usize,
    filt: f32,
}

impl Comb {
    fn new(len: usize) -> Self {
        Comb { buf: vec![0.0; len.max(1)], i: 0, filt: 0.0 }
    }

    #[inline]
    fn tick(&mut self, x: f32, feedback: f32, damp: f32) -> f32 {
        let y = self.buf[self.i];
        self.filt = y * (1.0 - damp) + self.filt * damp + ANTI_DENORMAL;
        self.buf[self.i] = x + self.filt * feedback;
        self.i = (self.i + 1) % self.buf.len();
        y
    }
}

struct Allpass {
    buf: Vec<f32>,
    i: usize,
}

impl Allpass {
    fn new(len: usize) -> Self {
        Allpass { buf: vec![0.0; len.max(1)], i: 0 }
    }

    #[inline]
    fn tick(&mut self, x: f32) -> f32 {
        let b = self.buf[self.i];
        self.buf[self.i] = x + b * 0.5;
        self.i = (self.i + 1) % self.buf.len();
        b - x
    }
}

/// A compact Freeverb-style room: mono in, stereo out.
pub struct Reverb {
    combs_l: [Comb; 4],
    combs_r: [Comb; 4],
    ap_l: [Allpass; 2],
    ap_r: [Allpass; 2],
    pub feedback: f32,
    pub damp: f32,
}

impl Reverb {
    pub fn new(sr: f32) -> Self {
        let s = sr / 44_100.0;
        let len = |n: usize| (n as f32 * s) as usize;
        const SPREAD: usize = 23;
        let combs = [1116, 1188, 1277, 1356];
        Reverb {
            combs_l: combs.map(|n| Comb::new(len(n))),
            combs_r: combs.map(|n| Comb::new(len(n + SPREAD))),
            ap_l: [Allpass::new(len(556)), Allpass::new(len(441))],
            ap_r: [Allpass::new(len(556 + SPREAD)), Allpass::new(len(441 + SPREAD))],
            feedback: 0.84,
            damp: 0.3,
        }
    }

    #[inline]
    pub fn tick(&mut self, x: f32) -> (f32, f32) {
        let x = x * 0.03;
        let (fb, damp) = (self.feedback, self.damp);
        let mut l: f32 = self.combs_l.iter_mut().map(|c| c.tick(x, fb, damp)).sum();
        let mut r: f32 = self.combs_r.iter_mut().map(|c| c.tick(x, fb, damp)).sum();
        for a in &mut self.ap_l {
            l = a.tick(l);
        }
        for a in &mut self.ap_r {
            r = a.tick(r);
        }
        (l, r)
    }
}

/// Peak limiter with instant attack and smooth release, so nothing ever
/// exceeds the ceiling (hearing safety comes before character).
pub struct Limiter {
    gain: f32,
    release: f32,
    pub ceiling: f32,
}

impl Limiter {
    pub fn new(sr: f32) -> Self {
        Limiter { gain: 1.0, release: 1.0 - (-1.0 / (0.25 * sr)).exp(), ceiling: 0.89 }
    }

    #[inline]
    pub fn tick(&mut self, l: f32, r: f32) -> (f32, f32) {
        let peak = l.abs().max(r.abs());
        let want = if peak * self.gain > self.ceiling { self.ceiling / peak } else { 1.0 };
        if want < self.gain {
            self.gain = want;
        } else {
            self.gain += (want - self.gain) * self.release;
        }
        let c = self.ceiling;
        ((l * self.gain).clamp(-c, c), (r * self.gain).clamp(-c, c))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Estimate pitch by counting rising zero crossings.
    fn zero_cross_hz(samples: &[f32], sr: f32) -> f32 {
        let crossings = samples.windows(2).filter(|w| w[0] <= 0.0 && w[1] > 0.0).count();
        crossings as f32 * sr / samples.len() as f32
    }

    #[test]
    fn pluck_rings_at_its_pitch() {
        let sr = 48_000.0;
        let mut p = Pluck::new(sr, 3);
        p.set(220.0, 0.2, 3.0);
        p.pluck(0.8);
        // Skip the noisy attack, then measure.
        let out: Vec<f32> = (0..sr as usize).map(|_| p.tick()).collect();
        let hz = zero_cross_hz(&out[12_000..36_000], sr);
        assert!((hz - 220.0).abs() < 6.0, "measured {hz}");
    }

    #[test]
    fn limiter_holds_the_ceiling() {
        let mut lim = Limiter::new(48_000.0);
        for i in 0..10_000 {
            let x = (i as f32 * 0.01).sin() * 4.0;
            let (l, r) = lim.tick(x, -x);
            assert!(l.abs() <= lim.ceiling + 1e-6 && r.abs() <= lim.ceiling + 1e-6);
        }
    }

    #[test]
    fn bell_decays_to_silence() {
        let sr = 48_000.0;
        let mut b = Bell::default();
        b.trigger(440.0, 0.8, 0.5, sr);
        let tail: f32 = (0..sr as usize).map(|_| b.tick()).skip(40_000).map(f32::abs).fold(0.0, f32::max);
        assert!(tail < 0.01);
    }
}
