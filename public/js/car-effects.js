import * as THREE from 'three';

export function attachCarEffects(car) {
  const root = new THREE.Group();
  root.name = 'car-effects';
  const flames = new THREE.Group();
  flames.name = 'nitro-flames';
  flames.visible = false;
  const flameMaterial = new THREE.ShaderMaterial({
    uniforms: { time: { value: 0 } },
    transparent: true, depthWrite: false, side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending, toneMapped: false,
    vertexShader: `varying vec2 vUv;
      void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: `uniform float time; varying vec2 vUv;
      void main() {
        float t = vUv.y; // zero at the outlet, one at the flame tip
        float turbulence = sin(t * 35.0 - time * 29.0) * 0.018
          + sin(t * 67.0 + time * 43.0) * 0.009;
        float centre = 0.5 + turbulence * t;
        float width = mix(0.35, 0.025, pow(t, 0.8));
        float radial = abs(vUv.x - centre);
        float sheath = 1.0 - smoothstep(width * 0.55, width * 1.15, radial);
        float core = (1.0 - smoothstep(0.0, width * 0.38, radial))
          * pow(1.0 - t, 1.4);
        float alpha = sheath * (1.0 - smoothstep(0.52, 1.0, t))
          * (0.45 + 0.55 * core);
        vec3 blue = vec3(0.015, 0.18, 1.1);
        vec3 hot = vec3(0.42, 1.15, 2.0);
        gl_FragColor = vec4(mix(blue, hot, core), alpha * 0.75);
      }`,
  });
  // The car faces +Z; exhaust jets extend behind it along -Z.
  const flameGeometry = new THREE.PlaneGeometry(0.38, 0.72);
  flameGeometry.rotateX(-Math.PI / 2);
  flameGeometry.translate(0, 0, -0.36);
  const fallback = car.userData.isFallback;
  const exhausts = car.userData.effectsLayout?.exhausts || (fallback ? [-0.55, 0.55] : [-0.22, 0, 0.22])
    .map(x => [x, fallback ? 0.45 : 0.34, fallback ? -2.2 : -2.26]);
  for (const [index, position] of exhausts.entries()) {
    const jet = new THREE.Group();
    jet.position.fromArray(position);
    jet.userData.phase = index * 1.7;
    for (const angle of [0, Math.PI / 2]) {
      const flame = new THREE.Mesh(flameGeometry, flameMaterial);
      flame.rotation.z = angle;
      jet.add(flame);
    }
    flames.add(jet);
  }
  root.add(flames);

  const reverseMaterial = new THREE.MeshStandardMaterial({
    color: 0x555555, emissive: 0xffffff, emissiveIntensity: 0, roughness: 0.25,
  });
  const reverseGeometry = new THREE.BoxGeometry(0.22, 0.08, 0.04);
  const reverse = car.userData.effectsLayout?.reverse || [-0.65, 0.65].map(x => [x, 0.55, fallback ? -2.16 : -2.27]);
  for (const position of reverse) {
    const lamp = new THREE.Mesh(reverseGeometry, reverseMaterial);
    lamp.position.fromArray(position);
    root.add(lamp);
  }
  car.add(root);
  car.userData.effects = { root, flames, flameMaterial, reverseMaterial, time: 0 };
}

export function updateCarEffects(p, dt) {
  const reversing = p.speed < -0.2;
  const braking = (p.input.brake || 0) > 0.02 && !reversing;
  const boosting = p.nitroTime > 0 && p.speed > 0 && !braking && !p.finished;
  // Ease the camera and blur in/out without shaking or a sudden zoom jump.
  p.nitroVisual = (p.nitroVisual || 0) + ((boosting ? 1 : 0) - (p.nitroVisual || 0)) * (1 - Math.exp(-dt * 8));
  const effects = p.mesh.userData.effects;
  if (!effects) return;
  effects.time += dt;
  effects.flames.visible = boosting;
  effects.flameMaterial.uniforms.time.value = effects.time;
  for (const jet of effects.flames.children) {
    const phase = jet.userData.phase;
    jet.scale.z = 0.95 + Math.sin(effects.time * 31 + phase) * 0.09
      + Math.sin(effects.time * 47 + phase * 2) * 0.04;
  }
  for (const material of p.mesh.userData.brakeMaterials || []) {
    // Saturated red has low luminance: use an HDR emitter so only the lamp
    // crosses the bloom threshold, rather than making the asphalt bloom too.
    material.emissiveIntensity = braking ? 6 : 0.12;
  }
  effects.reverseMaterial.emissiveIntensity = reversing ? 3 : 0;
}

export function disposeCarEffects(car) {
  const effects = car.userData.effects;
  if (!effects) return;
  const resources = new Set();
  effects.root.traverse(object => {
    if (object.geometry) resources.add(object.geometry);
    if (object.material) resources.add(object.material);
  });
  for (const resource of resources) resource.dispose();
  car.remove(effects.root);
  delete car.userData.effects;
}
