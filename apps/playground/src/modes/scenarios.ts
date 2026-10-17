import firstLight from "../../puzzles/puzzle-first-light.json";
import tideClock from "../../puzzles/puzzle-tide-clock.json";
import nightfall from "../../puzzles/puzzle-nightfall.json";
import { validateScenario, type ScenarioDoc } from "./scenario";

/** The shipped puzzles, in series order (MODES.md §7). */
export const SCENARIOS = ([firstLight, tideClock, nightfall] as unknown as ScenarioDoc[]).sort((a, b) => a.order - b.order);

for (const s of SCENARIOS) {
  const problems = validateScenario(s);
  if (problems.length) console.warn(`scenario ${s.id}:`, problems);
}

/** By full id (`puzzle-first-light`) or short name (`first-light`). */
export const scenario = (id: string) => SCENARIOS.find((s) => s.id === id || s.id === `puzzle-${id}`);
