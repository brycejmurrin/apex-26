import * as THREE from "three/webgpu";
import { backendName } from "./render/backend";

const canvas = document.querySelector<HTMLCanvasElement>("#game")!;
const label = document.querySelector<HTMLElement>("#backend")!;

const renderer = new THREE.WebGPURenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight, false);
await renderer.init();

const backend = backendName(renderer);
label.textContent = backend;
label.dataset.backend = backend;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0b0d12);
const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 100);
camera.position.set(2.5, 2, 3.5);
camera.lookAt(0, 0, 0);

scene.add(new THREE.HemisphereLight(0xbfd4ff, 0x202020, 1.2));
const sun = new THREE.DirectionalLight(0xffffff, 2.5);
sun.position.set(3, 5, 2);
scene.add(sun);

const cube = new THREE.Mesh(
  new THREE.BoxGeometry(1, 1, 1),
  new THREE.MeshStandardNodeMaterial({ color: 0xe10600, roughness: 0.4, metalness: 0.1 }),
);
scene.add(cube);

window.addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight, false);
});

renderer.setAnimationLoop((t: number) => {
  cube.rotation.set(t * 0.0005, t * 0.0008, 0);
  renderer.render(scene, camera);
});
