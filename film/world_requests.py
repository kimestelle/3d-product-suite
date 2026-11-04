"""Canonical World Labs generation identity shared by local and GitHub runners."""
from __future__ import annotations

import hashlib
import json

# Specific physical constraints make the generated room usable for a separately
# modelled product and moving camera. A custom user prompt is never rewritten.
PRODUCT_STUDIO_REQUIREMENTS = (
    "A continuous level floor meets coherent full-height walls with straight architectural edges. "
    "Keep an uncluttered central foreground and midground with a clear camera approach and lateral viewing space. "
    "Use believable real-world room scale, fine non-repeating material detail, and consistent window/light direction. "
    "Protect highlight detail and readable shadow texture; no baked dramatic spotlight on the empty product position. "
    "No product, pedestal, text, labels, people, mirrors, floating fragments, warped walls, or objects crossing the central display area. "
    "The product, its support and final studio lights will be added separately."
)
DEFAULT_PROMPT = (
    "An architectural botanical product studio: warm limestone walls and a matte lightly grained stone floor, "
    "with olive foliage grouped at the far edges and soft daylight from one broad side window. "
    + PRODUCT_STUDIO_REQUIREMENTS
)
DEFAULT_ENVIRONMENTS = {
    "botanical-studio": DEFAULT_PROMPT,
    "warm-gallery": (
        "A warm limestone gallery: honed stone walls, a subtly textured pale floor and distant shallow architectural recesses. "
        "Broad soft side-window light makes material texture readable without hard black shadows. " + PRODUCT_STUDIO_REQUIREMENTS
    ),
    "modern-loft": (
        "A modern loft: matte fine-grained concrete, restrained timber details, tall side windows and sparse distant greenery. "
        "Soft diffuse daylight gives coherent room depth and neutral material colour. " + PRODUCT_STUDIO_REQUIREMENTS
    ),
}


def identity_from_fingerprint(prompt_sha256, model, seed=42):
    document = {"schemaVersion": 1, "provider": "worldlabs", "model": model,
                "seed": seed, "promptSha256": prompt_sha256}
    return hashlib.sha256(json.dumps(document, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def generation_identity(*, prompt="", preset="botanical-studio", model="marble-1.1", image_url="",
                        image_sha256=None, seed=42):
    """Hash provider inputs only; callers must not persist the returned prompt."""
    effective_prompt = prompt.strip() or DEFAULT_ENVIRONMENTS[preset]
    fingerprint = hashlib.sha256(json.dumps({"prompt": effective_prompt,
        "image": image_sha256 or image_url.strip()}, sort_keys=True).encode()).hexdigest()
    return {"key": identity_from_fingerprint(fingerprint, model, seed), "promptSha256": fingerprint,
            "model": model, "seed": seed, "prompt": effective_prompt}
