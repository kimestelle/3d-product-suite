import {useLayoutEffect, useRef, useState} from 'react';
import './product-fit.css';

export type ProductFitRect = {left: number; right: number; top: number; bottom: number};

/** World view uses vertical camera FOV; match the saved output gate without
 * making a second ruler or changing the camera when the sidebar resizes. */
export default function ProductFitGuide({rect, aspect}: {rect: ProductFitRect; aspect: number}) {
  const host = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({width: 0, height: 0});
  useLayoutEffect(() => {
    const element = host.current;
    if (!element) return;
    const measure = () => setSize({width: element.clientWidth, height: element.clientHeight});
    const observer = new ResizeObserver(measure); observer.observe(element); measure();
    return () => observer.disconnect();
  }, []);
  const unit = size.height / 2;
  return <div className="product-fit-guide" ref={host} aria-hidden="true">
    {size.height > 0 && <div className="product-fit-guide-box" style={{
      left: size.width / 2 + rect.left * unit * aspect,
      top: (1 - rect.top) * unit,
      width: (rect.right - rect.left) * unit * aspect,
      height: (rect.top - rect.bottom) * unit,
    }}><span>product fit</span></div>}
  </div>;
}
