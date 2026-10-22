import {Color, Euler, Quaternion, SRGBColorSpace, Vector3} from 'three';

/** An absent type is the original area disk; spot fields exist only on spots. */
export type StudioLightType = 'area' | 'spot';
export type StudioLight = {id: string; name: string; enabled: boolean; positionM: number[]; targetM: number[]; powerW: number; diameterM: number; color: number[];
  type?: StudioLightType; coneDeg?: number; blend?: number};
export type HdriLighting = {asset: {path: string; sha256: string; format: 'hdr'}; name: string; sourceUrl: string; intensity: number; rotationDeg: number};
export type StudioLighting = {ambientStrength: number; lights: StudioLight[]; hdri?: HdriLighting; ambientColor?: number[]};
export const PLINTH_MATERIAL = {baseColor: [.56, .54, .49, 1], roughness: .58, metallic: 0};
export const SPOT_DEFAULTS = {coneDeg: 40, blend: .3};
export const LIGHT_TARGET_PREFIX = '$light:';
export const lightTarget = (id: string) => LIGHT_TARGET_PREFIX + id;
export const isLightTarget = (target: string) => target.startsWith(LIGHT_TARGET_PREFIX);
export const lightIdFromTarget = (target: string) => target.slice(LIGHT_TARGET_PREFIX.length);
export const lightType = (light: Pick<StudioLight, 'type'>): StudioLightType => light.type === 'spot' ? 'spot' : 'area';

/** A fixed studio stays on its support while the product's source anchor moves. */
function rigOrigin(scene: any): number[] {
  if (scene.environment.studioSizeM === undefined) return scene.placement.translationM;
  const plinth = scene.environment.plinth;
  return plinth.translationM.map((value: number, axis: number) => value + (axis === 1 ? plinth.sizeM[1] / 2 : 0));
}

/** The pre-existing Cycles rig, expressed in the canonical scene coordinates. */
export function defaultLighting(scene: any): StudioLighting {
  const size = scene.environment.studioSizeM ?? Math.max(...scene.product.dimensionsM);
  const scale = size / .12;
  const position = rigOrigin(scene);
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

/** Rig-relative placement shared by new lights and the dramatic preset. */
function rigFrame(scene: any) {
  const size = scene.environment.studioSizeM ?? Math.max(...scene.product.dimensionsM);
  const position = rigOrigin(scene);
  return {size, scale: size / .12, position, targetM: position.map((value, index) => value + (index === 1 ? size * .45 : 0))};
}

/** A hard, warm spot above and in front of the product; the emitter is small so the contact shadow stays crisp. */
export function dramaticSpot(scene: any, id = 'spot'): StudioLight {
  const {scale, position, targetM} = rigFrame(scene);
  return {id, name: 'Spot', type: 'spot', enabled: true, coneDeg: 35, blend: .4,
    positionM: [-.10, .42, .28].map((value, index) => position[index] + value * scale), targetM,
    powerW: Number((14 * scale * scale).toPrecision(6)), diameterM: .05 * scale, color: [1, .86, .70]};
}

export function addLight(scene: any, type: StudioLightType): string {
  const lighting = ensureLighting(scene);
  if (lighting.lights.length >= 8) throw new Error('A rig holds at most eight lights.');
  const ids = new Set(lighting.lights.map(light => light.id));
  let number = 1; while (ids.has(`${type}-${number}`)) number++;
  const id = `${type}-${number}`;
  const names = new Set(lighting.lights.map(light => light.name));
  let name = type === 'spot' ? 'Spot' : 'Area'; let suffix = 2;
  while (names.has(name)) name = `${type === 'spot' ? 'Spot' : 'Area'} ${suffix++}`;
  const light = dramaticSpot(scene, id);
  light.name = name;
  if (type === 'area') {
    const {scale} = rigFrame(scene);
    delete light.type; delete light.coneDeg; delete light.blend;
    light.powerW = Number((2.6 * scale * scale).toPrecision(6)); light.diameterM = .23 * scale; light.color = [1, .93, .82];
  }
  lighting.lights.push(light);
  return id;
}

export function removeLight(scene: any, id: string): void {
  const lighting = ensureLighting(scene);
  if (lighting.lights.length <= 1 && !lighting.hdri) throw new Error('Keep at least one light or an HDRI.');
  lighting.lights = lighting.lights.filter(light => light.id !== id);
}

export function setLightType(light: StudioLight, type: StudioLightType): void {
  if (type === 'spot') {
    light.type = 'spot';
    light.coneDeg ??= SPOT_DEFAULTS.coneDeg; light.blend ??= SPOT_DEFAULTS.blend;
  } else {
    delete light.type; delete light.coneDeg; delete light.blend;
  }
}

/** One-click luxury-launch look: low warm ambient and a single hard spot sweeping the product. */
export function applyDramaticSpot(scene: any): void {
  const hdri = scene.lighting?.hdri;
  scene.lighting = {ambientStrength: .15, ambientColor: [.24, .18, .16], lights: [dramaticSpot(scene)]};
  if (hdri) scene.lighting.hdri = hdri;
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
  const extent = scene.environment.studioSizeM ?? Math.max(...scene.product.dimensionsM);
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
  const extent = scene.environment.studioSizeM ?? Math.max(...scene.product.dimensionsM);
  prop.translationM = [plinth.translationM[0] + extent * .65 + dimensions[0] / 2,
    plinth.translationM[1] + plinth.sizeM[1] / 2 + dimensions[1] / 2, plinth.translationM[2]];
  return id;
}

export function setHdriFromLibrary(scene: any, entry: any): void {
  ensureLighting(scene).hdri = { asset: structuredClone(entry.asset), name: entry.name,
    sourceUrl: entry.sourceUrl, intensity: 1, rotationDeg: 0 };
}
