// CONTRACT FILE — export option shapes. Pure functions live in svg.ts / gcode.ts / png.ts / preset.ts.

export interface SvgOptions {
  /** Ramer–Douglas–Peucker tolerance in mm. 0 = no simplification. */
  tolerance: number;
  /** Include a background rect with the paper colour (ink) or nothing (metal). */
  background: boolean;
  /** Draw the outline of the work disc. */
  outline: boolean;
}

export type GcodeProfile = 'pen' | 'cnc';

export interface GcodeOptions {
  profile: GcodeProfile;
  /** 'center' = work centre is X0 Y0; 'corner' = bottom-left of the work bounds is X0 Y0. */
  origin: 'center' | 'corner';
  tolerance: number;
  /** mm/min */
  feedRate: number;
  /** mm/min, CNC plunge */
  plungeRate: number;
  /** Pen profile: raw commands for pen up / pen down (e.g. 'M3 S30' or 'G0 Z5'). */
  penUp: string;
  penDown: string;
  /** CNC: safe Z height, mm. */
  safeZ: number;
  /** CNC: Z = -(depthScale * (baseDepth + pumpZ)). */
  depthScale: number;
  header: string;
  footer: string;
}

export interface GcodeResult {
  text: string;
  stats: {
    lines: number;
    /** Cutting/drawing length, mm. */
    drawLength: number;
    /** Rapid travel length, mm. */
    travelLength: number;
    /** Seconds, rough: draw / feed + travel / rapid(3000 mm/min) + pen moves. */
    estimatedSeconds: number;
    bounds: { minX: number; minY: number; maxX: number; maxY: number };
  };
}

export const DEFAULT_SVG_OPTIONS: SvgOptions = { tolerance: 0.01, background: true, outline: false };

export const DEFAULT_GCODE_OPTIONS: GcodeOptions = {
  profile: 'pen',
  origin: 'center',
  tolerance: 0.02,
  feedRate: 1500,
  plungeRate: 100,
  penUp: 'M3 S30',
  penDown: 'M3 S90',
  safeZ: 2,
  depthScale: 1,
  header: 'G21 ; mm\nG90 ; absolute',
  footer: 'G0 X0 Y0\nM2',
};
