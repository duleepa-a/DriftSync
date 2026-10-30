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
        float t = vUv.y;
        float ripple = sin(t * 28.0 - time * 23.0) * sin(t * 17.0 + time * 11.0);
        float radius = (1.0 - t) * (0.44 + ripple * 0.07);
        float x = abs(vUv.x - 0.5 + sin(t * 16.0 - time * 19.0) * t * 0.035);
        float alpha = (1.0 - smoothstep(radius * 0.35, max(radius, 0.001), x))
          * (1.0 - smoothstep(0.75, 1.0, t));
        float core = (1.0 - smoothstep(0.0, max(radius * 0.55, 0.001), x)) * (1.0 - t);
        vec3 color = mix(vec3(0.015, 0.22, 1.8), vec3(0.65, 1.8, 2.8), core);
        gl_FragColor = vec4(color, alpha * 0.85);
      }`,
  });
  // The car faces +Z; exhaust jets extend behind it along -Z.
  const flameGeometry = new THREE.PlaneGeometry(0.32, 1.0);
  flameGeometry.rotateX(-Math.PI / 2);
  flameGeometry.translate(0, 0, -0.5);
  const fallback = car.userData.isFallback;
  for (const x of fallback ? [-0.55, 0.55] : [-0.22, 0, 0.22]) {
    const jet = new THREE.Group();
    jet.position.set(x, fallback ? 0.45 : 0.34, fallback ? -2.2 : -2.26);
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
  for (const x of [-0.65, 0.65]) {
    const lamp = new THREE.Mesh(reverseGeometry, reverseMaterial);
    lamp.position.set(x, 0.55, fallback ? -2.16 : -2.27);
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
  const pulse = 1 + Math.sin(effects.time * 31) * 0.12;
  for (const jet of effects.flames.children) jet.scale.z = pulse;
  for (const material of p.mesh.userData.brakeMaterials || []) {
    material.emissiveIntensity = braking ? 1.4 : 0.12;
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
