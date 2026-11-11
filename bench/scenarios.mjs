// The settings each benchmark compares, shared by bench/sim.mjs and bench/run.mjs.
// config: what goes in config.json (null: no dibs, everything starts at once).
// measured: the budgets count what running jobs really use, not what they asked for.
// slots: every resource's slots times this.
// The live settings on the benchmark Mac on 2026-10-14 (pace normal with cores and budget pinned).
export const OWNER = { budget: '11G', cores: 10, pace: 'normal', starveAfter: '3m', unknown: { slots: 1, mem: '1G' } };

export const SCENARIOS = {
  none: { config: null, about: 'no dibs: every job starts when it arrives' },
  defaults: { config: {}, about: 'dibs stock defaults (cores 6, budget 8G, no ceiling)' },
  owner: { config: OWNER, about: "the owner's live settings (pace normal, cores 10, budget 11G)" },
  quiet: { config: { pace: 'quiet' }, about: 'pace quiet' },
  normal: { config: { pace: 'normal' }, about: 'pace normal, nothing pinned' },
  max: { config: { pace: 'max' }, about: 'pace max' },
  // Variations
  'max-roomy': { config: { pace: 'max', roomyLoad: 0.9 }, about: 'pace max, budgets skipped below 0.9 load per core and 25% memory free (max before this branch, less its cores)' },
  'owner-max': { config: { ...OWNER, pace: 'max' }, about: "the owner's pins (cores 10, budget 11G) under pace max" },
  nobudget: { config: { cores: 1000, budget: '1000G' }, about: 'slots only: no CPU or memory budget' },
  measured: { config: { pace: 'max' }, measured: true, about: 'pace max, and the memory budget counts measured use too' },
  overlap: { config: { pace: 'max' }, measured: true, slots: 2, about: 'like measured, with twice the slots (what an overlap mode could buy)' },
  slots: { config: { pace: 'max', resources: { test: { slots: 4 }, heavy: { slots: 2 }, playwright: { slots: 3 } } }, about: 'pace max with test 4, heavy 2, playwright 3 slots' },
  starve: { config: { pace: 'max', starveAfter: '10m' }, about: 'pace max with starveAfter 10m' },
};
