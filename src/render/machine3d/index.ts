// 3D rose engine model. Injected into the render module by main.ts (render code must not import this).
import type { IMachineModel } from '../types';
import { MachineModel } from './model';

export { MachineModel };

export function createMachineModel(): IMachineModel {
  return new MachineModel();
}
