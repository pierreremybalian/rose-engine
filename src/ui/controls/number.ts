// number / int: graduated slider + numeric box. One drag = one undo step.
// Limits are read through resolveParam(def, recipe) on every update, so recipe-dependent ranges
// (radius max follows the plate, lobe min/step follow the symmetry order) stay live.
import { clampParam, resolveParam } from '../../state/params';
import { formatNumber, h, stepDecimals, uid } from '../dom';
import { shell, type Control, type FieldCtx, type FieldDef } from './field';

interface Limits {
  min: number;
  max: number;
  step: number;
}

function limitsOf(def: FieldDef): Limits {
  return { min: def.min ?? 0, max: def.max ?? 100, step: def.step ?? (def.type === 'int' ? 1 : 0.01) };
}

export function numberControl(def: FieldDef, ctx: FieldCtx, hintKey?: string): Control {
  const id = uid('rng');
  const unit = def.unit ?? '';
  const shortUnit = unit.length > 0 && unit.length <= 2;
  let lim = limitsOf(def);
  let decimals = def.type === 'int' ? 0 : stepDecimals(lim.step);

  const range = h('input', {
    id,
    type: 'range',
    class: 're-range',
    min: lim.min,
    max: lim.max,
    step: lim.step,
  });
  const num = h('input', {
    type: 'number',
    inputmode: def.type === 'int' ? 'numeric' : 'decimal',
    min: lim.min,
    max: lim.max,
    step: lim.step,
    class: 're-figures w-full min-w-0 bg-transparent py-1 pl-2 pr-1 text-right font-mono text-[12px] text-vellum',
    'aria-label': unit ? `${def.label} (${unit})` : def.label,
  });
  const box = h(
    'div',
    { class: 're-numbox flex h-8 w-[5.4rem] flex-none items-center pr-2' },
    num,
    shortUnit ? h('span', { class: 'font-mono text-[11px] text-smoke', 'aria-hidden': 'true' }, unit) : null,
  );
  const body = h('div', { class: 'flex items-center gap-3' }, h('div', { class: 're-scale min-w-0 flex-1' }, range), box);
  const sh = shell(def, ctx, { forId: id, body, hintKey, unitInLabel: !shortUnit });
  if (sh.helpId) {
    range.setAttribute('aria-describedby', sh.helpId);
    num.setAttribute('aria-describedby', sh.helpId);
  }

  let dragging = false;
  let current = Number.NaN;

  /** Clamp to the live limits; integer params with a coarse step (lobes under N-fold symmetry) snap to the grid. */
  const clamp = (v: number): number => {
    let x = clampParam({ type: def.type, min: lim.min, max: lim.max }, v);
    if (def.type === 'int' && lim.step > 1) {
      x = lim.min + Math.round((x - lim.min) / lim.step) * lim.step;
      while (x > lim.max) x -= lim.step;
      x = Math.max(lim.min, x);
    }
    return x;
  };

  const setFill = (v: number) => {
    const pct = lim.max > lim.min ? ((v - lim.min) / (lim.max - lim.min)) * 100 : 0;
    range.style.setProperty('--fill', `${Math.max(0, Math.min(100, pct)).toFixed(2)}%`);
  };

  /** Returns true when the limits changed (the slider then needs its value and fill re-applied). */
  const applyLimits = (next: Limits): boolean => {
    if (next.min === lim.min && next.max === lim.max && next.step === lim.step) return false;
    lim = next;
    decimals = def.type === 'int' ? 0 : stepDecimals(lim.step);
    for (const el of [range, num]) {
      el.min = String(lim.min);
      el.max = String(lim.max);
      el.step = String(lim.step);
    }
    return true;
  };

  range.addEventListener('input', () => {
    dragging = true;
    const v = clamp(parseFloat(range.value));
    setFill(v);
    if (document.activeElement !== num) num.value = formatNumber(v, decimals);
    if (v !== current) ctx.write(v, { coalesce: true });
  });
  const end = () => {
    if (!dragging) return;
    dragging = false;
    ctx.store.endCoalesce();
  };
  range.addEventListener('change', end);
  range.addEventListener('pointerup', end);
  range.addEventListener('pointercancel', end);
  range.addEventListener('blur', end);

  const commitNum = () => {
    const raw = parseFloat(num.value);
    if (!Number.isFinite(raw)) {
      num.value = formatNumber(current, decimals);
      return;
    }
    const v = clamp(raw);
    num.value = formatNumber(v, decimals);
    if (v !== current) {
      ctx.write(v);
      ctx.store.endCoalesce();
    }
  };
  num.addEventListener('change', commitNum);
  num.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      num.value = formatNumber(current, decimals);
      num.blur();
    }
  });

  return {
    el: sh.el,
    update(s) {
      sh.lock?.update(s);
      const limitsChanged = applyLimits(limitsOf(resolveParam(def, s.recipe)));
      const v = Number(ctx.read(s.recipe));
      if (v === current && !limitsChanged) return;
      current = v;
      range.value = String(v);
      setFill(v);
      if (document.activeElement !== num) num.value = formatNumber(v, decimals);
    },
  };
}
