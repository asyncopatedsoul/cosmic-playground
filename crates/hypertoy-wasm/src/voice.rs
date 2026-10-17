//! The Voice contract: every toy's sound, built-in or described as data,
//! goes through this one trait (the dogfooding rule, PLAN §4.7).
//!
//! A Voice owns its Law and DSP. The engine owns the clock, the Pulse, the
//! Tuning, panning, the shared reverb and the limiter; it hands the Voice what
//! it needs per sample and never lets it allocate there.

use hypertoy_core::{pulse::Hit, rng, tuning::Tuning};

/// Params per toy slot. 0..8 are shared (pan, gain, pulse...); toy params start at `param::A`.
pub const PARAMS: usize = 32;

/// What a Voice can read when it is configured, poked or ticked.
pub struct Ctx<'a> {
    pub params: &'a [f32; PARAMS],
    pub tuning: &'a Tuning,
    pub sr: f32,
    /// The world seed and this toy's slot: together they key every random roll.
    pub seed: u64,
    pub index: usize,
    /// This toy is wild: its Law's pitch isn't snapped, even when the world's
    /// Tuning snaps (a per-toy switch, e.g. a puzzle's blue-seventh bonus).
    pub wild: bool,
}

impl Ctx<'_> {
    /// A deterministic roll in [0, 1): same (seed, slot, n) on every client.
    pub fn roll(&self, n: u64) -> f32 {
        rng::unit(rng::hash3(self.seed, self.index as u64, n))
    }

    /// Snap to the Tuning unless this toy (or the whole world) is wild.
    pub fn snap(&self, hz: f32) -> f32 {
        if self.wild {
            hz
        } else {
            self.tuning.snap(hz)
        }
    }

    /// Whether snapping (pitch, and the Orrery's period grid) is off for this toy.
    pub fn is_wild(&self) -> bool {
        self.wild || self.tuning.wild
    }
}

/// Per-sample timing and the Pulse's verdict for this sample.
#[allow(dead_code)] // `beat` and `frame` are for voices that need them; none do yet.
pub struct Tick {
    pub beat: f64,
    pub dbeat: f64,
    pub hit: Option<Hit>,
    pub pulse_on: bool,
    /// Sample index within the current block (for external modules' buffers).
    pub frame: usize,
    /// This slot's external-module output for `frame` (zero unless the voice is external).
    pub ext: (f32, f32),
}

/// Notes one Voice can start in a single sample (an Orrery poke rings every planet).
pub const MAX_FX_NOTES: usize = 4;

/// Side effects a Voice reports back to the engine.
#[derive(Default)]
pub struct Fx {
    /// Something visible just happened (a pluck, a bubble): flash the toy.
    pub flash: bool,
    /// Notes that began (velocity, Hz): forwarded as events to external modules,
    /// and to the host for slots that asked for them (MODES.md §3.3).
    notes: [(f32, f32); MAX_FX_NOTES],
    n_notes: usize,
}

impl Fx {
    /// Report a note; beyond `MAX_FX_NOTES` in one sample, the rest are dropped.
    pub fn note(&mut self, vel: f32, hz: f32) {
        if self.n_notes < MAX_FX_NOTES {
            self.notes[self.n_notes] = (vel, hz);
            self.n_notes += 1;
        }
    }

    pub fn notes(&self) -> &[(f32, f32)] {
        &self.notes[..self.n_notes]
    }
}

pub trait Voice {
    /// Recompute derived quantities (the Law) from params and the Tuning.
    fn configure(&mut self, cx: &Ctx);

    /// A param changed from `was`. Called before `configure`.
    fn param_set(&mut self, _p: usize, _was: f32, _cx: &Ctx, _beat: f64) {}

    /// A player touched the toy.
    fn poke(&mut self, strength: f32, cx: &Ctx, fx: &mut Fx);

    /// One sample, as (left, right). Mono voices return the same value twice.
    fn tick(&mut self, cx: &Ctx, t: &Tick, fx: &mut Fx) -> (f32, f32);

    /// Stereo voices are balanced by the toy's pan instead of panned.
    fn stereo(&self) -> bool {
        false
    }

    /// The pitch to show (snapshot `freq`).
    fn freq(&self) -> f32 {
        0.0
    }

    /// Fill the toy-specific snapshot fields (offset 6 onward).
    fn snapshot(&self, _extra: &mut [f32]) {}

    /// External (VMA) voices read their audio from the host.
    fn external(&self) -> bool {
        false
    }

    /// Toys described as data accept load commands.
    fn as_custom(&mut self) -> Option<&mut crate::custom::Custom> {
        None
    }
}

/// The voice of an empty slot.
pub struct Silent;

impl Voice for Silent {
    fn configure(&mut self, _: &Ctx) {}
    fn poke(&mut self, _: f32, _: &Ctx, _: &mut Fx) {}
    fn tick(&mut self, _: &Ctx, _: &Tick, _: &mut Fx) -> (f32, f32) {
        (0.0, 0.0)
    }
}
