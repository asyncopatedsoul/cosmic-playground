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
}
