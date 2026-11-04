// number / int: graduated slider + numeric box. One drag = one undo step.
import { clampParam } from '../../state/params';
import { formatNumber, h, stepDecimals, uid } from '../dom';
import { shell, type Control, type FieldCtx, type FieldDef } from './field';

export function numberControl(def: FieldDef, ctx: FieldCtx, hintKey?: string): Control {
  const id = uid('rng');
  const min = def.min ?? 0;
  const max = def.max ?? 100;
  const step = def.step ?? (def.type === 'int' ? 1 : 0.01);
  const decimals = def.type === 'int' ? 0 : stepDecimals(step);
  const unit = def.unit ?? '';
  const shortUnit = unit.length > 0 && unit.length <= 2;

  const range = h('input', {
    id,
    type: 'range',
    class: 're-range',
    min,
    max,
    step,
  });
  const num = h('input', {
    type: 'number',
    inputmode: def.type === 'int' ? 'numeric' : 'decimal',
    min,
    max,
    step,
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

  const setFill = (v: number) => {
    const pct = max > min ? ((v - min) / (max - min)) * 100 : 0;
    range.style.setProperty('--fill', `${Math.max(0, Math.min(100, pct)).toFixed(2)}%`);
  };

  range.addEventListener('input', () => {
    dragging = true;
    const v = clampParam(def, parseFloat(range.value));
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
    const v = clampParam(def, raw);
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
      const v = Number(ctx.read(s.recipe));
      if (v === current) return;
      current = v;
      range.value = String(v);
      setFill(v);
      if (document.activeElement !== num) num.value = formatNumber(v, decimals);
    },
  };
}
