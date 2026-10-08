// The five Auto Mode modes (the menu in place of models). Must stay the same as MODES in src/main/router.js
// (checked by test/router.test.js): "tier" is the model router tier the mode is locked to (null = all).
export const ROUTER_MODES = [
  { id: 'auto', label: 'AUTO MODE', tier: null, work: 'auto', tip: 'AUTO: picks A, B, C or BC work; A designs, B and C develop' },
  { id: 'high', label: 'HIGH MODE', tier: 'A', work: 'A', tip: 'A: Opus 5.5 designs and splits the work into B/C/BC tasks' },
  { id: 'medium', label: 'MEDIUM MODE', tier: 'B', work: 'B', tip: 'B: Sonnet 5.5 or GPT-6.1 Sol develops complex code' },
  { id: 'low', label: 'LOW MODE', tier: 'C', work: 'C', tip: 'C: GPT-6 Luna or GLM-5.3 Flash develops routine code' },
  { id: 'bc', label: 'BC MODE', tier: null, work: 'BC', tip: 'BC: C develops, a single B reviews; at most two rounds back to C' },
];

export function routerMode(id) {
  return ROUTER_MODES.find((m) => m.id === id) || ROUTER_MODES[0];
}
