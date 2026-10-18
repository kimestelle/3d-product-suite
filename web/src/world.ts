import {Color, Euler, Quaternion, SRGBColorSpace, Vector3} from 'three';

export type StudioLight = {id: string; name: string; enabled: boolean; positionM: number[]; targetM: number[]; powerW: number; diameterM: number; color: number[]};
export type HdriLighting = {asset: {path: string; sha256: string; format: 'hdr'}; name: string; sourceUrl: string; intensity: number; rotationDeg: number};
export type StudioLighting = {ambientStrength: number; lights: StudioLight[]; hdri?: HdriLighting};
export const PLINTH_MATERIAL = {baseColor: [.56, .54, .49, 1], roughness: .58, metallic: 0};

/** The pre-existing Cycles rig, expressed in the canonical scene coordinates. */
export function defaultLighting(scene: any): StudioLighting {
  const size = Math.max(...scene.product.dimensionsM);
  const scale = size / .12;
  const position = scene.placement.translationM as number[];
  const targetM = position.map((value, index) => value + (index === 1 ? size * .52 : 0));
  const presets = [
    {id: 'key', name: 'Key', offset: [-.19, .32, .24], power: 2.6, diameter: .23, color: [1, .93, .82]},
    {id: 'fill', name: 'Fill', offset: [.22, .19, .07], power: .8, diameter: .20, color: [.82, .91, 1]},
    {id: 'rim', name: 'Rim', offset: [.06, .30, -.19], power: 3.4, diameter: .16, color: [1, .98, .90]},
  ];
  return {ambientStrength: .45, lights: presets.map(preset => ({id: preset.id, name: preset.name, enabled: true,
    positionM: preset.offset.map((value, index) => position[index] + value * scale), targetM: [...targetM],
    powerW: preset.power * scale * scale, diameterM: preset.diameter * scale, color: [...preset.color]}))};
}

export function ensureLighting(scene: any): StudioLighting {
  if (!scene.lighting) scene.lighting = defaultLighting(scene);
  return scene.lighting;
}

export function colorHex(linear: number[]): string { return '#' + new Color().setRGB(linear[0], linear[1], linear[2]).getHexString(SRGBColorSpace); }
export function colorFromHex(hex: string): number[] { return new Color(hex).toArray(); }
export function worldYaw(asset: any): number { return new Euler().setFromQuaternion(new Quaternion().fromArray(asset.rotationXyzw), 'YXZ').y * 180 / Math.PI; }
export function setWorldYaw(asset: any, degrees: number): void {
  const delta = (degrees - worldYaw(asset)) * Math.PI / 180;
  const rotation = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), delta);
  asset.rotationXyzw = rotation.multiply(new Quaternion().fromArray(asset.rotationXyzw)).normalize().toArray();
}

export function addProp(scene: any, shape: 'box' | 'cylinder'): string {
  const ids = new Set([scene.environment.plinth.id, ...scene.product.components.map((part: any) => part.id), ...(scene.environment.props ?? []).map((prop: any) => prop.id)]);
  let number = 1; while (ids.has(`prop-${number}`)) number++;
  const id = `prop-${number}`;
  const extent = Math.max(...scene.product.dimensionsM);
  const side = extent * .35;
  const plinth = scene.environment.plinth;
  const top = plinth.translationM[1] + plinth.sizeM[1] / 2;
  (scene.environment.props ??= []).push({id, displayName: `${shape === 'box' ? 'Box' : 'Cylinder'} ${number}`, shape,
    sizeM: [side, side, side], translationM: [plinth.translationM[0] + extent * .65, top + side / 2, plinth.translationM[2]],
    rotationXyzw: [0, 0, 0, 1], material: structuredClone(PLINTH_MATERIAL), bevelM: Math.min(.002, side / 4)});
  return id;
}

export function resizeProp(prop: any, axis: number, value: number): void {
  prop.sizeM[axis] = Math.max(.001, value);
  if (prop.shape === 'cylinder' && axis !== 1) prop.sizeM[axis === 0 ? 2 : 0] = prop.sizeM[axis];
  if (prop.bevelM !== undefined) prop.bevelM = Math.min(prop.bevelM, ...prop.sizeM.map((size: number) => size / 2));
}

export function setPropShape(prop: any, shape: 'box' | 'cylinder'): void {
  prop.shape = shape;
  if (shape === 'cylinder') prop.sizeM[2] = prop.sizeM[0];
  resizeProp(prop, 1, prop.sizeM[1]);
}

/** Library GLBs retain their original UVs/materials; size is an explicit instance scale. */
export function addPropFromLibrary(scene: any, entry: any): string {
  const id = addProp(scene, 'box');
  const prop = scene.environment.props.find((item: any) => item.id === id);
  const dimensions = [...entry.sizeM];
  Object.assign(prop, { displayName: entry.name, shape: 'mesh',
    asset: { ...structuredClone(entry.asset), sourceDimensionsM: [...(entry.asset.sourceDimensionsM || dimensions)] },
    sizeM: dimensions, bevelM: 0, materialOverride: false,
    source: {provider: 'Poly Haven', assetId: entry.id, url: entry.sourceUrl, license: 'CC0'} });
  const plinth = scene.environment.plinth;
  prop.translationM = [plinth.translationM[0] + Math.max(...scene.product.dimensionsM) * .65 + dimensions[0] / 2,
    plinth.translationM[1] + plinth.sizeM[1] / 2 + dimensions[1] / 2, plinth.translationM[2]];
  return id;
}

export function setHdriFromLibrary(scene: any, entry: any): void {
  ensureLighting(scene).hdri = { asset: structuredClone(entry.asset), name: entry.name,
    sourceUrl: entry.sourceUrl, intensity: 1, rotationDeg: 0 };
}
