import * as THREE from 'three';

export type LabelMapping = {
  mode: 'planar' | 'cylindrical' | 'uv';
  face: 'front' | 'back' | 'left' | 'right' | 'top' | 'bottom';
  scale: [number, number];
  offset: [number, number];
  rotationDegrees: number;
};

/** Mapping coordinates are product-component local, before assembly/animation. */
export function projectLabelPoint(point: THREE.Vector3, size: number[], mapping: LabelMapping): [number, number] {
  const [x, y, z] = point.toArray();
  if (mapping.mode === 'cylindrical') return [Math.atan2(x, z) / (2 * Math.PI) + .5, y / size[1] + .5];
  switch (mapping.face) {
    case 'back': return [-x / size[0] + .5, y / size[1] + .5];
    case 'right': return [-z / size[2] + .5, y / size[1] + .5];
    case 'left': return [z / size[2] + .5, y / size[1] + .5];
    case 'top': return [x / size[0] + .5, -z / size[2] + .5];
    case 'bottom': return [x / size[0] + .5, z / size[2] + .5];
    default: return [x / size[0] + .5, y / size[1] + .5];
  }
}

export function labelFaceCoverage(normal: THREE.Vector3, mapping: LabelMapping): number {
  if (mapping.mode === 'uv') return 1;
  if (mapping.mode === 'cylindrical') return Math.abs(normal.y) < .95 ? 1 : 0;
  const facing = mapping.face === 'back' ? -normal.z : mapping.face === 'right' ? normal.x
    : mapping.face === 'left' ? -normal.x : mapping.face === 'top' ? normal.y : mapping.face === 'bottom' ? -normal.y : normal.z;
  return facing > 0 ? 1 : 0;
}

/** Positive offsets move the artwork right/up. Scale precedes inverse rotation. */
export function transformLabelUv(uv: readonly number[], mapping: LabelMapping): [number, number] {
  let deltaX = uv[0] - .5 - mapping.offset[0];
  if (mapping.mode === 'cylindrical') deltaX -= Math.floor(deltaX + .5);
  const x = deltaX / mapping.scale[0];
  const y = (uv[1] - .5 - mapping.offset[1]) / mapping.scale[1];
  const angle = -mapping.rotationDegrees * Math.PI / 180;
  return [Math.cos(angle) * x - Math.sin(angle) * y + .5, Math.sin(angle) * x + Math.cos(angle) * y + .5];
}

/** Keep triangles crossing the cylindrical rear seam contiguous. */
export function unwrapLabelSeam(uvs: [number, number][]): void {
  if (Math.max(...uvs.map(uv => uv[0])) - Math.min(...uvs.map(uv => uv[0])) > .5) {
    for (const uv of uvs) if (uv[0] < .5) uv[0] += 1;
  }
}

/** Returns an owned geometry, preserving all original UV/material groups. */
export function labelGeometry(geometry: THREE.BufferGeometry, componentFromMesh: THREE.Matrix4,
    size: number[], mapping: LabelMapping): THREE.BufferGeometry {
  if (mapping.mode === 'uv' && !geometry.getAttribute('uv')) {
    throw new Error('This mesh has no UV map. Choose a flat or cylindrical label, or import a mesh with UV coordinates.');
  }
  const result = geometry.index ? geometry.toNonIndexed() : geometry.clone();
  const positions = result.getAttribute('position');
  const sourceUv = result.getAttribute('uv');
  const values = new Float32Array(positions.count * 2);
  const coverage = new Float32Array(positions.count);
  const points = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
  const normal = new THREE.Vector3();
  const edge = new THREE.Vector3();
  const normalMatrix = new THREE.Matrix3().getNormalMatrix(componentFromMesh);
  for (let index = 0; index + 2 < positions.count; index += 3) {
    points.forEach((point, corner) => point.fromBufferAttribute(positions, index + corner));
    normal.subVectors(points[1], points[0]).cross(edge.subVectors(points[2], points[0])).applyNormalMatrix(normalMatrix);
    points.forEach(point => point.applyMatrix4(componentFromMesh));
    const visible = labelFaceCoverage(normal, mapping);
    const uvs = points.map((point, corner): [number, number] => mapping.mode === 'uv'
      ? [sourceUv.getX(index + corner), 1 - sourceUv.getY(index + corner)] : projectLabelPoint(point, size, mapping));
    if (mapping.mode === 'cylindrical') unwrapLabelSeam(uvs);
    uvs.forEach((uv, corner) => {
      values.set(uv, (index + corner) * 2);
      coverage[index + corner] = visible;
    });
  }
  result.setAttribute('labelUv', new THREE.BufferAttribute(values, 2));
  result.setAttribute('labelCoverage', new THREE.BufferAttribute(coverage, 1));
  return result;
}

/** UV wireframe of the actual surface, in the same v-up coordinates as artwork. */
export function labelTemplateSvg(geometries: THREE.BufferGeometry[], name: string, edgeLimit = 20000): string {
  const segments = new Map<string, string>();
  let truncated = false;
  for (const geometry of geometries) {
    const uv = geometry.getAttribute('labelUv');
    const coverage = geometry.getAttribute('labelCoverage');
    for (let index = 0; index + 2 < uv.count; index += 3) {
      if (!coverage.getX(index)) continue;
      for (const [a, b] of [[0, 1], [1, 2], [2, 0]]) {
        const first = [uv.getX(index + a), uv.getY(index + a)];
        const second = [uv.getX(index + b), uv.getY(index + b)];
        const key = [first.map(value => value.toFixed(6)).join(','), second.map(value => value.toFixed(6)).join(',')].sort().join(':');
        if (segments.has(key)) continue;
        if (segments.size >= edgeLimit) { truncated = true; break; }
        segments.set(key, `M${(first[0] * 1024).toFixed(3)},${((1 - first[1]) * 1024).toFixed(3)}L${(second[0] * 1024).toFixed(3)},${((1 - second[1]) * 1024).toFixed(3)}`);
      }
      if (truncated) break;
    }
    if (truncated) break;
  }
  if (!segments.size) throw new Error('No surface faces match this label direction. Choose another face or mapping.');
  const escaped = name.replace(/[&<>"']/g, value => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[value]!);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024"><title>${escaped} label UV layout</title><desc>Place artwork above the guides, then hide the UV guides before exporting a transparent PNG.${truncated ? ' Wireframe detail limited to 20000 edges.' : ''}</desc><defs><clipPath id="artboard"><path d="M0 0H1024V1024H0Z"/></clipPath></defs><g id="uv-guides" fill="none" stroke="#999" stroke-width="0.65" clip-path="url(#artboard)"><path d="${Array.from(segments.values()).join('')}"/></g><g id="artwork"/></svg>`;
}

/** Reject image bombs/mismatches before handing verified bytes to the decoder. */
export function labelImageDimensions(bytes: ArrayBuffer, format: 'png' | 'jpg'): [number, number] {
  const data = new Uint8Array(bytes); const view = new DataView(bytes);
  let width = 0; let height = 0;
  if (format === 'png') {
    if (data.length < 33 || ![137, 80, 78, 71, 13, 10, 26, 10].every((value, i) => data[i] === value)
        || view.getUint32(8) !== 13 || view.getUint32(12) !== 0x49484452) throw new Error('The label image is not a complete PNG.');
    width = view.getUint32(16); height = view.getUint32(20);
  } else {
    if (data.length < 4 || data[0] !== 255 || data[1] !== 216) throw new Error('The label image is not a JPEG.');
    for (let cursor = 2; cursor + 3 < data.length;) {
      if (data[cursor++] !== 255) throw new Error('The label JPEG header is invalid.');
      while (data[cursor] === 255) cursor++;
      const marker = data[cursor++];
      if (marker === 0xda || marker === 0xd9) break;
      if (marker === 1 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (cursor + 2 > data.length) break;
      const length = view.getUint16(cursor);
      if (length < 2 || cursor + length > data.length) throw new Error('The label JPEG is truncated.');
      if ([0xc0, 0xc1, 0xc2].includes(marker)) {
        if (length < 8) throw new Error('The label JPEG dimensions are invalid.');
        height = view.getUint16(cursor + 3); width = view.getUint16(cursor + 5); break;
      }
      cursor += length;
    }
  }
  if (!width || !height || width > 8192 || height > 8192 || width * height > 32000000) {
    throw new Error('Label images must be at most 8192 pixels per side and 32 megapixels.');
  }
  return [width, height];
}
