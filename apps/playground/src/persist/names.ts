/** Kid-safe auto names from a colour and a celestial word (SAVE-LOAD.md §7): "Violet Orbit 3". */
const COLOURS = ["Violet", "Amber", "Teal", "Rose", "Golden", "Silver", "Indigo", "Coral", "Jade", "Ruby", "Sky", "Moss", "Peach", "Plum", "Frost", "Ember"];
const WORDS = ["Orbit", "Nebula", "Comet", "Moon", "Star", "Galaxy", "Aurora", "Meteor", "Planet", "Quasar", "Halo", "Eclipse", "Pulsar", "Cluster", "Dawn", "Drift"];

export function worldName(seed = Math.random()): string {
  const r = Math.floor(seed * 2 ** 31);
  return `${COLOURS[r % COLOURS.length]} ${WORDS[(r >> 4) % WORDS.length]} ${1 + ((r >> 8) % 9)}`;
}
