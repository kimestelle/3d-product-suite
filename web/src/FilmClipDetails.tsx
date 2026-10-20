import {NumberControl} from './EditorControls';
import {exactShotAtFrame, setShotFrames, shotFrames} from './sequence';
import {useFilmEdits} from './FilmWorkspaceShared';
import type {FilmWorkspaceProps} from './FilmWorkspace';
import {sceneAssetUrl} from './sceneObjects';

export function FilmClipDetails(props: FilmWorkspaceProps & {side: 'objects' | 'inspector'; onImportImage: () => void; importingImage: boolean}) {
  const shot = exactShotAtFrame(props.scene, props.editingFrame ?? props.frame), fps = props.scene.render.fps;
  const {edit, error} = useFilmEdits(props);
  if (!shot) return null;
  if (shot.kind !== 'image' || !shot.image) return null;
  const image = shot.image;
  if (props.side === 'objects') return <div className="gesso-panel film-clip-details">
    <img className="film-image-preview" src={sceneAssetUrl(image.asset)} alt={shot.name}/>
    <span className="film-hint">{image.asset.width} × {image.asset.height} px · Image</span>
  </div>;
  const timing = (mutate: (draft: any) => void) => {const result = edit(mutate); if (result) props.onFrame(result.draft.shots.find((item: any) => item.id === shot.id).startFrame);};
  return <div className="gesso-panel film-clip-details film-rail-panel">
    <h2>Image</h2>
    <div className="film-rail-scroll">
    <NumberControl label="Duration" ariaLabel="Image duration in seconds" value={shotFrames(shot) / fps} min={1 / fps} step={1 / fps} unit="s" disabled={props.disabled} onChange={value => timing(draft => setShotFrames(draft, shot.id, Math.max(1, Math.round(value * fps))))}/>
    <label className="gesso-field gesso-inline-field"><span>Fit</span><select aria-label="Image fit" value={image.fit} disabled={props.disabled} onChange={event => edit(draft => {draft.shots.find((item: any) => item.id === shot.id).image.fit = event.target.value;})}><option value="contain">Fit image</option><option value="cover">Fill frame</option></select></label>
    <p className="film-hint">{image.fit === 'cover' ? 'Fills the output frame. Edges may be cropped.' : 'Keeps the full image. Empty edges are black.'}</p>
    {error && <p className="film-error" role="alert">{error}</p>}
    </div>
  </div>;
}
