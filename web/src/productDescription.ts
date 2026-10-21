export const PRODUCT_DESCRIPTION = {
  title: 'An image-making studio for people who know their product.',
  paragraphs: [
    'For people who design and build physical products. You know the parts, materials, and details. Gesso helps you make stills and films—whether you’re launching without the time or budget for a studio production, or making new content every week.',
    'Bring the product, setting, camera, and motion into one editable scene. Start with a composed image, then adjust the material, placement, framing, and timing. Keep control of the decisions that change how your product appears.',
    'Return to the same product, parts, and finishes for another angle, setting, or sequence. Each image starts from work you’ve already done.',
  ],
};

export const PRODUCT_LAYERS = [
  {name: 'Product', text: 'Bring in a model. Find its parts, define its joints, and keep its dimensions intact.'},
  {name: 'Material', text: 'Assign finishes to parts. Adjust maps, place artwork, and save material presets.'},
  {name: 'World', text: 'Choose the setting, place props, and shape the light around the product.'},
  {name: 'Film', text: 'Frame a still or build a sequence. Set focus, animate the scene, and export.'},
];

export const PRODUCT_PROCESS_NOTE = 'Start anywhere. A polished still or film is always one step away; the decisions behind it stay editable.';

export const PRODUCT_ENDNOTE = 'Set up the product once. Keep making with it.';

export type GalleryItem = {slug: string; product: string; world: string; credit: string};

/* Loops rendered by Gesso from the sample products in generated rooms. Media lives in public/media/gallery/<slug>.{mp4,jpg}. */
export const PRODUCT_GALLERY: GalleryItem[] = [
  {slug: 'chronograph-watch', product: 'Chronograph watch', world: 'Velvet jewel-box', credit: 'Model © 2025 Darmstadt Graphics Group / Eric Chadwick · CC BY 4.0'},
  {slug: 'stained-glass-lamp', product: 'Stained glass lamp', world: 'Flooded marble hall', credit: 'Model © 2021 Wayfair LLC / Eric Chadwick · CC BY 4.0'},
  {slug: 'sunglasses', product: 'Sunglasses', world: 'Brutalist atrium', credit: 'Model © Khronos Group / Eric Chadwick · CC BY 4.0'},
  {slug: 'iridescence-lamp', product: 'Iridescence lamp', world: 'Flooded marble hall', credit: 'Model © 2022 Wayfair LLC / Eric Chadwick · CC BY 4.0'},
  {slug: 'candle-holder', product: 'Hurricane candle holder', world: 'Velvet jewel-box', credit: 'Model © 2023 Wayfair LLC / Eric Chadwick · CC BY 4.0'},
  {slug: 'barn-lamp', product: 'Barn lamp', world: 'Brutalist atrium', credit: 'Model © 2023 Wayfair LLC / Eric Chadwick · CC BY 4.0'},
];

export const PRODUCT_GALLERY_NOTE = 'Sample products from the Khronos glTF Sample Assets. Rooms were generated from inspiration photos with World Labs Marble and imported as meshes, so each product rests on, shadows and hides behind real geometry.';
