import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { attachCarEffects, disposeCarEffects } from './car-effects.js';
import { MCLAREN_ASSET, prepareMclaren } from './mclaren-model.js';

/**
 * User-supplied 2021 McLaren 720S GT3X glTF.
 *  - loadCarAssets() loads the template once.
 *  - createCarMesh(color) returns a clone of the prepared model.
 * If the model fails to load, createCarMesh() falls back to a procedural car
 * so the game still runs.
 *
 * The returned Group's +Z faces forward and exposes:
 *   userData.wheels    [front-left, front-right, rear-left, rear-right]
 *   userData.brakeMaterials  independently controlled red tail-light materials
 */

let template = null;

export function loadCarAssets() {
  return new Promise((resolve) => {
    const draco = new DRACOLoader();
    draco.setDecoderPath('/jsm/libs/draco/gltf/');
    const loader = new GLTFLoader();
    loader.setDRACOLoader(draco);
    loader.load(
      MCLAREN_ASSET,
      (gltf) => {
        try {
          template = prepareMclaren(gltf.scene);
          resolve(true);
        } catch (error) {
          console.warn('McLaren model could not be prepared; using fallback car.', error);
          resolve(false);
        } finally { draco.dispose(); }
      },
      undefined,
      (err) => { draco.dispose(); console.warn('McLaren model failed to load; using fallback car.', err); resolve(false); }
    );
  });
}

export function createCarMesh(colorHex) {
  if (!template) return createFallbackCar(colorHex);

  const outer = new THREE.Group();
  const model = template.clone(true);
  const bodyPaint = model.getObjectByName('McLaren_720SGT3X_2021Coloured_Material')?.material;

  const brakeMaterials = [];
  const ownedMaterials = [];
  model.traverse((o) => {
    if (!o.isMesh || !o.material) return;
    const materials = Array.isArray(o.material) ? o.material : [o.material];
    const cloned = materials.map(material => material.clone());
    o.material = Array.isArray(o.material) ? cloned : cloned[0];
    cloned.forEach(material => {
      const name = material.name.toLowerCase();
      // The imported roof X/livery uses a separate dark material. Match both
      // its colour and finish to the body so it doesn't remain a matte stripe.
      if (name === 'phong1' && bodyPaint) {
        const materialName = material.name;
        material.copy(bodyPaint);
        material.name = materialName;
      }
      if (name.includes('paint') || name.includes('coloured') || name === 'phong1') {
        material.color = new THREE.Color(colorHex);
      }
      if (name.includes('lightemissive') || name.includes('lighta') || name.includes('taillight')) {
        material.color.set(0x550000);
        material.emissive = new THREE.Color(0xff0000);
        material.emissiveIntensity = 0.12;
        brakeMaterials.push(material);
      }
      ownedMaterials.push(material);
    });
  });

  outer.add(model);
  outer.userData.wheels = ['wheel_fl', 'wheel_fr', 'wheel_rl', 'wheel_rr']
    .map(name => model.getObjectByName(name));
  outer.userData.brakeMaterials = brakeMaterials;
  outer.userData.ownedMaterials = ownedMaterials;
  outer.userData.modelId = 'mclaren-2021';
  outer.userData.effectsLayout = {
    exhausts: [[-0.85, 0.32, -2.16], [-0.65, 0.32, -2.16], [0.65, 0.32, -2.16], [0.85, 0.32, -2.16]],
    reverse: [[-0.55, 0.68, -2.1], [0.55, 0.68, -2.1]],
  };
  attachCarEffects(outer);
  return outer;
}

export function disposeCarMesh(car) {
  if (!car) return;
  disposeCarEffects(car);
  if (car.userData.isFallback) {
    const resources = new Set();
    car.traverse((object) => {
      if (object.geometry) resources.add(object.geometry);
      if (object.material) {
        for (const material of Array.isArray(object.material) ? object.material : [object.material]) resources.add(material);
      }
    });
    for (const resource of resources) resource.dispose();
  } else {
    for (const material of car.userData.ownedMaterials || []) material.dispose();
  }
}

// ---------------------------------------------------------------------------
// Procedural fallback (used only if the glTF asset can't load)
// ---------------------------------------------------------------------------
function createFallbackCar(colorHex) {
  const car = new THREE.Group();
  const color = new THREE.Color(colorHex);
  const bodyMat = new THREE.MeshPhysicalMaterial({ color, metalness: 0.6, roughness: 0.32, clearcoat: 1, clearcoatRoughness: 0.12, envMapIntensity: 1.3 });
  const darkMat = new THREE.MeshStandardMaterial({ color: 0x111317, metalness: 0.4, roughness: 0.5 });
  const glassMat = new THREE.MeshPhysicalMaterial({ color: 0x0a1622, roughness: 0.06, clearcoat: 1, clearcoatRoughness: 0.05, envMapIntensity: 1.6, transparent: true, opacity: 0.75 });

  const lower = new THREE.Mesh(new THREE.BoxGeometry(2.0, 0.7, 4.2), bodyMat);
  lower.position.y = 0.6; lower.castShadow = true; car.add(lower);
  const cabin = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.6, 2.0), bodyMat);
  cabin.position.set(0, 1.15, -0.1); cabin.castShadow = true; car.add(cabin);
  const glass = new THREE.Mesh(new THREE.BoxGeometry(1.55, 0.5, 2.05), glassMat);
  glass.position.set(0, 1.18, -0.1); car.add(glass);

  const brakeMat = new THREE.MeshStandardMaterial({ color: 0x550000, emissive: 0xff0000, emissiveIntensity: 0.12 });
  for (const sx of [-0.6, 0.6]) {
    const bl = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.18, 0.1), brakeMat);
    bl.position.set(sx, 0.7, -2.12); car.add(bl);
  }

  const wheelGeo = new THREE.CylinderGeometry(0.55, 0.55, 0.5, 16);
  const wheelMat = new THREE.MeshStandardMaterial({ color: 0x101216, roughness: 0.8 });
  const wheels = [];
  for (const [x, z] of [[-1.05, 1.4], [1.05, 1.4], [-1.05, -1.4], [1.05, -1.4]]) {
    const w = new THREE.Group();
    const tire = new THREE.Mesh(wheelGeo, wheelMat);
    tire.rotation.z = Math.PI / 2; tire.castShadow = true; w.add(tire);
    w.position.set(x, 0.55, z); w.rotation.order = 'YXZ'; car.add(w); wheels.push(w);
  }
  car.userData.wheels = wheels;
  car.userData.brakeMaterials = [brakeMat];
  car.userData.isFallback = true;
  attachCarEffects(car);
  return car;
}
