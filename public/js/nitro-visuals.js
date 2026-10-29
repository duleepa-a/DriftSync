import * as THREE from 'three';

export function createNitroVisuals(scene, pickups) {
  const cyan = new THREE.MeshStandardMaterial({ color: 0x18dcff, emissive: 0x00cfff, emissiveIntensity: 1.8, metalness: 0.6, roughness: 0.25 });
  const metal = new THREE.MeshStandardMaterial({ color: 0xd2f9ff, metalness: 0.8, roughness: 0.2 });
  const glow = new THREE.MeshBasicMaterial({ color: 0x39edff, transparent: true, opacity: 0.8, depthWrite: false, side: THREE.DoubleSide });
  const bottleGeometry = new THREE.CylinderGeometry(0.48, 0.48, 1.65, 12);
  const capGeometry = new THREE.CylinderGeometry(0.22, 0.32, 0.28, 10);
  const ringGeometry = new THREE.RingGeometry(1.8, 2.1, 32);
  const labelCanvas = document.createElement('canvas');
  labelCanvas.width = 256; labelCanvas.height = 128;
  const ctx = labelCanvas.getContext('2d');
  ctx.fillStyle = '#061d2b'; ctx.fillRect(8, 12, 240, 104);
  ctx.strokeStyle = '#a5f6ff'; ctx.lineWidth = 5; ctx.strokeRect(8, 12, 240, 104);
  ctx.fillStyle = '#edfeff'; ctx.font = 'bold 60px sans-serif'; ctx.textAlign = 'center';
  ctx.fillText('N₂O', 128, 86);
  const labelTexture = new THREE.CanvasTexture(labelCanvas);
  labelTexture.colorSpace = THREE.SRGBColorSpace;
  const labelMaterial = new THREE.SpriteMaterial({ map: labelTexture, depthWrite: false });
  const visuals = pickups.map((pickup) => {
    const root = new THREE.Group();
    root.name = 'nitro-' + pickup.id;
    root.position.set(pickup.pos.x, pickup.pos.y, pickup.pos.z);
    const ring = new THREE.Mesh(ringGeometry, glow);
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.18;
    root.add(ring);
    const bottle = new THREE.Group();
    bottle.add(new THREE.Mesh(bottleGeometry, cyan));
    const cap = new THREE.Mesh(capGeometry, metal);
    cap.position.y = 0.94;
    bottle.add(cap);
    root.add(bottle);
    const label = new THREE.Sprite(labelMaterial);
    label.position.y = 3.15;
    label.scale.set(2.6, 1.3, 1);
    root.add(label);
    scene.add(root);
    return { pickup, root, bottle, ring };
  });
  return {
    update(time) {
      for (const { pickup, root, bottle, ring } of visuals) {
        root.visible = pickup.cooldown === 0;
        bottle.position.y = 1.65 + Math.sin(time * 2.5 + pickup.index) * 0.2;
        bottle.rotation.z = Math.sin(time * 1.5) * 0.12;
        ring.scale.setScalar(1 + Math.sin(time * 3) * 0.06);
      }
    },
  };
}
