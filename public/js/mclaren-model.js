import * as THREE from 'three';

export const MCLAREN_ASSET = '/assets/2021_mclaren_720s_gt3x.glb';

export function prepareMclaren(source) {
  source.updateMatrixWorld(true);
  const bounds = new THREE.Box3().setFromObject(source);
  const size = bounds.getSize(new THREE.Vector3());
  const center = bounds.getCenter(new THREE.Vector3());
  const scale = 4.8 / Math.max(size.x, size.z);
  const normalize = new THREE.Matrix4().makeScale(scale, scale, scale)
    .multiply(new THREE.Matrix4().makeTranslation(-center.x, -bounds.min.y, -center.z));
  const car = new THREE.Group();
  car.name = 'mclaren-2021-template';
  const batches = new Map();

  source.traverse(mesh => {
    if (!mesh.isMesh) return;
    const transform = normalize.clone().multiply(mesh.matrixWorld);
    const geometry = mesh.geometry.clone().applyMatrix4(transform);
    const material = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
    const attributes = Object.keys(geometry.attributes).sort()
      .map(name => {
        const attribute = geometry.getAttribute(name);
        return `${name}:${attribute.itemSize}:${attribute.array.constructor.name}:${attribute.normalized}`;
      })
      .join('|');
    const key = `${material.uuid}:${attributes}`;
    if (!batches.has(key)) batches.set(key, { material, geometries: [] });
    batches.get(key).geometries.push(geometry);
  });
  for (const batch of batches.values()) {
    const geometry = mergeGeometries(batch.geometries);
    const material = batch.material.clone();
    // The imported windows and lamp covers enable physical transmission.
    // Even a small cover makes Three render the entire opaque scene again,
    // with a multisampled, mipmapped buffer for each player's view. Alpha
    // glass retains the tint, reflections and visible interior at a lower cost.
    if (material.transmission > 0) {
      material.transmission = 0;
      material.depthWrite = false;
      material.forceSinglePass = true;
    }
    const copy = new THREE.Mesh(geometry, material);
    copy.name = material.name;
    copy.castShadow = copy.receiveShadow = true;
    car.add(copy);
    batch.geometries.forEach(item => item.dispose());
  }
  // Keep the tire mesh batched, but expose its four actual wheel centers to
  // physics, skid marks and smoke. Empty pivots add no rendering draw calls.
  const tire = car.children.find(mesh => mesh.material.name.includes('_Wheel1A_'));
  if (!tire) throw new Error('McLaren tire geometry is missing');
  const positions = tire.geometry.getAttribute('position');
  const wheelBounds = Array.from({ length: 4 }, () => new THREE.Box3());
  const vertex = new THREE.Vector3();
  for (let i = 0; i < positions.count; i++) {
    vertex.fromBufferAttribute(positions, i);
    const index = (vertex.z < 0 ? 2 : 0) + (vertex.x > 0 ? 1 : 0);
    wheelBounds[index].expandByPoint(vertex);
  }
  ['wheel_fl', 'wheel_fr', 'wheel_rl', 'wheel_rr'].forEach((name, index) => {
    if (wheelBounds[index].isEmpty()) throw new Error('McLaren wheel missing: ' + name);
    const pivot = new THREE.Group();
    pivot.name = name;
    wheelBounds[index].getCenter(pivot.position);
    pivot.rotation.order = 'YXZ';
    car.add(pivot);
  });
  return car;
}

function mergeGeometries(geometries) {
  const first = geometries[0];
  const merged = new THREE.BufferGeometry();
  const vertexCount = geometries.reduce((total, geometry) => total + geometry.getAttribute('position').count, 0);
  for (const name of Object.keys(first.attributes)) {
    const source = first.getAttribute(name);
    const array = new source.array.constructor(vertexCount * source.itemSize);
    let offset = 0;
    for (const geometry of geometries) {
      const attribute = geometry.getAttribute(name);
      array.set(attribute.array, offset);
      offset += attribute.array.length;
    }
    merged.setAttribute(name, new THREE.BufferAttribute(array, source.itemSize, source.normalized));
  }

  const indices = [];
  let vertexOffset = 0;
  for (const geometry of geometries) {
    const position = geometry.getAttribute('position');
    const index = geometry.getIndex();
    if (index) {
      for (const value of index.array) indices.push(value + vertexOffset);
    } else {
      for (let i = 0; i < position.count; i++) indices.push(vertexOffset + i);
    }
    vertexOffset += position.count;
  }
  merged.setIndex(indices);
  return merged;
}
