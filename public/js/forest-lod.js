import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

export const FOREST_DETAIL = Object.freeze({ maxTrees: 8, fullDistance: 65, farDistance: 90 });

// One reusable instance pool per material, updated for each player's camera.
// Distant trees keep their existing cards; only selected close cards fade out.
export function prepareForestDetails(source, forest, root) {
  source.updateMatrixWorld(true);
  const bounds = new THREE.Box3().setFromObject(source);
  const center = bounds.getCenter(new THREE.Vector3());
  const size = 15.5 / (bounds.max.y - bounds.min.y);
  const normalize = new THREE.Matrix4().makeScale(size, size, size)
    .multiply(new THREE.Matrix4().makeTranslation(-center.x, -bounds.min.y, -center.z));
  const group = new THREE.Group();
  group.name = 'near-pine-forest';
  const fades = new THREE.InstancedBufferAttribute(new Float32Array(FOREST_DETAIL.maxTrees), 1);
  fades.setUsage(THREE.DynamicDrawUsage);
  const meshes = [];
  source.traverse(object => {
    if (!object.isMesh) return;
    const geometry = object.geometry.clone().applyMatrix4(normalize.clone().multiply(object.matrixWorld));
    geometry.setAttribute('nearFade', fades);
    const material = object.material.clone();
    material.roughness = Math.max(0.85, material.roughness);
    material.envMapIntensity = 0.6;
    material.transparent = false;
    material.depthWrite = true;
    material.onBeforeCompile = shader => {
      shader.vertexShader = 'attribute float nearFade;\nvarying float vNearFade;\n' + shader.vertexShader;
      shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\nvNearFade = nearFade;');
      shader.fragmentShader = 'varying float vNearFade;\n' + shader.fragmentShader;
      shader.fragmentShader = shader.fragmentShader.replace('#include <clipping_planes_fragment>', `
        #include <clipping_planes_fragment>
        if (vNearFade < 0.999) {
          float coverage = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
          if (coverage >= vNearFade) discard;
        }
      `);
    };
    material.customProgramCacheKey = () => 'near-pine-dither-v1';
    for (const key of ['map', 'normalMap', 'roughnessMap', 'metalnessMap']) {
      if (material[key]) material[key].anisotropy = 4;
    }
    const mesh = new THREE.InstancedMesh(geometry, material, FOREST_DETAIL.maxTrees);
    mesh.name = 'near-pine-' + material.name;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.count = 0;
    mesh.visible = false;
    // Selection already culls by camera and distance. Avoid stale pool bounds.
    mesh.frustumCulled = false;
    mesh.castShadow = mesh.receiveShadow = false;
    group.add(mesh);
    meshes.push(mesh);
  });
  root.add(group);
  const candidates = forest.userData.nearCandidates.map(index => {
    const matrix = new THREE.Matrix4();
    forest.getMatrixAt(index, matrix);
    const position = new THREE.Vector3(), rotation = new THREE.Quaternion(), scale = new THREE.Vector3();
    matrix.decompose(position, rotation, scale);
    const sphere = new THREE.Sphere(position.clone().add(new THREE.Vector3(0, 7.75 * scale.y, 0)), 10 * Math.max(scale.x, scale.y));
    return { index, matrix, position, sphere, distance: 0 };
  });
  const selected = [], cameraPosition = new THREE.Vector3(), tint = new THREE.Color();
  const projection = new THREE.Matrix4(), frustum = new THREE.Frustum();
  const cardFades = forest.geometry.getAttribute('treeNear');
  const controller = {
    enabled: true, meshes, selected,
    update(camera) {
      // Reset for EVERY viewport, including cameras far from any 3D tree.
      cardFades.array.fill(0);
      selected.length = 0;
      if (controller.enabled) {
        camera.updateMatrixWorld();
        cameraPosition.setFromMatrixPosition(camera.matrixWorld);
        frustum.setFromProjectionMatrix(projection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
        for (const candidate of candidates) {
          candidate.distance = cameraPosition.distanceTo(candidate.position);
          if (candidate.distance < FOREST_DETAIL.farDistance && frustum.intersectsSphere(candidate.sphere)) selected.push(candidate);
        }
        selected.sort((a, b) => a.distance - b.distance);
        selected.length = Math.min(selected.length, FOREST_DETAIL.maxTrees);
      }
      for (let i = 0; i < selected.length; i++) {
        const candidate = selected[i];
        const fade = 1 - THREE.MathUtils.smoothstep(candidate.distance, FOREST_DETAIL.fullDistance, FOREST_DETAIL.farDistance);
        fades.setX(i, fade);
        cardFades.setX(candidate.index, fade);
        forest.getColorAt(candidate.index, tint);
        for (const mesh of meshes) {
          mesh.setMatrixAt(i, candidate.matrix);
          mesh.setColorAt(i, tint);
        }
      }
      cardFades.needsUpdate = fades.needsUpdate = true;
      for (const mesh of meshes) {
        mesh.count = selected.length;
        mesh.visible = selected.length > 0;
        mesh.instanceMatrix.needsUpdate = true;
        if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      }
    },
  };
  return controller;
}

export async function loadForestDetails(scene) {
  const root = scene.getObjectByName('track-scenery');
  const forest = scene.getObjectByName('instanced-pine-forest');
  root.userData.forestDetailsReady = false;
  try {
    const gltf = await new GLTFLoader().loadAsync('/assets/pine-tree-optimized.glb');
    root.userData.forestDetails = prepareForestDetails(gltf.scene, forest, root);
    // Source geometries are baked once; the instance pools share their copies.
    gltf.scene.traverse(object => { if (object.isMesh) object.geometry.dispose(); });
    root.userData.forestDetailsReady = true;
  } catch (error) {
    root.userData.forestDetailsError = true;
    console.warn('3D pines failed to load; keeping the billboard forest.', error);
  }
}
