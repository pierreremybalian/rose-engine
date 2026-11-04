// Procedural photo-studio environment for the flat metal view. Guilloché only shimmers when the groove
// walls see strong contrast: a dark room, one big softbox (env +Y, rotated onto the light direction),
// a soft halo around it so flat metal gets a sheen gradient, and a couple of strip lights for sparkle.
import * as THREE from 'three';

const studioVert = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = normalize(position);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const studioFrag = /* glsl */ `
varying vec3 vDir;
uniform float uKey;
float band(float x, float a, float b, float soft) {
  return smoothstep(a - soft, a + soft, x) * (1.0 - smoothstep(b - soft, b + soft, x));
}
void main() {
  vec3 d = normalize(vDir);
  float c = d.y;                                   // cos(angle to the key light)
  float az = atan(d.x, d.z);                       // azimuth around the key axis
  // key softbox: a rounded square ~40° across
  vec2 q = d.xz / max(c, 1e-3);
  float box = (1.0 - smoothstep(0.30, 0.42, max(abs(q.x), abs(q.y)))) * step(0.0, c);
  float key = uKey * box;
  float halo = 1.7 * pow(max(c, 0.0), 4.0);
  // dim room, slightly brighter on the light side
  float room = mix(0.02, 0.12, smoothstep(-0.5, 0.9, c));
  // two strip lights on a ring ~70° from the key, at opposite sides
  float ring = band(acos(clamp(c, -1.0, 1.0)), 1.12, 1.28, 0.04);
  float strips = 2.4 * ring * (band(az, 1.2, 1.55, 0.06) + band(az, -2.0, -1.7, 0.06));
  // faint warm floor bounce opposite the key
  float floorb = 0.05 * smoothstep(-0.2, -0.9, c);
  vec3 col = vec3(room + halo + floorb) + vec3(1.0, 0.98, 0.95) * (key + strips);
  gl_FragColor = vec4(col, 1.0);
}
`;

export function createStudioScene(keyIntensity = 9): THREE.Scene {
  const scene = new THREE.Scene();
  const mat = new THREE.ShaderMaterial({
    vertexShader: studioVert,
    fragmentShader: studioFrag,
    uniforms: { uKey: { value: keyIntensity } },
    side: THREE.BackSide,
    depthWrite: false,
    toneMapped: false,
  });
  const sphere = new THREE.Mesh(new THREE.SphereGeometry(50, 96, 48), mat);
  scene.add(sphere);
  return scene;
}

export function createStudioEnvironment(renderer: THREE.WebGLRenderer): THREE.Texture {
  const pmrem = new THREE.PMREMGenerator(renderer);
  const scene = createStudioScene();
  const tex = pmrem.fromScene(scene, 0, 0.1, 200).texture;
  pmrem.dispose();
  scene.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh) {
      m.geometry.dispose();
      (m.material as THREE.Material).dispose();
    }
  });
  return tex;
}
