// Dev-only car demo (/car-demo.html): the procedural car under the renderer boot
// (src/render/boot.ts), on a ground plane with orbit controls. Query parameters:
//   team=<TEAM_STYLE id>   c1=rrggbb  c2=rrggbb   wheels=0   spin=0   smooth=0|1
//   cam=x,y,z  look=x,y,z   (camera position and orbit target, metres)
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import * as THREE from "three/webgpu";
import { createRenderer } from "../render/boot";
import { buildCar } from "./three";
import type { Vec3 } from "./types";

const q = new URLSearchParams(location.search);
const hex = (s: string | null, d: Vec3): Vec3 => {
  if (!s || !/^[0-9a-f]{6}$/i.test(s)) return d;
  const n = parseInt(s, 16);
  const lin = (v: number) => Math.pow(v / 255, 2.2);
  return [lin((n >> 16) & 255), lin((n >> 8) & 255), lin(n & 255)];
};

const canvas = document.querySelector<HTMLCanvasElement>("#game")!;
const info = document.querySelector<HTMLElement>("#info")!;
const { renderer, backend, reason } = await createRenderer(canvas);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight, false);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x8fa6bf);
const camera = new THREE.PerspectiveCamera(40, window.innerWidth / window.innerHeight, 0.05, 200);
const xyz = (s: string | null, d: [number, number, number]): [number, number, number] => {
  const v = (s ?? "").split(",").map(Number);
  return v.length === 3 && v.every(Number.isFinite) ? [v[0]!, v[1]!, v[2]!] : d;
};
camera.position.set(...xyz(q.get("cam"), [4.2, 1.8, 5.2]));
const controls = new OrbitControls(camera, canvas);
controls.target.set(...xyz(q.get("look"), [0, 0.4, 0]));
controls.update();

scene.add(new THREE.HemisphereLight(0xdfe8ff, 0x3a3630, 1.4));
const sun = new THREE.DirectionalLight(0xffffff, 3.0);
sun.position.set(4, 8, 3);
scene.add(sun);
const ground = new THREE.Mesh(new THREE.PlaneGeometry(40, 40), new THREE.MeshStandardNodeMaterial({ color: 0x3b3d40, roughness: 0.9 }));
ground.rotation.x = -Math.PI / 2;
scene.add(ground);

const team = q.get("team") ?? undefined;
const smooth = q.get("smooth");
const t0 = performance.now();
const car = buildCar({
  color: hex(q.get("c1"), [0.8, 0.05, 0.05]),
  color2: hex(q.get("c2"), [0.9, 0.9, 0.1]),
  build: { ...(team ? { teamId: team } : {}), ...(smooth != null ? { smooth: smooth === "1" } : {}) },
  noWheels: q.get("wheels") === "0",
});
const buildMs = performance.now() - t0;
scene.add(car.group);

const verts = car.body.geometry.getAttribute("position").count;
const box = car.body.geometry.boundingBox!;
const size = box.getSize(new THREE.Vector3());
info.textContent = `${backend} (${reason})  team=${team ?? "default"}\n` +
  `body ${verts} verts, ${size.x.toFixed(2)} × ${size.y.toFixed(2)} × ${size.z.toFixed(2)} m, built in ${buildMs.toFixed(0)} ms`;
info.dataset.backend = backend;

window.addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight, false);
});

const spin = q.get("spin") !== "0";
renderer.setAnimationLoop((t: number) => {
  if (spin) car.setWheelPose(t * 0.004, t * 0.004, Math.sin(t * 0.001) * 0.3);
  controls.update();
  renderer.render(scene, camera);
});
