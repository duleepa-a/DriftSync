import * as THREE from 'three';

export const NISSAN_ASSET = '/assets/2022_lb-silhouette_works_gt_nissan_35gt-rr_r35.glb';

// Convert the supplied centimetre-scale Sketchfab hierarchy into the game's
// metre-scale, +Z-forward car coordinates. Bake once; every player shares it.
export function prepareNissan(source) {
  source.rotation.y = Math.PI;
  source.updateMatrixWorld(true);
  const bounds = new THREE.Box3().setFromObject(source);
  const center = bounds.getCenter(new THREE.Vector3());
  const scale = 4.8 / (bounds.max.z - bounds.min.z);
  const normalize = new THREE.Matrix4().makeScale(scale, scale, scale)
    .multiply(new THREE.Matrix4().makeTranslation(-center.x, -bounds.min.y, -center.z));
  const car = new THREE.Group();
  car.name = 'nissan-2022-template';
  const wheelRoots = new Map();
  const wheelNames = [
    ['body_unref_unblend.003', 'wheel_fl'], ['body_unref_unblend.004', 'wheel_fr'],
    ['body_unref_unblend.001', 'wheel_rl'], ['body_unref_unblend.002', 'wheel_rr'],
  ];
  for (const [name, label] of wheelNames) {
    const node = source.getObjectByName(THREE.PropertyBinding.sanitizeNodeName(name));
    if (!node) throw new Error('Nissan wheel missing: ' + name);
    const transform = normalize.clone().multiply(node.matrixWorld);
    const pivot = new THREE.Group();
    pivot.name = label;
    pivot.position.setFromMatrixPosition(transform);
    // Preserve the authored camber while spinning about the wheel's axle.
    const axis = new THREE.Vector3(1, 0, 0).transformDirection(transform);
    if (axis.x < 0) axis.negate();
    const mount = new THREE.Group();
    mount.quaternion.setFromUnitVectors(new THREE.Vector3(1, 0, 0), axis);
    const spin = new THREE.Group();
    spin.name = 'wheel-spin';
    pivot.add(mount); mount.add(spin); car.add(pivot);
    car.updateMatrixWorld(true);
    wheelRoots.set(node, { spin, inverse: spin.matrixWorld.clone().invert() });
  }
  const originalGeometries = new Set();
  source.traverse(mesh => {
    if (!mesh.isMesh) return;
    let wheel;
    for (let node = mesh.parent; node; node = node.parent) {
      if (wheelRoots.has(node)) { wheel = wheelRoots.get(node); break; }
    }
    const transform = normalize.clone().multiply(mesh.matrixWorld);
    if (wheel) transform.premultiply(wheel.inverse);
    const geometry = mesh.geometry.clone().applyMatrix4(transform);
    const copy = new THREE.Mesh(geometry, mesh.material);
    copy.name = mesh.name;
    copy.castShadow = copy.receiveShadow = true;
    (wheel ? wheel.spin : car).add(copy);
    originalGeometries.add(mesh.geometry);
    // Avoid an extra transmission render of the whole scene for every car.
    if (mesh.material.name === 'glass' || mesh.material.name === 'lightglass') {
      mesh.material.transmission = 0;
      mesh.material.roughness = 0.18;
      mesh.material.specularIntensity = 1;
      mesh.material.depthWrite = false;
    }
  });
  originalGeometries.forEach(geometry => geometry.dispose());
  return car;
}

export function playerLivery(material, colour) {
  const paint = material.clone();
  paint.roughness = 0.38;
  paint.metalness = 0.25;
  paint.specularIntensity = 1;
  paint.clearcoatRoughness = 0.16;
  paint.envMapIntensity = 0.9;
  // Replace the yellow paint accents, retaining white/black livery and decals.
  // The player colour is a uniform, so clones can share the compiled program.
  paint.onBeforeCompile = shader => {
    shader.uniforms.playerColour = { value: new THREE.Color(colour) };
    shader.fragmentShader = 'uniform vec3 playerColour;\n' + shader.fragmentShader;
    shader.fragmentShader = shader.fragmentShader.replace('#include <map_fragment>', `
      #include <map_fragment>
      float paintMask = smoothstep(0.35, 0.65, diffuseColor.r)
        * smoothstep(0.25, 0.5, diffuseColor.g) * (1.0 - smoothstep(0.08, 0.3, diffuseColor.b));
      diffuseColor.rgb = mix(diffuseColor.rgb, playerColour * max(diffuseColor.r, diffuseColor.g), paintMask);
    `);
  };
  paint.customProgramCacheKey = () => 'nissan-player-livery-v1';
  return paint;
}
