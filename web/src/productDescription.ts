export const PRODUCT_DESCRIPTION = {
  title: 'An image-making studio for people who know their product.',
  paragraphs: [
    'For people who design and build physical products. You know the parts, materials, and details. Gesso helps you make stills and films—whether you’re launching without the time or budget for a studio production, or making new content every week.',
    'World models generate a 3D setting around your product, so you don’t have to model a whole room or regenerate a video for every change. Your product stays a separate, editable model: its shape, finishes, and artwork stay consistent while you adjust the setting, camera, and motion.',
  ],
};

export const PRODUCT_LAYERS = [
  {name: 'Product', text: 'Bring in a model. Organize its parts, assign materials, and place artwork.'},
  {name: 'Stage', text: 'Choose the setting, place props, and shape the light around the product.'},
  {name: 'Film', text: 'Frame a still or build a sequence. Set focus, animate the scene, and export.'},
];

export const PRODUCT_PROCESS_NOTE = 'Start anywhere. A polished still or film is always one step away; everything stays editable.';

export const PRODUCT_ENDNOTE = 'Set up the product once. Keep making with it.';

export type GalleryItem = {slug: string; product: string; world: string; credit: string};

/* Loops rendered by Gesso from the sample products in generated rooms. Media lives in public/media/gallery/<slug>.{mp4,jpg}. */
export const PRODUCT_GALLERY: GalleryItem[] = [
  {slug: 'omega-speedmaster', product: 'Chronograph (fan art)', world: 'Velvet jewel-box', credit: 'Model by ArakanI on Blendswap · CC0'},
  {slug: 'ambre-perfume', product: 'Ambre perfume bottle', world: 'Brutalist atrium', credit: 'Esteban Paris Ambre bottle via Blendswap'},
  {slug: 'sasha-ring', product: 'Sasha ring', world: 'Flooded marble hall', credit: 'Model by saber7711 on Blendswap · CC BY'},
  {slug: 'leica-camera', product: 'Rangefinder camera', world: 'Blue field', credit: 'Leica look-alike by Lamashtu on Blendswap · CC0'},
  {slug: 'theo-teapot', product: 'Theo teapot set', world: 'Orange field', credit: 'Stelton Theo teapot set via Blendswap · CC0'},
];

export const PRODUCT_GALLERY_NOTE = 'Five products from Blendswap, each in its own setting. The rooms were generated from inspiration photos with World Labs Marble and keep their geometry, so the product rests on, shadows and hides behind real surfaces; the colour fields are the studio itself. Every film is lit by an adjustable ambient wash and a spot that moves.';
