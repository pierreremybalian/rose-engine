// Shared fixtures for the state tests (not a test file itself).
/** The Fine Barleycorn preset as shipped in v1 (before plate / symmetry existed). */
export const V1_PRESET = {
  version: 1,
  name: 'Fine Barleycorn',
  seed: 0,
  mode: 'metal',
  machine: { rosetteRadius: 60, rubberRadius: 0.6, workDiameter: 32 },
  rosettes: [{ id: 'a', enabled: true, axis: 'rock', lobes: 216, amplitude: 0.125, profile: 'triangle', phase: 0 }],
  slide: {
    startRadius: 6.5,
    endRadius: 15.5,
    passes: 37,
    phaseMode: 'alternate',
    phaseStep: 0,
    alternateEvery: 1,
    alternateFraction: 0.5,
    phaseCustom: [0],
    amplitudeTaper: 1,
    spiral: false,
  },
  eccentric: { enabled: false, offset: 0, angle: 0, divisions: 1, divisionStep: 0 },
  elliptical: { enabled: false, e: 0, angle: 0 },
  ink: { palette: ['#1d2a5c', '#2f6b4f', '#7a2a3a'], colorMode: 'single', paper: '#f4efe4', lineWidth: 0.08, opacity: 0.92 },
  metal: { material: 'silver', toolAngle: 120, baseDepth: 0.16, lightAngle: 45, lightElevation: 36, enamel: false, enamelColor: '#1b3fa0', enamelOpacity: 0.45 },
} as const;
