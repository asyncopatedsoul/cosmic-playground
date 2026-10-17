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
        // Snap the fundamental first, so each harmonic is an exact multiple of a
        // scale tone (in a just table, harmonics 2-6 and 8 land on scale tones
        // exactly), then snap the harmonic itself (7 lands on its nearest tone).
        // A wild Spire keeps its fundamental on the scale and leaves only the
        // harmonic unsnapped, so harmonic 7 is exactly 7/4 above a scale tone.
        let base = cx.tuning.snap(f0);
        self.freq = cx.snap((base * harmonic).min(6000.0));
        let t60 = (2.8 * (220.0 / self.freq).powf(0.35)).clamp(0.4, 6.0);
        self.pluck.set(self.freq, tension, t60);
    }

    fn poke(&mut self, strength: f32, _cx: &Ctx, fx: &mut Fx) {
        self.pluck.pluck(strength);
        fx.flash = true;
        fx.note(strength, self.freq);
    }

    #[inline]
    fn tick(&mut self, cx: &Ctx, t: &Tick, fx: &mut Fx) -> (f32, f32) {
        if let Some(hit) = t.hit {
            self.rolls += 1;
            let e = (0.5 + 0.35 * cx.roll(self.rolls)) * hit.vel;
            self.pluck.pluck(e);
            fx.flash = true;
            fx.note(e, self.freq);
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
            self.period[i] = if cx.is_wild() { t } else { kepler::quantize(t, 0.5) };
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
            let period = if cx.is_wild() { period } else { kepler::quantize(period, 0.5) };
            let speed = cx.params[param::SPEED].max(0.05) as f64;
            self.phase[i] = (beat * speed / period as f64).fract();
        }
    }

    fn poke(&mut self, strength: f32, cx: &Ctx, fx: &mut Fx) {
        for i in 0..PLANETS {
            if cx.params[param::A + i] > 0.0 {
                self.bells[i].trigger(self.freq[i], 0.25 * strength, 2.5, cx.sr);
                self.flash[i] = 1.0;
                fx.note(strength, self.freq[i]);
            }
        }
        fx.flash = true;
    }

    #[inline]
    fn tick(&mut self, cx: &Ctx, t: &Tick, fx: &mut Fx) -> (f32, f32) {
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
                        let vel = 0.18 + 0.08 / r;
                        self.bells[i].trigger(self.freq[i], vel, 2.2, cx.sr);
                        self.flash[i] = 1.0;
                        fx.note(vel.min(1.0), self.freq[i]);
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
        let f = cx.snap(bubble::frequency(radius_mm / 1000.0));
        self.bubbles[self.next_bubble].trigger(f, energy, cx.sr);
        self.next_bubble = (self.next_bubble + 1) % BUBBLES;
        fx.flash = true;
        fx.note(energy.min(1.0), f);
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::voice::PARAMS;
    use hypertoy_core::tuning::{Scale, Tuning};

    /// The Spire's sounding pitch when its raw fundamental is `drift` cents off the root.
    fn spire_freq(tuning: &Tuning, drift: f32, harmonic: f32) -> f32 {
        spire_freq_wild(tuning, drift, harmonic, false)
    }

    fn spire_freq_wild(tuning: &Tuning, drift: f32, harmonic: f32, wild: bool) -> f32 {
        let tension = 0.5;
        let newtons = 40.0 * 8f32.powf(tension);
        // Pitch goes as 1/length: find the length for root * 2^(drift/1200).
        let target = tuning.root_hz * 2f32.powf(drift / 1200.0);
        let mut params = [0.0; PARAMS];
        params[param::A] = string::frequency(1.0, newtons, SPIRE_DENSITY) / target;
        params[param::B] = tension;
        params[param::C] = harmonic;
        let cx = Ctx { params: &params, tuning, sr: 48_000.0, seed: 1, index: 0, wild };
        let mut s = Spire::new(48_000.0, 0);
        s.configure(&cx);
        s.freq
    }

    fn cents(a: f32, b: f32) -> f32 {
        1200.0 * (a / b).log2()
    }

    #[test]
    fn spire_harmonics_are_exact_multiples_of_the_snapped_fundamental() {
        // Just pentatonic on C3: 1, 9/8, 5/4, 3/2, 5/3.
        let t = Tuning::new(130.81, Scale::JustPentatonic, false);
        // Drifts that still snap the fundamental to the root (about +102 / -158
        // cents). Snapping only after the multiply threw harmonic 3 onto A at
        // +95 and harmonic 5 onto D at -150.
        for d in [-150.0, -120.0, -90.0, -45.0, 0.0, 45.0, 95.0] {
            for h in [1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 8.0] {
                let f = spire_freq(&t, d, h);
                assert!(cents(f, t.root_hz * h).abs() < 0.05, "drift {d}, harmonic {h}: {f} Hz");
            }
            // Harmonic 7 (7/4, 969 cents) snaps to 5/3 (884 cents): an A over C.
            let f = spire_freq(&t, d, 7.0);
            assert!(cents(f, t.root_hz * 4.0 * 5.0 / 3.0).abs() < 0.05, "drift {d}, harmonic 7: {f} Hz");
        }
    }

    #[test]
    fn a_wild_spire_keeps_its_fundamental_and_frees_the_harmonic() {
        let t = Tuning::new(130.81, Scale::JustPentatonic, false);
        // Fundamental 30 cents sharp still snaps to C; harmonic 7 is the true 7/4.
        let f = spire_freq_wild(&t, 30.0, 7.0, true);
        assert!(cents(f, t.root_hz * 7.0).abs() < 0.05, "{f} Hz");
        // Not wild: the same string plays the snapped A.
        let f = spire_freq_wild(&t, 30.0, 7.0, false);
        assert!(cents(f, t.root_hz * 4.0 * 5.0 / 3.0).abs() < 0.05, "{f} Hz");
    }

    #[test]
    fn wild_spire_is_unsnapped() {
        let t = Tuning::new(130.81, Scale::JustPentatonic, true);
        let f = spire_freq(&t, 37.0, 3.0);
        assert!((cents(f, t.root_hz * 3.0) - 37.0).abs() < 0.05, "{f} Hz");
    }
}
