//! Toys described as data (ToyConfig): a built-in Law whose arguments are
//! bound to params, and one of three voice bodies:
//!
//! - **patch**: a fundsp graph (`hypertoy_dsp::patch`), optionally polyphonic;
//! - **zap**: a ZzFX-compatible recipe, with params bound to recipe slots;
//! - **external**: a Voice Module (VMA) running in the worklet, whose audio
//!   the host writes into this slot's external buffer.
//!
//! The Law's frequency snaps to the Tuning unless the toy is `wild`, and a
//! pattern's scale degrees transpose it.

use crate::engine::param;
use crate::voice::{Ctx, Fx, Tick, Voice};
use hypertoy_dsp::patch::{Patch, INPUT_FREQ, INPUT_GATE, INPUT_PARAM0, INPUT_TRIG, NUM_INPUTS, PATCH_PARAMS};
use hypertoy_dsp::zap::{Zap, RECIPE_LEN};
use hypertoy_laws::law::{self, MAX_ARGS};

pub const MAX_POLY: usize = 8;
pub const MAX_ZAP_BINDS: usize = 8;

/// Where a Law argument comes from: `param` (a toy param index, from 0) times
/// `mul` plus `add`, or just `add` when there is no param.
#[derive(Clone, Copy, Debug, Default)]
pub struct Arg {
    pub param: Option<usize>,
    pub mul: f32,
    pub add: f32,
}

struct PatchVoice {
    patch: Patch,
    gate_left: u32,
    trig: f32,
    freq: f32,
}

enum Body {
    Silent,
    Patch { voices: Vec<PatchVoice>, next: usize, gate_len: u32 },
    Zap { zap: Zap, binds: [(usize, usize); MAX_ZAP_BINDS], n_binds: usize },
    External,
}

/// Every custom voice passes through this before the toy bus: anything a
/// config or module does, the bus sees no DC, no NaN and nothing far past 1.
#[derive(Clone, Copy, Default)]
pub struct Guard {
    x1: [f32; 2],
    y1: [f32; 2],
}

/// Below this level the clip is transparent.
const KNEE: f32 = 0.7;
/// DC blocker pole (about 7 Hz at 44.1 kHz).
const DC_POLE: f32 = 0.999;

impl Guard {
    #[inline]
    pub fn tick(&mut self, l: f32, r: f32) -> (f32, f32) {
        let mut ch = |i: usize, x: f32| {
            let x = if x.is_finite() { x } else { 0.0 };
            let y = x - self.x1[i] + DC_POLE * self.y1[i];
            self.x1[i] = x;
            // Flush denormals and recover from any blow-up inside the filter.
            self.y1[i] = if y.is_finite() && y.abs() > 1e-20 { y } else { 0.0 };
            soft_clip(self.y1[i])
        };
        (ch(0, l), ch(1, r))
    }
}

/// Transparent below the knee, then a tanh shoulder that never passes 1.
#[inline]
pub fn soft_clip(x: f32) -> f32 {
    let a = x.abs();
    if a <= KNEE {
        x
    } else {
        x.signum() * (KNEE + (1.0 - KNEE) * ((a - KNEE) / (1.0 - KNEE)).tanh())
    }
}

pub struct Custom {
    law: u32,
    args: [Arg; MAX_ARGS],
    wild: bool,
    body: Body,
    freq: f32,
    rolls: u64,
    sr: f32,
    guard: Guard,
}

impl Custom {
    pub fn new(sr: f32) -> Self {
        Custom {
            law: law::FIXED,
            args: [Arg { param: None, mul: 1.0, add: 220.0 }, Arg::default(), Arg::default(), Arg::default()],
            wild: false,
            body: Body::Silent,
            freq: 220.0,
            rolls: 0,
            sr,
            guard: Guard::default(),
        }
    }

    pub fn set_law(&mut self, id: u32, args: [Arg; MAX_ARGS], wild: bool) {
        self.law = id;
        self.args = args;
        self.wild = wild;
    }

    /// `voices` copies of a built patch; a trigger holds the gate for `gate_s`.
    pub fn set_patch(&mut self, patch: Patch, voices: usize, gate_s: f32) {
        let voices = (0..voices.clamp(1, MAX_POLY))
            .map(|_| PatchVoice { patch: patch.clone(), gate_left: 0, trig: 0.0, freq: self.freq })
            .collect();
        let gate_len = (gate_s.clamp(0.001, 10.0) * self.sr) as u32;
        self.body = Body::Patch { voices, next: 0, gate_len };
    }

    pub fn set_zap(&mut self, recipe: &[f32], binds: &[(usize, usize)], seed: u32) {
        let mut zap = Zap::new(self.sr, seed);
        zap.set_recipe(recipe);
        let mut b = [(0, 0); MAX_ZAP_BINDS];
        let mut n = 0;
        for &(slot, p) in binds.iter().take(MAX_ZAP_BINDS) {
            if slot < RECIPE_LEN && p + param::A < crate::voice::PARAMS {
                b[n] = (slot, p);
                n += 1;
            }
        }
        self.body = Body::Zap { zap, binds: b, n_binds: n };
    }

    pub fn set_external(&mut self) {
        self.body = Body::External;
    }

    fn note(&mut self, vel: f32, degree: Option<f32>, cx: &Ctx, fx: &mut Fx) {
        let freq = match degree {
            Some(d) => cx.tuning.transpose(self.freq, d),
            None => self.freq,
        };
        let vel = vel.clamp(0.0, 1.0);
        fx.flash = true;
        fx.note = Some((vel, freq));
        match &mut self.body {
            Body::Patch { voices, next, gate_len } => {
                let n = voices.len();
                let v = &mut voices[*next];
                *next = (*next + 1) % n;
                // A zero-then-vel trig makes a clean rising edge even on retrigger.
                v.trig = vel.max(1e-3);
                v.gate_left = *gate_len;
                v.freq = freq;
            }
            Body::Zap { zap, .. } => {
                self.rolls += 1;
                zap.trigger(vel, Some(freq), cx.roll(self.rolls));
            }
            Body::Silent | Body::External => {}
        }
    }
}

impl Voice for Custom {
    fn configure(&mut self, cx: &Ctx) {
        let mut a = [0.0; MAX_ARGS];
        for (v, arg) in a.iter_mut().zip(&self.args) {
            let p = arg.param.map(|i| cx.params.get(param::A + i).copied().unwrap_or(0.0)).unwrap_or(0.0);
            *v = p * arg.mul + arg.add;
        }
        let f = law::frequency(self.law, &a);
        self.freq = if self.wild { f } else { cx.snap(f) };
        // Held and droning patch voices follow the Law as it moves.
        if let Body::Patch { voices, .. } = &mut self.body {
            voices.iter_mut().for_each(|v| v.freq = self.freq);
        }
        if let Body::Zap { zap, binds, n_binds } = &mut self.body {
            let mut recipe = zap.recipe;
            for &(slot, p) in &binds[..*n_binds] {
                recipe[slot] = cx.params[param::A + p];
            }
            zap.set_recipe(&recipe);
        }
    }

    fn poke(&mut self, strength: f32, cx: &Ctx, fx: &mut Fx) {
        self.note(strength, None, cx, fx);
    }

    #[inline]
    fn tick(&mut self, cx: &Ctx, t: &Tick, fx: &mut Fx) -> (f32, f32) {
        if let Some(hit) = t.hit {
            self.note(hit.vel, hit.degree, cx, fx);
        }
        let (l, r) = match &mut self.body {
            Body::Patch { voices, .. } => {
                let mut input = [0.0; NUM_INPUTS];
                for i in 0..PATCH_PARAMS {
                    input[INPUT_PARAM0 + i] = cx.params[param::A + i];
                }
                let (mut l, mut r) = (0.0, 0.0);
                for v in voices.iter_mut() {
                    input[INPUT_FREQ] = v.freq;
                    input[INPUT_GATE] = if v.gate_left > 0 { 1.0 } else { 0.0 };
                    input[INPUT_TRIG] = v.trig;
                    v.trig = 0.0;
                    v.gate_left = v.gate_left.saturating_sub(1);
                    let (a, b) = v.patch.tick(&input);
                    l += a;
                    r += b;
                }
                (l, r)
            }
            Body::Zap { zap, .. } => {
                let y = zap.tick();
                (y, y)
            }
            Body::External => t.ext,
            Body::Silent => (0.0, 0.0),
        };
        self.guard.tick(l, r)
    }

    fn stereo(&self) -> bool {
        match &self.body {
            Body::Patch { voices, .. } => voices.first().is_some_and(|v| v.patch.outputs() == 2),
            Body::External => true,
            _ => false,
        }
    }

    fn freq(&self) -> f32 {
        self.freq
    }

    fn external(&self) -> bool {
        matches!(self.body, Body::External)
    }

    fn as_custom(&mut self) -> Option<&mut Custom> {
        Some(self)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn soft_clip_is_transparent_then_bounded() {
        for x in [0.0, 0.3, -0.5, 0.7] {
            assert_eq!(soft_clip(x), x);
        }
        let mut last = 0.0;
        for i in 0..1000 {
            let y = soft_clip(0.7 + i as f32 * 0.05);
            assert!(y >= last && y <= 1.0, "monotonic and never past 1");
            last = y;
        }
        assert_eq!(soft_clip(-50.0), -soft_clip(50.0));
    }

    #[test]
    fn guard_removes_dc_and_nan() {
        let mut g = Guard::default();
        let mut out = (0.0, 0.0);
        for _ in 0..48_000 {
            out = g.tick(5.0, f32::NAN);
        }
        assert!(out.0.abs() < 1e-3, "DC decays: {}", out.0);
        assert_eq!(out.1, 0.0);
        // A huge step is clipped to at most 1 and stays finite.
        let (a, _) = g.tick(1e30, 0.0);
        assert!(a.is_finite() && a.abs() <= 1.0);
        // Ordinary audio passes nearly unchanged.
        let mut g = Guard::default();
        let tone: Vec<f32> = (0..4800).map(|i| 0.5 * (i as f32 * 0.05).sin()).collect();
        let peak = tone.iter().map(|&x| g.tick(x, x).0.abs()).fold(0.0, f32::max);
        assert!((peak - 0.5).abs() < 0.02, "{peak}");
    }
}
