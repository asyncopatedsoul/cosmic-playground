//! hypertoy-core: the shared model every hypertoy runs on.
//!
//! - [`tuning`]: the world's key and scale, and the soft "no wrong notes" snap.
//! - [`clock`]: the beat clock, advanced per audio sample.
//! - [`pulse`]: a toy's automation heart (step patterns with per-step probability).
//! - [`rng`]: deterministic hashing so the same (seed, toy, step) always rolls the same.

pub mod clock;
pub mod pulse;
pub mod rng;
pub mod tuning;
