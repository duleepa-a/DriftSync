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

  source.traverse(mesh => {
    if (!mesh.isMesh) return;
    const transform = normalize.clone().multiply(mesh.matrixWorld);
    const geometry = mesh.geometry.clone().applyMatrix4(transform);
    const material = Array.isArray(mesh.material)
      ? mesh.material.map(item => item.clone())
      : mesh.material.clone();
    const copy = new THREE.Mesh(geometry, material);
    copy.name = mesh.name;
    copy.castShadow = copy.receiveShadow = true;
    car.add(copy);
  });
  return car;
}
