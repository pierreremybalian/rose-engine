// PBR materials and small procedural textures for the 3D rose engine (no external assets).
import * as THREE from 'three';

export interface MachineMaterials {
  /** Lacquered polished brass: rosettes, bushings, handwheels, fittings. */
  brass: THREE.MeshPhysicalMaterial;
  /** Satin (turned) brass for large faces. */
  brassSatin: THREE.MeshPhysicalMaterial;
  /** Polished steel: spindle, rods, tool. */
  steel: THREE.MeshPhysicalMaterial;
  /** Ground steel: slide ways, saddle, faceplate. */
  steelGround: THREE.MeshPhysicalMaterial;
  /** Black-oxide steel: screws, nuts, dark fittings. */
  steelDark: THREE.MeshPhysicalMaterial;
  /** Enamel-painted cast iron: bed, standards, pedestals. */
  iron: THREE.MeshPhysicalMaterial;
  /** Varnished mahogany bench top. */
  wood: THREE.MeshPhysicalMaterial;
  /** Dark turned wood for handles. */
  woodHandle: THREE.MeshPhysicalMaterial;
  /** Pen barrel (black resin). */
  penBody: THREE.MeshPhysicalMaterial;
  /** Pen colour band (set to the ink colour). */
  penBand: THREE.MeshPhysicalMaterial;
  /** Default work face before a surface material is supplied. */
  paper: THREE.MeshStandardMaterial;
  /** Plain metal for the work disc edge/back. */
  discEdge: THREE.MeshPhysicalMaterial;
  /** Dial indicator face. */
  dialFace: THREE.MeshStandardMaterial;
  /** Dial needle. */
  needle: THREE.MeshStandardMaterial;
  /** Engraved brass nameplate. */
  plate: THREE.MeshPhysicalMaterial;
  /** Dial-indicator crystal. */
  glass: THREE.MeshPhysicalMaterial;
  dispose(): void;
}

function canvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d');
  if (!ctx) throw new Error('2D canvas unavailable');
  return [c, ctx];
}

function mulberry(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Quarter-sawn mahogany: long wavy grain along u. */
function woodTexture(): THREE.CanvasTexture {
  const W = 1024;
  const H = 512;
  const [c, ctx] = canvas(W, H);
  const rnd = mulberry(7);
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, '#6b2f1c');
  g.addColorStop(0.5, '#7a3822');
  g.addColorStop(1, '#642a18');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  // Broad colour bands.
  for (let i = 0; i < 14; i++) {
    const y = rnd() * H;
    const h = 10 + rnd() * 50;
    ctx.fillStyle = `rgba(${rnd() < 0.5 ? '40,14,6' : '150,74,40'},${0.06 + rnd() * 0.08})`;
    ctx.fillRect(0, y, W, h);
  }
  // Fine grain lines with a slow wave.
  for (let i = 0; i < 260; i++) {
    const y0 = rnd() * H;
    const amp = 2 + rnd() * 6;
    const f1 = (0.5 + rnd() * 2) * (Math.PI * 2) / W;
    const ph = rnd() * 6.28;
    const dark = rnd() < 0.7;
    ctx.strokeStyle = dark ? `rgba(35,10,4,${0.1 + rnd() * 0.25})` : `rgba(170,90,50,${0.06 + rnd() * 0.12})`;
    ctx.lineWidth = 0.6 + rnd() * 1.6;
    ctx.beginPath();
    for (let x = 0; x <= W; x += 8) {
      const y = y0 + amp * Math.sin(x * f1 + ph) + 1.5 * Math.sin(x * f1 * 3.7 + ph * 2);
      if (x === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
  // Pores.
  for (let i = 0; i < 2500; i++) {
    ctx.fillStyle = `rgba(20,6,2,${0.15 + rnd() * 0.25})`;
    ctx.fillRect(rnd() * W, rnd() * H, 2 + rnd() * 5, 0.8);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  return t;
}

/** Fine random scratches/noise used as a roughness map to break up perfectly uniform metal. */
function grainTexture(seed: number, base: number, spread: number, streaks: boolean): THREE.CanvasTexture {
  const S = 256;
  const [c, ctx] = canvas(S, S);
  const rnd = mulberry(seed);
  const img = ctx.createImageData(S, S);
  for (let i = 0; i < S * S; i++) {
    const v = Math.max(0, Math.min(255, (base + (rnd() - 0.5) * spread) * 255));
    img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = v;
    img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  if (streaks) {
    for (let i = 0; i < 400; i++) {
      const y = rnd() * S;
      const l = 20 + rnd() * 120;
      const x = rnd() * S;
      ctx.strokeStyle = `rgba(${rnd() < 0.5 ? '0,0,0' : '255,255,255'},${0.05 + rnd() * 0.08})`;
      ctx.lineWidth = 0.5 + rnd();
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + l, y + (rnd() - 0.5) * 2);
      ctx.stroke();
    }
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

/** Dial-indicator face: 100 divisions, 0.01 mm. */
function dialTexture(): THREE.CanvasTexture {
  const S = 512;
  const [c, ctx] = canvas(S, S);
  const cx = S / 2;
  ctx.fillStyle = '#f3efe4';
  ctx.beginPath();
  ctx.arc(cx, cx, cx, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = '#1b1b1b';
  ctx.fillStyle = '#1b1b1b';
  for (let i = 0; i < 100; i++) {
    const a = (i / 100) * Math.PI * 2 - Math.PI / 2;
    const long = i % 10 === 0;
    const mid = i % 5 === 0;
    const r0 = cx * (long ? 0.74 : mid ? 0.8 : 0.84);
    const r1 = cx * 0.93;
    ctx.lineWidth = long ? 5 : mid ? 3.5 : 2;
    ctx.beginPath();
    ctx.moveTo(cx + r0 * Math.cos(a), cx + r0 * Math.sin(a));
    ctx.lineTo(cx + r1 * Math.cos(a), cx + r1 * Math.sin(a));
    ctx.stroke();
    if (long) {
      ctx.font = 'bold 38px Georgia, "Times New Roman", serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const rr = cx * 0.6;
      ctx.fillText(String(i), cx + rr * Math.cos(a), cx + rr * Math.sin(a));
    }
  }
  ctx.font = 'italic 26px Georgia, serif';
  ctx.textAlign = 'center';
  ctx.fillText('0.01 mm', cx, cx + cx * 0.32);
  ctx.strokeStyle = '#7a1d1d';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(cx, cx, cx * 0.965, 0, Math.PI * 2);
  ctx.stroke();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

/** Engraved nameplate: dark letters on brass (used as a multiply map on brass). */
function plateTexture(): THREE.CanvasTexture {
  const W = 1024;
  const H = 256;
  const [c, ctx] = canvas(W, H);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = '#3a2a10';
  ctx.lineWidth = 6;
  ctx.strokeRect(18, 18, W - 36, H - 36);
  ctx.lineWidth = 2;
  ctx.strokeRect(32, 32, W - 64, H - 64);
  ctx.fillStyle = '#3a2a10';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = '600 92px Georgia, "Times New Roman", serif';
  ctx.fillText('ROSE  ENGINE', W / 2, H / 2 - 14);
  ctx.font = 'italic 34px Georgia, serif';
  ctx.fillText('guilloché  ·  N° 1', W / 2, H / 2 + 62);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

export function createMaterials(): MachineMaterials {
  const textures: THREE.Texture[] = [];
  const keep = <T extends THREE.Texture>(t: T): T => {
    textures.push(t);
    return t;
  };
  const brassRough = keep(grainTexture(11, 0.55, 0.25, true));
  const steelRough = keep(grainTexture(23, 0.6, 0.3, true));
  const ironRough = keep(grainTexture(31, 0.75, 0.35, false));
  brassRough.repeat.set(3, 3);
  steelRough.repeat.set(2, 2);
  ironRough.repeat.set(4, 4);

  const wood = keep(woodTexture());
  const dial = keep(dialTexture());
  const plate = keep(plateTexture());

  const m: Omit<MachineMaterials, 'dispose'> = {
    brass: new THREE.MeshPhysicalMaterial({
      name: 'brass',
      color: '#d9ad55',
      metalness: 1,
      roughness: 0.2,
      clearcoat: 0.55,
      clearcoatRoughness: 0.12,
    }),
    brassSatin: new THREE.MeshPhysicalMaterial({
      name: 'brassSatin',
      color: '#d2a24c',
      metalness: 1,
      roughness: 0.36,
      roughnessMap: brassRough,
      clearcoat: 0.35,
      clearcoatRoughness: 0.2,
    }),
    steel: new THREE.MeshPhysicalMaterial({
      name: 'steel',
      color: '#aeb4ba',
      metalness: 1,
      roughness: 0.24,
    }),
    steelGround: new THREE.MeshPhysicalMaterial({
      name: 'steelGround',
      color: '#9ea4aa',
      metalness: 1,
      roughness: 0.4,
      roughnessMap: steelRough,
    }),
    steelDark: new THREE.MeshPhysicalMaterial({
      name: 'steelDark',
      color: '#2c3036',
      metalness: 0.85,
      roughness: 0.35,
    }),
    iron: new THREE.MeshPhysicalMaterial({
      name: 'iron',
      color: '#1d2a25',
      metalness: 0.15,
      roughness: 0.5,
      roughnessMap: ironRough,
      clearcoat: 0.6,
      clearcoatRoughness: 0.25,
    }),
    wood: new THREE.MeshPhysicalMaterial({
      name: 'wood',
      map: wood,
      color: '#8a6a5c',
      metalness: 0,
      roughness: 0.62,
      clearcoat: 0.12,
      clearcoatRoughness: 0.4,
    }),
    woodHandle: new THREE.MeshPhysicalMaterial({
      name: 'woodHandle',
      color: '#3b1a10',
      metalness: 0,
      roughness: 0.35,
      clearcoat: 0.7,
      clearcoatRoughness: 0.1,
    }),
    penBody: new THREE.MeshPhysicalMaterial({
      name: 'penBody',
      color: '#121316',
      metalness: 0,
      roughness: 0.3,
      clearcoat: 0.8,
      clearcoatRoughness: 0.08,
    }),
    penBand: new THREE.MeshPhysicalMaterial({
      name: 'penBand',
      color: '#1d2a5c',
      metalness: 0,
      roughness: 0.35,
      clearcoat: 0.6,
    }),
    paper: new THREE.MeshStandardMaterial({ name: 'paper', color: '#f4efe4', roughness: 0.9, metalness: 0 }),
    discEdge: new THREE.MeshPhysicalMaterial({
      name: 'discEdge',
      color: '#cfd3d6',
      metalness: 1,
      roughness: 0.3,
    }),
    dialFace: new THREE.MeshStandardMaterial({ name: 'dialFace', map: dial, roughness: 0.55, metalness: 0 }),
    needle: new THREE.MeshStandardMaterial({ name: 'needle', color: '#111111', roughness: 0.4, metalness: 0.3 }),
    plate: new THREE.MeshPhysicalMaterial({
      name: 'plate',
      map: plate,
      color: '#e2b85e',
      metalness: 1,
      roughness: 0.3,
      clearcoat: 0.4,
    }),
    glass: new THREE.MeshPhysicalMaterial({
      name: 'glass',
      color: '#ffffff',
      metalness: 0,
      roughness: 0.02,
      transparent: true,
      opacity: 0.18,
      depthWrite: false,
    }),
  };

  return {
    ...m,
    dispose() {
      for (const mat of Object.values(m)) (mat as THREE.Material).dispose();
      for (const t of textures) t.dispose();
    },
  };
}
