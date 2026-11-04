// Rosette stack editor: one card per cam with a live brass thumbnail of its profile.
import { rosetteRadiusAt } from '../engine/rosette';
import { ROSETTE_PARAMS } from '../state/params';
import { defaultRosette, type Recipe, type Rosette } from '../state/recipe';
import type { AppState, Store } from '../state/store';
import { h, reconcile, roman } from './dom';
import { icon } from './icons';
import { lockButton, paramControl, switchButton, type Control } from './controls';

const TAU = Math.PI * 2;
const THUMB = 60;

let palette: Record<string, string> | null = null;
function colors(): Record<string, string> {
  if (palette) return palette;
  const cs = getComputedStyle(document.documentElement);
  const v = (name: string, fallback: string) => cs.getPropertyValue(name).trim() || fallback;
  palette = {
    b100: v('--color-brass-100', '#f7ecd2'),
    b200: v('--color-brass-200', '#eed9a8'),
    b300: v('--color-brass-300', '#e3c482'),
    b500: v('--color-brass-500', '#b88e46'),
    b600: v('--color-brass-600', '#936f33'),
    b700: v('--color-brass-700', '#6a4f25'),
    b800: v('--color-brass-800', '#3f2f17'),
    ink: v('--color-ink-950', '#090806'),
    steel: v('--color-vellum-dim', '#c0b39b'),
  };
  return palette;
}

/** Draw the cam: exaggerated amplitude so every profile reads at thumbnail size. */
function drawThumb(canvas: HTMLCanvasElement, ro: Rosette, rubber: number): void {
  const dpr = Math.min(3, window.devicePixelRatio || 1);
  if (canvas.width !== THUMB * dpr) {
    canvas.width = THUMB * dpr;
    canvas.height = THUMB * dpr;
  }
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const c = colors();
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, THUMB, THUMB);
  const cx = THUMB / 2;
  const cy = THUMB / 2;
  const visAmp = ro.amplitude <= 0 ? 0 : 0.07 + 0.2 * Math.min(1, ro.amplitude / 4);
  const vis: Rosette = { ...ro, amplitude: visAmp };
  const scale = (THUMB / 2 - 8) / (1 + visAmp);
  const n = Math.min(2400, Math.max(360, ro.lobes * 24));

  ctx.beginPath();
  for (let i = 0; i <= n; i++) {
    const phi = (i / n) * TAU;
    const r = rosetteRadiusAt(vis, 1, phi) * scale;
    const x = cx + r * Math.cos(phi);
    const y = cy - r * Math.sin(phi);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
  const pump = ro.axis === 'pump';
  const g = ctx.createRadialGradient(cx - 8, cy - 9, 2, cx, cy, THUMB / 2);
  g.addColorStop(0, pump ? c.b100 : c.b200);
  g.addColorStop(0.45, pump ? c.steel : c.b300);
  g.addColorStop(1, pump ? c.b700 : c.b600);
  ctx.fillStyle = g;
  ctx.shadowColor = 'rgba(0,0,0,0.6)';
  ctx.shadowBlur = 4;
  ctx.shadowOffsetY = 1.5;
  ctx.fill();
  ctx.shadowColor = 'transparent';
  ctx.lineWidth = 0.8;
  ctx.strokeStyle = c.b100;
  ctx.globalAlpha = 0.7;
  ctx.stroke();
  ctx.globalAlpha = 1;

  // Turned rings on the face, then the arbor hole.
  ctx.strokeStyle = c.b700;
  ctx.lineWidth = 0.6;
  for (const rr of [0.62, 0.48]) {
    ctx.beginPath();
    ctx.arc(cx, cy, scale * rr, 0, TAU);
    ctx.stroke();
  }
  ctx.beginPath();
  ctx.arc(cx, cy, 4.2, 0, TAU);
  ctx.fillStyle = c.ink;
  ctx.fill();
  ctx.strokeStyle = c.b800;
  ctx.lineWidth = 1;
  ctx.stroke();

  // The rubber riding the cam at angle 0.
  const rr = 2.2 + Math.min(1, rubber / 12) * 3.2;
  const edge = rosetteRadiusAt(vis, 1, 0) * scale;
  ctx.beginPath();
  ctx.arc(cx + edge + rr + 0.4, cy, rr, 0, TAU);
  ctx.fillStyle = c.ink;
  ctx.fill();
  ctx.strokeStyle = c.steel;
  ctx.lineWidth = 1;
  ctx.stroke();
}

function profileLabel(p: Rosette['profile']): string {
  const opt = ROSETTE_PARAMS.find((d) => d.key === 'profile')?.options?.find((o) => o.value === p);
  return (opt?.label ?? p).replace(/\s*\(.*\)$/, '');
}

interface Card {
  id: string;
  el: HTMLElement;
  update(s: AppState, index: number, total: number): void;
}

function createCard(store: Store, id: string, animate: boolean): Card {
  const canvas = h('canvas', { class: 're-thumb size-[60px] flex-none', role: 'img' });
  const title = h('h3', { class: 'font-display text-[17px] italic leading-none text-vellum' });
  const tag = h('span', { class: 're-tag px-1 py-px text-[9.5px] uppercase leading-none' });
  const summary = h('p', { class: 're-figures mt-1.5 truncate text-[12px] text-smoke' });
  const enable = switchButton('Enable rosette', (next) =>
    store.setRecipe((d) => {
      const r = d.rosettes.find((x) => x.id === id);
      if (r) r.enabled = next;
    }),
  );
  const remove = h(
    'button',
    {
      type: 'button',
      class: 're-quiet size-8 flex-none hover:text-garnet',
      onClick: () => {
        if (store.get().recipe.rosettes.length <= 1) return;
        store.setRecipe((d) => {
          d.rosettes = d.rosettes.filter((x) => x.id !== id);
        });
      },
    },
    icon('trash', 'size-4'),
  );
  const head = h(
    'header',
    { class: 'flex items-center gap-3 p-3 pb-2' },
    canvas,
    h('div', { class: 'min-w-0 flex-1' }, h('div', { class: 'flex items-center gap-2' }, title, tag), summary),
    enable.el,
    remove,
  );
  const body = h('div', { class: 're-card-body pb-2' });
  const el = h('article', { class: animate ? 're-card re-card-enter' : 're-card', 'data-rosette': id }, head, body);

  const controls = new Map<string, Control>();
  const control = (key: string): Control => {
    let c = controls.get(key);
    if (c) return c;
    const def = ROSETTE_PARAMS.find((d) => d.key === key)!;
    c = paramControl(
      def,
      {
        store,
        read: (r: Recipe) => {
          const ro = r.rosettes.find((x) => x.id === id);
          return ro ? (ro as unknown as Record<string, unknown>)[key] : undefined;
        },
        write: (v, opts) =>
          store.setRecipe((d) => {
            const ro = d.rosettes.find((x) => x.id === id);
            if (ro) (ro as unknown as Record<string, unknown>)[key] = v;
          }, opts),
        lockKey: `rosettes.${id}.${key}`,
        inheritLockKey: 'rosettes',
      },
      key,
    );
    c.el.classList.replace('px-5', 'px-3');
    controls.set(key, c);
    return c;
  };

  let thumbSig = '';
  return {
    id,
    el,
    update(s, index, total) {
      const ro = s.recipe.rosettes.find((x) => x.id === id);
      if (!ro) return;
      const name = `Rosette ${roman(index + 1)}`;
      title.textContent = name;
      tag.textContent = ro.axis === 'pump' ? 'Pump' : 'Rock';
      summary.textContent = `${ro.lobes} lobe${ro.lobes === 1 ? '' : 's'} · ${profileLabel(ro.profile)}`;
      el.dataset.enabled = String(ro.enabled);
      enable.set(ro.enabled);
      enable.el.setAttribute('aria-label', `Enable ${name}`);
      enable.el.dataset.tip = ro.enabled ? `Disengage ${name}` : `Engage ${name}`;
      remove.disabled = total <= 1;
      remove.setAttribute('aria-label', `Remove ${name}`);
      remove.dataset.tip = total <= 1 ? 'The stack needs at least one rosette' : `Remove ${name}`;
      canvas.setAttribute('aria-label', `${profileLabel(ro.profile)} rosette, ${ro.lobes} lobes`);

      const sig = `${ro.lobes}|${ro.amplitude}|${ro.profile}|${ro.phase}|${ro.axis}|${s.recipe.machine.rubberRadius}`;
      if (sig !== thumbSig) {
        thumbSig = sig;
        drawThumb(canvas, ro, s.recipe.machine.rubberRadius);
      }

      const adv = s.uiMode === 'advanced';
      const visible = ROSETTE_PARAMS.filter((d) => adv || d.simple).map((d) => control(d.key));
      reconcile(body, visible.map((c) => c.el));
      for (const c of visible) c.update(s);
    },
  };
}

export function rosetteStack(store: Store): { el: HTMLElement; update(s: AppState): void } {
  const stackLock = lockButton(store, 'rosettes', 'the whole rosette stack');
  const count = h('p', { class: 're-figures min-w-0 flex-1 truncate text-[12px] text-smoke' });
  const top = h(
    'div',
    { class: 'flex items-center gap-2 px-5 pb-2.5' },
    count,
    h('span', { class: 'text-[11px] uppercase tracking-[0.16em] text-smoke' }, 'Lock stack'),
    stackLock.el,
  );
  const list = h('div', { class: 'flex flex-col gap-3 px-4' });
  const add = h(
    'button',
    {
      type: 'button',
      class: 're-socket mx-4 mt-3 flex h-11 items-center justify-center gap-2 text-[13px] tracking-wide',
      'data-action': 'add-rosette',
      onClick: () => {
        store.setRecipe((d) => {
          d.rosettes.push(defaultRosette());
        });
        const last = list.lastElementChild;
        last?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      },
    },
    icon('plus', 'size-4'),
    'Add rosette',
  );
  const el = h('div', { class: 'flex flex-col pb-4' }, top, list, add);

  const cards = new Map<string, Card>();
  let mounted = false;

  return {
    el,
    update(s) {
      stackLock.update(s);
      const ros = s.recipe.rosettes;
      const rock = ros.filter((r) => r.axis === 'rock').length;
      const pump = ros.length - rock;
      count.textContent = `${ros.length} rosette${ros.length === 1 ? '' : 's'} · ${rock} rocking${pump ? `, ${pump} pumping` : ''}`;
      const ids = new Set(ros.map((r) => r.id));
      for (const id of [...cards.keys()]) if (!ids.has(id)) cards.delete(id);
      const ordered = ros.map((r) => {
        let c = cards.get(r.id);
        if (!c) {
          c = createCard(store, r.id, mounted);
          cards.set(r.id, c);
        }
        return c;
      });
      reconcile(list, ordered.map((c) => c.el));
      ordered.forEach((c, i) => c.update(s, i, ros.length));
      mounted = true;
    },
  };
}
