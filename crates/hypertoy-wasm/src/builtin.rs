//! The three Phase 0 toys, as Voices. Each one's Law lives in `configure`:
//! one parameter drives the sound (and the snapshot drives the visuals).

use crate::engine::param;
use crate::voice::{Ctx, Fx, Tick, Voice};
use core::f32::consts::TAU;
use hypertoy_dsp::{Bell, Bubble, Noise, Pluck, Svf};
use hypertoy_laws::{bubble, kepler, string};

pub const PLANETS: usize = 4;
const BUBBLES: usize = 6;
const BANDS: usize = 4;

/// Linear density of the Spire's string, kg/m (chosen so length 1 m at
/// mid tension sounds about G3).
const SPIRE_DENSITY: f32 = 0.000_74;
/// Orbital period, in beats, of a planet at radius 1.
pub const ORRERY_K: f32 = 4.0;

/// Monochord Spire. A length (m), B tension (0..1), C harmonic (1..8).
pub struct Spire {
    pluck: Pluck,
    freq: f32,
    rolls: u64,
}

impl Spire {
    pub fn new(sr: f32, index: usize) -> Self {
        Spire { pluck: Pluck::new(sr, 0x1234 + index as u32 * 7919), freq: 0.0, rolls: 0 }
    }
}

impl Voice for Spire {
    fn configure(&mut self, cx: &Ctx) {
        let p = cx.params;
        let length = p[param::A].clamp(0.2, 2.0);
        let tension = p[param::B].clamp(0.0, 1.0);
        let harmonic = p[param::C].round().clamp(1.0, 8.0);
        let newtons = 40.0 * 8f32.powf(tension);
        let f0 = string::frequency(length, newtons, SPIRE_DENSITY);
        self.freq = cx.tuning.snap((f0 * harmonic).min(6000.0));
        let t60 = (2.8 * (220.0 / self.freq).powf(0.35)).clamp(0.4, 6.0);
        self.pluck.set(self.freq, tension, t60);
    }

    fn poke(&mut self, strength: f32, _cx: &Ctx, fx: &mut Fx) {
        self.pluck.pluck(strength);
        fx.flash = true;
    }

    #[inline]
    fn tick(&mut self, cx: &Ctx, t: &Tick, fx: &mut Fx) -> (f32, f32) {
        if let Some(hit) = t.hit {
            self.rolls += 1;
            let e = (0.5 + 0.35 * cx.roll(self.rolls)) * hit.vel;
            self.pluck.pluck(e);
            fx.flash = true;
        }
        let y = self.pluck.tick() * 0.8;
        (y, y)
    }

    fn freq(&self) -> f32 {
        self.freq
    }
}

/// Kepler Orrery. A..D planet orbit radii (0 = no planet).
pub struct Orrery {
    bells: [Bell; PLANETS],
    phase: [f64; PLANETS],
    period: [f32; PLANETS],
    freq: [f32; PLANETS],
    flash: [f32; PLANETS],
}

impl Orrery {
    pub fn new() -> Self {
        Orrery {
            bells: [Bell::default(); PLANETS],
            phase: [0.0; PLANETS],
            period: [ORRERY_K; PLANETS],
            freq: [0.0; PLANETS],
            flash: [0.0; PLANETS],
        }
    }
}

impl Voice for Orrery {
    fn configure(&mut self, cx: &Ctx) {
        for i in 0..PLANETS {
            let r = cx.params[param::A + i];
            if r <= 0.0 {
                continue;
            }
            let t = kepler::period(r, ORRERY_K);
            self.period[i] = if cx.tuning.wild { t } else { kepler::quantize(t, 0.5) };
            // Inner planets are faster and higher.
            let deg = ((2.2 - r) * 5.0).round() as i32;
            self.freq[i] = cx.tuning.degree(deg);
        }
    }

    fn param_set(&mut self, p: usize, was: f32, cx: &Ctx, beat: f64) {
        // A newly launched planet joins in phase with the beat grid.
        let v = cx.params[p];
        if (param::A..param::A + PLANETS).contains(&p) && was <= 0.0 && v > 0.0 {
            let i = p - param::A;
            let period = kepler::period(v, ORRERY_K);
            let period = if cx.tuning.wild { period } else { kepler::quantize(period, 0.5) };
            let speed = cx.params[param::SPEED].max(0.05) as f64;
            self.phase[i] = (beat * speed / period as f64).fract();
        }
    }

    fn poke(&mut self, strength: f32, cx: &Ctx, fx: &mut Fx) {
        for i in 0..PLANETS {
            if cx.params[param::A + i] > 0.0 {
                self.bells[i].trigger(self.freq[i], 0.25 * strength, 2.5, cx.sr);
                self.flash[i] = 1.0;
            }
        }
        fx.flash = true;
    }

    #[inline]
    fn tick(&mut self, cx: &Ctx, t: &Tick, _fx: &mut Fx) -> (f32, f32) {
        let speed = cx.params[param::SPEED].max(0.05) as f64;
        let mut sum = 0.0;
        for i in 0..PLANETS {
            let r = cx.params[param::A + i];
            if r > 0.0 {
                self.phase[i] += t.dbeat * speed / self.period[i] as f64;
                if self.phase[i] >= 1.0 {
                    // A transit across the meridian rings the planet.
                    self.phase[i] -= 1.0;
                    if t.pulse_on {
                        self.bells[i].trigger(self.freq[i], 0.18 + 0.08 / r, 2.2, cx.sr);
                        self.flash[i] = 1.0;
                    }
                }
            }
            sum += self.bells[i].tick();
            self.flash[i] *= 0.9997;
        }
        (sum, sum)
    }

    fn snapshot(&self, v: &mut [f32]) {
        for p in 0..PLANETS {
            v[p] = (self.phase[p] as f32) * TAU;
            v[4 + p] = self.flash[p];
            v[8 + p] = self.period[p];
        }
    }
}

/// Reaction Kettle. A coverage (0..1), B activity (0..1), C reagent (0..1).
pub struct Kettle {
    bubbles: [Bubble; BUBBLES],
    next_bubble: usize,
    bands: [Svf; BANDS],
    band_lfo: f32,
    noise: Noise,
    drone_phase: f32,
    drone_freq: f32,
    coverage: f32,
    activity: f32,
    rolls: u64,
}

impl Kettle {
    pub fn new(index: usize) -> Self {
        Kettle {
            bubbles: [Bubble::default(); BUBBLES],
            next_bubble: 0,
            bands: [Svf::default(); BANDS],
            band_lfo: 0.0,
            noise: Noise::new(0xBEEF + index as u32 * 104_729),
            drone_phase: 0.0,
            drone_freq: 0.0,
            coverage: 0.0,
            activity: 0.0,
            rolls: 0,
        }
    }

    fn bubble(&mut self, cx: &Ctx, energy: f32, fx: &mut Fx) {
        // 1–5 mm bubbles, pitch from the Minnaert law, then snapped to the Tuning.
        self.rolls += 1;
        let radius_mm = 1.0 + 4.0 * cx.roll(self.rolls);
        let f = cx.tuning.snap(bubble::frequency(radius_mm / 1000.0));
        self.bubbles[self.next_bubble].trigger(f, energy, cx.sr);
        self.next_bubble = (self.next_bubble + 1) % BUBBLES;
        fx.flash = true;
    }
}

impl Voice for Kettle {
    fn configure(&mut self, cx: &Ctx) {
        for (b, deg) in self.bands.iter_mut().zip([0, 2, 4, 7]) {
            b.set(cx.tuning.degree(deg) * 2.0, 45.0, cx.sr);
        }
        self.drone_freq = cx.tuning.degree(0) * 0.5;
    }

    fn poke(&mut self, strength: f32, cx: &Ctx, fx: &mut Fx) {
        self.bubble(cx, 0.35 * strength, fx);
        self.bubble(cx, 0.2 * strength, fx);
    }

    #[inline]
    fn tick(&mut self, cx: &Ctx, t: &Tick, fx: &mut Fx) -> (f32, f32) {
        let sr = cx.sr;
        self.coverage += (cx.params[param::A] - self.coverage) * 0.0005;
        self.activity += (cx.params[param::B] - self.activity) * 0.002;
        if let Some(hit) = t.hit {
            let e = (0.12 + 0.3 * self.activity) * hit.vel;
            self.bubble(cx, e, fx);
        }
        self.band_lfo = (self.band_lfo + 0.06 / sr).fract();
        let n = self.noise.next();
        let mut sum = 0.0;
        for (b, band) in self.bands.iter_mut().enumerate() {
            let lfo = 0.5 + 0.5 * (TAU * (self.band_lfo + b as f32 * 0.25)).sin();
            sum += band.bandpass(n) * lfo;
        }
        let texture = sum * (0.4 + 2.5 * self.activity) * (0.3 + self.coverage);
        self.drone_phase = (self.drone_phase + self.drone_freq / sr).fract();
        let drone = (TAU * self.drone_phase).sin() * self.coverage * 0.18;
        let bubbles: f32 = self.bubbles.iter_mut().map(|b| b.tick(sr)).sum();
        let y = texture + drone + bubbles;
        (y, y)
    }
}
