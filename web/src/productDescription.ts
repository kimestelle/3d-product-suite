export const PRODUCT_DESCRIPTION = {
  title: 'An image‑making studio for people who know their product.',
  paragraphs: [
    'Bring in your product model and build a scene around it. Choose the setting, adjust the materials, and frame the shot.',
    'When the label changes or you want another finish, reopen the scene and work from the setup you already made.',
  ],
};

export const PRODUCT_LAYERS = [
  {name: 'Product', text: 'Organize the model’s parts, assign materials, and place artwork.'},
  {name: 'Stage', text: 'Choose the setting, place props, and shape the light around the product.'},
  {name: 'Film', text: 'Frame a still or arrange camera moves into a film, then render the output.'},
];

export const PRODUCT_PROCESS_NOTE = 'The product, setting, and camera remain editable after a render.';

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

export const PRODUCT_GALLERY_NOTE = 'World Labs Marble generated the rooms from reference photographs. The camera and teapot use flat studio fields. Each scene keeps the product model separate from its setting.';
