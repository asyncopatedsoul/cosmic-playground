//! hypertoy-core: the shared model every hypertoy runs on.
//!
//! - [`tuning`]: the world's key and scale, and the soft "no wrong notes" snap.
//! - [`scala`]: Scala `.scl` files as tuning tables.
//! - [`clock`]: the beat clock, advanced per audio sample.
//! - [`pulse`]: a toy's automation heart (step patterns with per-step probability).
//! - [`pattern`]: Tidal/Strudel-style mini-notation, compiled for Pulses.
//! - [`rng`]: deterministic hashing so the same (seed, toy, step) always rolls the same.

pub mod clock;
pub mod pattern;
pub mod pulse;
pub mod rng;
pub mod scala;
pub mod tuning;
