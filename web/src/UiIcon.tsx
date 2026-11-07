import {
  Box, Camera, Check, ChevronDown, ChevronRight, Circle, CircleSlash, Clapperboard,
  Clock, Component, Dice5, Download, Eye, EyeOff, Film, Globe, History, Lightbulb,
  LoaderCircle, LockKeyhole, Minus, Move3D, Option, Orbit, PaintBucket, Pause, Play,
  Plus, Redo2, Rotate3D, Scale3D, Scan, SkipBack, SkipForward, TriangleAlert, Undo2,
  type LucideIcon,
} from 'lucide-react';
import {UI_ICON_CATALOG, UI_ICON_STROKE, type UiIconName} from './uiIconCatalog';

const icons = {
  product:Box, part:Component, stage:Globe, camera:Camera, light:Lightbulb,
  material:PaintBucket, scene:Clapperboard, film:Film,
  move:Move3D, rotate:Rotate3D, scale:Scale3D, fitFrame:Scan, inspect:Orbit,
  play:Play, pause:Pause, skipBack:SkipBack, skipForward:SkipForward,
  undo:Undo2, redo:Redo2, history:History, dice:Dice5, download:Download,
  plus:Plus, minus:Minus, check:Check, eye:Eye, eyeoff:EyeOff, lock:LockKeyhole,
  alert:TriangleAlert, unavailable:CircleSlash, loader:LoaderCircle, clock:Clock,
  circle:Circle, chevron:ChevronRight, down:ChevronDown, option:Option,
} satisfies Record<UiIconName, LucideIcon>;
const sizes = Object.fromEntries(UI_ICON_CATALOG.map(icon => [icon.name, icon.size])) as Record<UiIconName, number>;

/** The owner supplies its accessible name and state; the icon inherits its ink.
 * Fixed screen-space strokes keep dense controls as legible as larger actions. */
export function UiIcon({name, size, className = ''}: {name: UiIconName; size?: number; className?: string}) {
  const Icon = icons[name];
  const dimension = size !== undefined && Number.isFinite(size) && size > 0 ? size : sizes[name];
  return <Icon aria-hidden="true" focusable="false" className={`gesso-ui-icon ${className}`.trim()}
    size={dimension} strokeWidth={UI_ICON_STROKE} nonScalingStroke
    style={{width:dimension, height:dimension}}/>;
}
