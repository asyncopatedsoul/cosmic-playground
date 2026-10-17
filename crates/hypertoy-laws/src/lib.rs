//! hypertoy-laws: the first principles hypertoys follow.

pub mod gray_scott;

/// Vibrating strings (Mersenne's laws).
pub mod string {
    /// Fundamental of an ideal string: f = (1 / 2L) * sqrt(T / mu).
    /// `length` in metres, `tension` in newtons, `density` in kg/m.
    pub fn frequency(length: f32, tension: f32, density: f32) -> f32 {
        (tension / density).sqrt() / (2.0 * length)
    }
}

/// Orbits (Kepler's third law: T^2 is proportional to r^3).
pub mod kepler {
    /// Orbital period for a circular orbit of `radius`; `k` is the period at radius 1.
    pub fn period(radius: f32, k: f32) -> f32 {
        k * radius.powf(1.5)
    }

    /// Snap a period to a musical grid (in beats) so orbits make clean polyrhythms.
    pub fn quantize(period: f32, grid: f32) -> f32 {
        ((period / grid).round() * grid).max(grid)
    }
}

/// Gas bubbles in liquid (Minnaert resonance: f * r ~= 3.26 m/s in water).
pub mod bubble {
    pub const MINNAERT: f32 = 3.26;

    pub fn frequency(radius_m: f32) -> f32 {
        MINNAERT / radius_m
    }
}

/// Clamped circular plates (Kirchhoff): f = (lambda^2 / 2 pi a^2) * sqrt(D / rho h),
/// with flexural rigidity D = E h^3 / 12 (1 - nu^2). Defaults are glass.
pub mod plate {
    /// lambda^2 for the fundamental (0,1) mode of a clamped circular plate.
    pub const LAMBDA2: f32 = 10.2158;
    pub const GLASS_E: f32 = 70.0e9;
    pub const GLASS_RHO: f32 = 2500.0;
    pub const GLASS_NU: f32 = 0.22;

    /// `radius` and `thickness` in metres; `stiffness` scales Young's modulus.
    pub fn frequency(radius: f32, thickness: f32, stiffness: f32) -> f32 {
        let e = GLASS_E * stiffness;
        let d = e * thickness.powi(3) / (12.0 * (1.0 - GLASS_NU * GLASS_NU));
        LAMBDA2 / (core::f32::consts::TAU * radius * radius) * (d / (GLASS_RHO * thickness)).sqrt()
    }
}

/// Helmholtz resonators (a bottle you blow across): f = c/2 pi * sqrt(A / V L'),
/// with the neck's end correction L' = L + 1.7 r.
pub mod helmholtz {
    pub const SPEED_OF_SOUND: f32 = 343.0;

    /// `volume` in litres, neck `area` in cm^2, neck `length` in cm.
    pub fn frequency(volume_l: f32, area_cm2: f32, length_cm: f32) -> f32 {
        let v = volume_l * 1e-3;
        let a = area_cm2 * 1e-4;
        let r = (a / core::f32::consts::PI).sqrt();
        let l = length_cm * 1e-2 + 1.7 * r;
        SPEED_OF_SOUND / core::f32::consts::TAU * (a / (v * l)).sqrt()
    }
}

/// Simple pendulums: f = sqrt(g / L) / 2 pi. Far below hearing, so laws that
/// sound it "audify" it: raise it by whole octaves, keeping the ratios.
pub mod pendulum {
    pub const G: f32 = 9.81;

    pub fn frequency(length_m: f32) -> f32 {
        (G / length_m).sqrt() / core::f32::consts::TAU
    }
}

/// Built-in laws by id, for toys described as data (ToyConfig). A law turns
/// its arguments into a frequency; ids are mirrored in the playground's
/// `audio/config.ts`.
pub mod law {
    use super::*;

    pub const FIXED: u32 = 0;
    pub const STRING: u32 = 1;
    pub const PLATE: u32 = 2;
    pub const HELMHOLTZ: u32 = 3;
    pub const BUBBLE: u32 = 4;
    pub const PENDULUM: u32 = 5;
    pub const MAX_ARGS: usize = 4;

    /// Frequency in Hz, clamped to an audible, safe range. Unknown ids give 0 (silent).
    pub fn frequency(id: u32, a: &[f32; MAX_ARGS]) -> f32 {
        let pos = |x: f32, min: f32| if x.is_finite() { x.max(min) } else { min };
        let f = match id {
            FIXED => a[0],
            // length (m), tension (N), density (kg/m), harmonic
            STRING => string::frequency(pos(a[0], 0.01), pos(a[1], 0.0), pos(a[2], 1e-6)) * pos(a[3], 1.0).round(),
            // radius (m), thickness (m), stiffness (x glass)
            PLATE => plate::frequency(pos(a[0], 0.005), pos(a[1], 1e-4), pos(a[2], 0.01)),
            // volume (L), neck area (cm^2), neck length (cm)
            HELMHOLTZ => helmholtz::frequency(pos(a[0], 0.01), pos(a[1], 0.01), pos(a[2], 0.0)),
            // radius (mm)
            BUBBLE => bubble::frequency(pos(a[0], 0.05) / 1000.0),
            // length (m), octaves up
            PENDULUM => pendulum::frequency(pos(a[0], 0.01)) * 2f32.powf(a[1].clamp(0.0, 16.0).round()),
            _ => 0.0,
        };
        if f.is_finite() {
            f.clamp(0.0, 12_000.0)
        } else {
            0.0
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn half_the_string_is_an_octave_up() {
        let f1 = string::frequency(1.0, 100.0, 0.001);
        let f2 = string::frequency(0.5, 100.0, 0.001);
        assert!((f2 / f1 - 2.0).abs() < 1e-5);
    }

    #[test]
    fn four_times_the_tension_is_an_octave_up() {
        let f1 = string::frequency(1.0, 100.0, 0.001);
        let f2 = string::frequency(1.0, 400.0, 0.001);
        assert!((f2 / f1 - 2.0).abs() < 1e-5);
    }

    #[test]
    fn kepler_third_law() {
        // Four times the radius is eight times the period.
        assert!((kepler::period(4.0, 1.0) - 8.0).abs() < 1e-4);
        assert_eq!(kepler::quantize(1.41, 0.5), 1.5);
        assert_eq!(kepler::quantize(0.1, 0.5), 0.5);
    }

    #[test]
    fn a_one_millimetre_bubble_sings_around_3khz() {
        assert!((bubble::frequency(0.001) - 3260.0).abs() < 1.0);
    }

    #[test]
    fn plate_scales_with_thickness_over_radius_squared() {
        let f = plate::frequency(0.12, 0.002, 1.0);
        assert!(f > 200.0 && f < 600.0, "{f}");
        assert!((plate::frequency(0.12, 0.004, 1.0) / f - 2.0).abs() < 1e-3);
        assert!((f / plate::frequency(0.24, 0.002, 1.0) - 4.0).abs() < 1e-3);
    }

    #[test]
    fn a_wine_bottle_hums_low() {
        // 0.75 L, 2 cm neck bore (3.14 cm^2), 8 cm neck: around 100-150 Hz.
        let f = helmholtz::frequency(0.75, 3.14, 8.0);
        assert!(f > 90.0 && f < 160.0, "{f}");
        // Four times the volume is an octave down.
        assert!((f / helmholtz::frequency(3.0, 3.14, 8.0) - 2.0).abs() < 1e-3);
    }

    #[test]
    fn a_one_metre_pendulum_is_about_half_a_hertz() {
        assert!((pendulum::frequency(1.0) - 0.4985).abs() < 1e-3);
        let f = law::frequency(law::PENDULUM, &[1.0, 9.0, 0.0, 0.0]);
        assert!((f - 0.4985 * 512.0).abs() < 1.0);
    }

    #[test]
    fn law_dispatch_is_safe() {
        assert_eq!(law::frequency(law::FIXED, &[440.0, 0.0, 0.0, 0.0]), 440.0);
        let s = law::frequency(law::STRING, &[1.0, 100.0, 0.001, 2.0]);
        assert!((s - 2.0 * string::frequency(1.0, 100.0, 0.001)).abs() < 1e-3);
        assert_eq!(law::frequency(99, &[1.0; 4]), 0.0);
        assert_eq!(law::frequency(law::FIXED, &[f32::NAN, 0.0, 0.0, 0.0]), 0.0);
        assert_eq!(law::frequency(law::STRING, &[0.0, 1e12, 0.0, 1.0]), 12_000.0);
    }
}
